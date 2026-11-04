import { AbortError } from "../error/abort";
import { attach, create, Flag } from "../error/flags";
import type { Api, AssistantMessage, FetchImpl, Model, StreamOptions } from "../types";

/** A host admission hook refused an inference attempt; never retry this request. */
export class ProviderRequestDeniedError extends AbortError {
	readonly code = "PROVIDER_REQUEST_DENIED";

	constructor(cause: unknown) {
		super("Provider request denied by admission hook", { cause });
		this.name = "ProviderRequestDeniedError";
		attach(this, create(Flag.Abort, Flag.ProviderRequestDenied));
	}
}

/** Preserve admission's terminal identity after a provider replaces cancellation diagnostics. */
export function withProviderRequestError(message: AssistantMessage, signal: AbortSignal | undefined): AssistantMessage {
	const denied = signal?.reason;
	if (!(denied instanceof ProviderRequestDeniedError)) return message;
	return {
		...message,
		stopReason: "aborted",
		errorId: create(Flag.Abort, Flag.ProviderRequestDenied),
		errorStatus: undefined,
		errorMessage: denied.message,
	};
}

const GUARDED_REQUEST = Symbol("omp.providerRequestGate");
type RequestGateOptions = Pick<StreamOptions, "signal" | "beforeProviderRequest">;
type GuardedOptions = RequestGateOptions & { [GUARDED_REQUEST]?: true };

/** Share one cancellation/latch across all retries and credential fallbacks of a request. */
export function withProviderRequestGate<T extends RequestGateOptions>(options: T): T {
	if (!options.beforeProviderRequest || (options as GuardedOptions)[GUARDED_REQUEST]) return options;
	const controller = new AbortController();
	const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
	const hook = options.beforeProviderRequest;
	let denied: ProviderRequestDeniedError | undefined;
	return {
		...options,
		[GUARDED_REQUEST]: true,
		signal,
		beforeProviderRequest: async (model: Model<Api>) => {
			if (denied) throw denied;
			signal.throwIfAborted();
			try {
				await hook(model, signal);
				signal.throwIfAborted();
			} catch (cause) {
				if (options.signal?.aborted) throw cause;
				denied = cause instanceof ProviderRequestDeniedError ? cause : new ProviderRequestDeniedError(cause);
				controller.abort(denied);
				throw denied;
			}
		},
	};
}

/** Invoke only immediately before an inference dispatch, never discovery or authentication. */
export async function admitProviderRequest(model: Model<Api>, options: RequestGateOptions | undefined): Promise<void> {
	options?.signal?.throwIfAborted();
	await options?.beforeProviderRequest?.(model, options.signal);
	options?.signal?.throwIfAborted();
}

/** Place inside retry/compression/failover wrappers so every HTTP send is admitted separately. */
export function providerRequestFetch(
	model: Model<Api>,
	options: (RequestGateOptions & Pick<StreamOptions, "fetch">) | undefined,
	fetchImpl: FetchImpl = options?.fetch ?? globalThis.fetch,
): FetchImpl {
	if (!options?.beforeProviderRequest) return fetchImpl;
	const guarded = withProviderRequestGate(options);
	const guardedFetch: FetchImpl = async (input, init) => {
		init?.signal?.throwIfAborted();
		await admitProviderRequest(model, guarded);
		init?.signal?.throwIfAborted();
		return fetchImpl(input, init);
	};
	if (fetchImpl.preconnect) guardedFetch.preconnect = fetchImpl.preconnect;
	return guardedFetch;
}
