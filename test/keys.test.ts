import { describe, expect, test } from "bun:test";
import { decodeKey } from "../extension/after-goal/keys.ts";

describe("decodeKey", () => {
	test("passes printable characters through", () => {
		expect(decodeKey("&")).toBe("&");
		expect(decodeKey("|")).toBe("|");
	});

	test("reads kitty's shifted-key report as the produced character", () => {
		// Shift+7 and Shift+backslash report the alternate key, base, and repeat fields too.
		expect(decodeKey("\x1b[55:38;2u")).toBe("&");
		expect(decodeKey("\x1b[92:124;2u")).toBe("|");
		expect(decodeKey("\x1b[55:38:55;2u")).toBe("&");
		expect(decodeKey("\x1b[55:38;2:2u")).toBe("&");
	});

	test("ignores keys held with ctrl and reads plain kitty letters", () => {
		expect(decodeKey("\x1b[55:38;6u")).toBeUndefined();
		expect(decodeKey("\x1b[107;2u")).toBe("K");
	});

	test("reads xterm modifyOtherKeys", () => {
		expect(decodeKey("\x1b[27;2;38~")).toBe("&");
	});

	test("maps legacy navigation and edit keys", () => {
		expect(decodeKey("\x1b[A")).toBe("up");
		expect(decodeKey("\x1b[B")).toBe("down");
		expect(decodeKey("\r")).toBe("enter");
		expect(decodeKey("\x1b")).toBe("escape");
		expect(decodeKey("\x7f")).toBe("backspace");
	});
});
