import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import type { ExtensionAskDialogQuestion } from "../extensibility/extensions/types";
import { BotError, type BotInputRequest } from "./types";

export interface BotQuestionField {
	id: string;
	label: string;
	mode: "text" | "single" | "multi";
	required: boolean;
	allow_custom: boolean;
	options: Array<{ value: string; label: string; description: string | null }>;
}
export interface BotQuestionDetail {
	schema_version: 1;
	input_request_id: string;
	title: string;
	body: string;
	kind: BotInputRequest["kind"];
	reply_encoding: "text" | "question_map";
	fields: BotQuestionField[];
}

/** Normalize actual runtime choices once; refs never invent approval grants. */
export function describeBotQuestion(question: BotInputRequest): BotQuestionDetail {
	const prompt = isRecord(question.prompt) ? question.prompt : {};
	let fields: BotQuestionField[];
	if (question.kind === "approval") {
		const options: BotQuestionField["options"] = [
			{ value: "once", label: "Approve once", description: null },
			{ value: "deny", label: "Deny", description: null },
		];
		if (typeof prompt.session === "string")
			options.push({ value: "session", label: prompt.session, description: null });
		if (Array.isArray(prompt.grants))
			for (const grant of prompt.grants) {
				if (!isRecord(grant) || (grant.scope !== "folder" && grant.scope !== "target")) continue;
				for (const label of [grant.label, grant.alwaysLabel])
					if (typeof label === "string") options.push({ value: label, label, description: null });
			}
		fields = [{ id: "answer", label: "Approval", mode: "single", required: true, allow_custom: false, options }];
	} else if (Array.isArray(prompt.questions)) {
		fields = (prompt.questions as ExtensionAskDialogQuestion[]).map(item => ({
			id: item.id,
			label: item.question,
			mode: item.multi ? "multi" : "single",
			required: true,
			allow_custom: true,
			options: item.options.map(option => ({
				value: option.label,
				label: option.label,
				description: option.description ?? null,
			})),
		}));
	} else {
		const options: BotQuestionField["options"] = [];
		if (Array.isArray(prompt.options))
			for (const option of prompt.options) {
				const label = typeof option === "string" ? option : isRecord(option) ? option.label : undefined;
				if (typeof label === "string")
					options.push({
						value: label,
						label,
						description: isRecord(option) && typeof option.description === "string" ? option.description : null,
					});
			}
		fields = [
			{
				id: "answer",
				label: typeof prompt.title === "string" ? prompt.title : "Answer",
				mode: options.length ? "single" : "text",
				required: true,
				allow_custom: options.length === 0,
				options,
			},
		];
	}
	return {
		schema_version: 1,
		input_request_id: question.input_request_id,
		title: typeof prompt.title === "string" ? prompt.title : "",
		body: typeof prompt.message === "string" ? prompt.message : typeof prompt.full === "string" ? prompt.full : "",
		kind: question.kind,
		reply_encoding: Array.isArray(prompt.questions) ? "question_map" : "text",
		fields,
	};
}

/** Validate before durable question reservation and again before runtime resolution. */
export function normalizeBotReply(question: BotInputRequest, input: unknown): unknown {
	const request = isRecord(question.prompt) ? question.prompt : undefined;
	if (typeof input === "string" && !input.trim())
		throw new BotError("invalid_input", "Required Bot reply cannot be empty");
	if (question.kind === "approval") {
		if (input === true) return "once";
		if (input === false) return "deny";
		const answer = typeof input === "string" ? input.trim().toLowerCase() : undefined;
		if (answer && ["yes", "y", "true", "approve", "approved", "once"].includes(answer)) return "once";
		if (answer && ["no", "n", "false", "deny", "reject", "rejected"].includes(answer)) return "deny";
		if (
			answer &&
			typeof request?.session === "string" &&
			(answer === "session" || answer === request.session.trim().toLowerCase())
		)
			return "session";
		if (answer && Array.isArray(request?.grants)) {
			for (const rawGrant of request.grants) {
				const grant = isRecord(rawGrant) ? rawGrant : undefined;
				if (
					(grant?.scope !== "folder" && grant?.scope !== "target") ||
					typeof grant.label !== "string" ||
					typeof grant.alwaysLabel !== "string"
				)
					continue;
				if (answer === grant.label.trim().toLowerCase()) return { grant: grant.scope, always: false };
				if (answer === grant.alwaysLabel.trim().toLowerCase()) return { grant: grant.scope, always: true };
			}
		}
		const grantAnswer = isRecord(input) ? input : undefined;
		if (
			grantAnswer &&
			typeof grantAnswer.always === "boolean" &&
			Array.isArray(request?.grants) &&
			request.grants.some(grant => isRecord(grant) && grant.scope === grantAnswer.grant)
		)
			return { grant: grantAnswer.grant, always: grantAnswer.always };
		throw new BotError("invalid_input", "Approval reply must select an offered approval or denial");
	}
	if (Array.isArray(request?.questions)) {
		const questions = request.questions as ExtensionAskDialogQuestion[];
		let answer = input;
		if (typeof input === "string" && /^\s*[{[]/.test(input)) {
			try {
				answer = JSON.parse(input);
			} catch {
				if (questions.length > 1)
					throw new BotError("invalid_input", "Reply must be a JSON object keyed by question ID");
			}
		}
		const answers = isRecord(answer) ? answer : undefined;
		if (answers) {
			const ids = new Set(questions.map(item => item.id));
			if (Object.keys(answers).some(id => !ids.has(id)) || questions.some(item => !Object.hasOwn(answers, item.id)))
				throw new BotError("invalid_input", "Reply must answer every question ID and contain no unknown IDs");
			for (const item of questions) {
				const value = answers[item.id];
				if (!item.multi && typeof value === "string" && value.trim()) continue;
				if (item.multi && Array.isArray(value) && value.every(entry => typeof entry === "string" && entry.trim()))
					continue;
				throw new BotError(
					"invalid_input",
					"Question answers must be strings, or arrays of strings for multi-select questions",
				);
			}
			return answers;
		}
		if (questions.length > 1) throw new BotError("invalid_input", "Reply must be a JSON object keyed by question ID");
		if (
			(typeof answer === "string" && answer.trim()) ||
			(questions[0]?.multi &&
				Array.isArray(answer) &&
				answer.every(entry => typeof entry === "string" && entry.trim()))
		)
			return answer;
		throw new BotError("invalid_input", "Question reply must be text or a valid question-ID object");
	}
	if (typeof input !== "string") throw new BotError("invalid_input", "Text reply must be a string");
	if (Array.isArray(request?.options)) {
		const labels = request.options.map(option =>
			typeof option === "string" ? option : isRecord(option) ? option.label : undefined,
		);
		if (!labels.includes(input)) throw new BotError("invalid_input", "Reply does not match a configured selection");
	}
	return input;
}
