import { describe, expect, test } from "bun:test";
import { formatClock, formatDuration, parseWhen } from "../extension/after-goal/time.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Fixed reference instant: 2026-01-15 22:00 local time. */
function fixedNow(h = 22, m = 0, day = 15): Date {
	return new Date(2026, 0, day, h, m, 0, 0);
}

describe("formatDuration", () => {
	test("under a minute reads 0분", () => {
		expect(formatDuration(59)).toBe("0분");
	});

	test("whole hours drop the minutes", () => {
		expect(formatDuration(3600)).toBe("1시간");
	});

	test("mixed hours and minutes keep both", () => {
		expect(formatDuration(5400)).toBe("1시간 30분");
	});

	test("plain minutes", () => {
		expect(formatDuration(600)).toBe("10분");
	});
});

describe("formatClock", () => {
	test("same day as now reads HH:MM", () => {
		const now = fixedNow(10, 0);
		expect(formatClock(new Date(2026, 0, 15, 23, 5).getTime(), now)).toBe("23:05");
	});

	test("another day reads M/D HH:MM", () => {
		const now = fixedNow(10, 0);
		expect(formatClock(new Date(2026, 0, 16, 3, 5).getTime(), now)).toBe("1/16 03:05");
	});
});

describe("parseWhen", () => {
	test("empty input means no time", () => {
		expect(parseWhen("", fixedNow())).toBeUndefined();
	});

	test("relative durations resolve against now", () => {
		const now = fixedNow();
		expect(parseWhen("90m", now)).toBe(now.getTime() + 90 * MINUTE);
		expect(parseWhen("2h", now)).toBe(now.getTime() + 2 * HOUR);
		expect(parseWhen("1h30m", now)).toBe(now.getTime() + 90 * MINUTE);
		expect(parseWhen("2시간", now)).toBe(now.getTime() + 2 * HOUR);
		expect(parseWhen("1시간 30분", now)).toBe(now.getTime() + 90 * MINUTE);
	});

	test("a clock time later today stays on the same day", () => {
		const now = fixedNow(22, 0);
		expect(parseWhen("23:30", now)).toBe(new Date(2026, 0, 15, 23, 30, 0, 0).getTime());
	});

	test("a clock time already past rolls to tomorrow", () => {
		const now = fixedNow(23, 45);
		expect(parseWhen("23:30", now)).toBe(new Date(2026, 0, 16, 23, 30, 0, 0).getTime());
	});

	test("impossible or unreadable input is null", () => {
		const now = fixedNow();
		expect(parseWhen("24:00", now)).toBeNull();
		expect(parseWhen("12:60", now)).toBeNull();
		expect(parseWhen("abc", now)).toBeNull();
		expect(parseWhen("0m", now)).toBeNull();
	});
});
