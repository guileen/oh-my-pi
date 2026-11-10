function validateDecimalAmount(value: string): void {
	if (!/^\d+(?:\.\d+)?$/.test(value)) {
		throw new Error("Expected a nonnegative decimal amount string");
	}
}

function alignDecimalAmounts(left: string, right: string): [bigint, bigint, number] {
	validateDecimalAmount(left);
	validateDecimalAmount(right);
	const [leftWhole, leftFraction = ""] = left.split(".");
	const [rightWhole, rightFraction = ""] = right.split(".");
	const scale = Math.max(leftFraction.length, rightFraction.length);
	return [
		BigInt(leftWhole + leftFraction.padEnd(scale, "0")),
		BigInt(rightWhole + rightFraction.padEnd(scale, "0")),
		scale,
	];
}

/**
 * Add observed decimal costs exactly, without converting amounts to floating point.
 * Null means unknown: retain a known subtotal, or null if neither cost is known.
 * The returned subtotal alone does not assert that usage accounting is complete.
 * Non-null inputs must be unsigned plain decimals (digits with an optional fraction).
 * Sums of two known costs are normalized; a sole known input is preserved verbatim.
 */
export function addDecimalCost(left: string | null, right: string | null): string | null {
	if (right === null) {
		if (left !== null) validateDecimalAmount(left);
		return left;
	}
	if (left === null) {
		validateDecimalAmount(right);
		return right;
	}
	const [leftAmount, rightAmount, scale] = alignDecimalAmounts(left, right);
	const total = leftAmount + rightAmount;
	if (scale === 0) return String(total);
	const digits = String(total).padStart(scale + 1, "0");
	return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/\.?0+$/, "");
}

/** Compare nonnegative plain decimal strings exactly, ignoring scale and leading zeros. */
export function compareDecimalAmounts(left: string, right: string): -1 | 0 | 1 {
	const [leftAmount, rightAmount] = alignDecimalAmounts(left, right);
	return leftAmount < rightAmount ? -1 : leftAmount > rightAmount ? 1 : 0;
}
