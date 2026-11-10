/** Deterministic JSON serialization with sorted record keys and strict JSON values. */
export function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
	if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("Non-finite numbers are not JSON values");
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		if (ancestors.has(value)) throw new Error("Circular values are not JSON values");
		ancestors.add(value);
		try {
			const entries: string[] = [];
			for (let index = 0; index < value.length; index++) {
				if (!(index in value)) throw new Error("Sparse arrays are not JSON values");
				entries.push(canonicalJson(value[index], ancestors));
			}
			return `[${entries.join(",")}]`;
		} finally {
			ancestors.delete(value);
		}
	}
	if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== Object.prototype)
		throw new Error("Non-JSON value");
	if (ancestors.has(value)) throw new Error("Circular values are not JSON values");
	ancestors.add(value);
	try {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key], ancestors)}`)
			.join(",")}}`;
	} finally {
		ancestors.delete(value);
	}
}
