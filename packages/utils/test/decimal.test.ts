import { describe, expect, it } from "bun:test";
import { addDecimalCost, compareDecimalAmounts } from "@oh-my-pi/pi-utils";

describe("addDecimalCost", () => {
	it("aligns fractional scales without floating-point rounding", () => {
		expect(addDecimalCost("0.1", "0.02")).toBe("0.12");
		expect(addDecimalCost("1.2", "0.0034")).toBe("1.2034");
		expect(addDecimalCost("0.0001", "2")).toBe("2.0001");
		expect(addDecimalCost("2", "0.0001")).toBe("2.0001");
	});

	it("preserves large integer and fractional precision across carries", () => {
		expect(addDecimalCost("999999999999999999999999999999.999999999999999999", "0.000000000000000001")).toBe(
			"1000000000000000000000000000000",
		);
		expect(addDecimalCost("9007199254740993.000000000000000001", "0.000000000000000009")).toBe(
			"9007199254740993.00000000000000001",
		);
		expect(addDecimalCost("9007199254740993", "2")).toBe("9007199254740995");
	});

	it("normalizes zero and insignificant zeros without removing integer zeros", () => {
		expect(addDecimalCost("0000.000", "0")).toBe("0");
		expect(addDecimalCost("0", "0")).toBe("0");
		expect(addDecimalCost("00100.2300", "000.7700")).toBe("101");
		expect(addDecimalCost("100.00", "0.00")).toBe("100");
		expect(addDecimalCost("100", "200")).toBe("300");
		expect(addDecimalCost("1.2300", "0.000")).toBe("1.23");
	});

	it("retains nullable known subtotals without treating unknown costs as measured zero", () => {
		expect(addDecimalCost(null, null)).toBeNull();
		expect(addDecimalCost(null, "001.2300")).toBe("001.2300");
		expect(addDecimalCost("001.2300", null)).toBe("001.2300");
		expect(addDecimalCost(null, "0")).toBe("0");
		expect(addDecimalCost("0", null)).toBe("0");
	});
});

describe("compareDecimalAmounts", () => {
	it("compares equal amounts across fractional scales and leading zeros", () => {
		expect(compareDecimalAmounts("001.2300", "1.23")).toBe(0);
		expect(compareDecimalAmounts("0.0000", "000")).toBe(0);
		expect(compareDecimalAmounts("100", "100.000")).toBe(0);
	});

	it("orders fractional amounts exactly in both directions", () => {
		expect(compareDecimalAmounts("0.1", "0.02")).toBe(1);
		expect(compareDecimalAmounts("0.02", "0.1")).toBe(-1);
		expect(compareDecimalAmounts("1.000000000000000001", "1")).toBe(1);
		expect(compareDecimalAmounts("1", "1.000000000000000001")).toBe(-1);
		expect(compareDecimalAmounts("0", "0.000000000000000001")).toBe(-1);
	});

	it("orders integer and fractional differences beyond floating-point precision", () => {
		expect(compareDecimalAmounts("9007199254740993", "9007199254740992")).toBe(1);
		expect(compareDecimalAmounts("999999999999999999999999999999", "1000000000000000000000000000000")).toBe(-1);
		expect(compareDecimalAmounts("9007199254740993.000000000000000001", "9007199254740993.000000000000000002")).toBe(
			-1,
		);
	});
});

describe("decimal amount validation", () => {
	const invalidAmounts = [
		"",
		".",
		".1",
		"1.",
		"+1",
		"-0",
		"-1",
		"1e3",
		"1E-2",
		"Infinity",
		"NaN",
		" 1",
		"1 ",
		"1\n",
		"1\t",
		"0x10",
		"1_000",
		"1..0",
		"1.2.3",
		"１２",
	];

	for (const amount of invalidAmounts) {
		it(`rejects ${JSON.stringify(amount)} in either operand, including nullable sums`, () => {
			expect(() => addDecimalCost(amount, "0")).toThrow("nonnegative decimal amount");
			expect(() => addDecimalCost("0", amount)).toThrow("nonnegative decimal amount");
			expect(() => addDecimalCost(amount, null)).toThrow("nonnegative decimal amount");
			expect(() => addDecimalCost(null, amount)).toThrow("nonnegative decimal amount");
			expect(() => compareDecimalAmounts(amount, "0")).toThrow("nonnegative decimal amount");
			expect(() => compareDecimalAmounts("0", amount)).toThrow("nonnegative decimal amount");
		});
	}
});
