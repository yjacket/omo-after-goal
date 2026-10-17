import { describe, expect, test } from "bun:test";
import { statusText } from "../extension/after-goal/status.ts";
import { displayWidth } from "../extension/after-goal/text.ts";
import {
	plainPaint,
	type GoalCond,
	type Job,
	type Paint,
	type SessionSnapshot,
} from "../extension/after-goal/types.ts";

const NOW = new Date(2026, 0, 1, 12, 0);
const AT = new Date(2026, 0, 1, 23, 30).getTime();

function cond(sessionId: string, label: string, endedAt?: number): GoalCond {
	return {
		sessionId,
		goalId: `${sessionId}-goal`,
		goalFile: `/goals/${sessionId}.json`,
		label,
		...(endedAt !== undefined ? { endedAt, endReason: "done" } : {}),
	};
}

function job(groups: GoalCond[][], at?: number): Job {
	return { id: "j1", createdAt: 0, prompt: "wake me", groups, ...(at !== undefined ? { at } : {}) };
}

function snaps(...entries: [string, SessionSnapshot][]): ReadonlyMap<string, SessionSnapshot> {
	return new Map(entries);
}

const tagging: Paint = {
	ok: (text) => `<ok>${text}</ok>`,
	warn: (text) => `<warn>${text}</warn>`,
	dim: (text) => `<dim>${text}</dim>`,
};

describe("statusText", () => {
	test("names each awaited session with its open todos and the time", () => {
		const j = job([[cond("s1", "omo-health"), cond("s2", "omo-desk")]], AT);
		const text = statusText(j, snaps(["s1", { alive: true, todo: { total: 6, open: 4 } }], ["s2", { alive: true, todo: { total: 2, open: 2 } }]), { paint: plainPaint, now: NOW });
		expect(text).toBe("⏰ omo-health 남은 4 & omo-desk 남은 2 | 23:30");
	});

	test("an ended goal reads ✓", () => {
		const j = job([[cond("s1", "omo-health", 1000)]]);
		const text = statusText(j, snaps(["s1", { alive: true, todo: { total: 3, open: 1 } }]));
		expect(text).toBe("⏰ omo-health ✓");
	});

	test("a session that went away reads 꺼짐", () => {
		const j = job([[cond("s1", "omo-health")]]);
		const text = statusText(j, snaps(["s1", { alive: false }]));
		expect(text).toBe("⏰ omo-health 꺼짐");
	});

	test("an ended goal beats a dead session", () => {
		const j = job([[cond("s1", "omo-health", 1000)]]);
		const text = statusText(j, snaps(["s1", { alive: false }]));
		expect(text).toBe("⏰ omo-health ✓");
	});

	test("a session without a todo reads as its label only", () => {
		const j = job([[cond("s1", "omo-health")]]);
		const text = statusText(j, snaps(["s1", { alive: true }]));
		expect(text).toBe("⏰ omo-health");
	});

	test("a time-only reservation reads as the time", () => {
		const j = job([], AT);
		expect(statusText(j, snaps(), { now: NOW })).toBe("⏰ 23:30");
	});

	test("a fired job reads as waiting to run", () => {
		const j = { ...job([[cond("s1", "omo-health")]], AT), fired: { reason: "all ended", at: 5 } };
		expect(statusText(j, snaps())).toBe("⏰ 실행 대기");
	});

	test("no job reads as nothing at all", () => {
		expect(statusText(null, snaps())).toBeUndefined();
	});

	test("a long label is cut to 14 cells ending with …", () => {
		const j = job([[cond("s1", "abcdefghijklmnopqrst")]]);
		const text = statusText(j, snaps(["s1", { alive: true }]));
		expect(text).toBe("⏰ abcdefghijklm…");
		expect(displayWidth((text ?? "").slice("⏰ ".length))).toBe(14);
	});

	test("a three-group job stays within 48 cells and keeps the full time and every count", () => {
		const j = job(
			[
				[cond("s1", "alpha-project-longname")],
				[cond("s3", "gamma-project-longname")],
				[cond("s5", "epsilon-project-longname")],
			],
			AT,
		);
		const entries = ["s1", "s3", "s5"].map(
			(id) => [id, { alive: true, todo: { total: 12, open: 12 } }] as [string, SessionSnapshot],
		);
		const text = statusText(j, snaps(...entries), { now: NOW }) ?? "";
		expect(displayWidth(text.slice("⏰ ".length))).toBeLessThanOrEqual(48);
		expect(text.endsWith("23:30")).toBe(true);
		expect(text.split("남은 12").length - 1).toBe(3);
		expect(text).toContain("al… 남은 12");
	});

	test("two full-width labels with counts and a time keep the counts and the time, shortening the labels", () => {
		const j = job([[cond("s1", "abcdefghijklmn"), cond("s2", "opqrstuvwxyzab")]], AT);
		const text = statusText(j, snaps(["s1", { alive: true, todo: { total: 4, open: 4 } }], ["s2", { alive: true, todo: { total: 6, open: 6 } }]), { now: NOW }) ?? "";
		expect(displayWidth(text.slice("⏰ ".length))).toBeLessThanOrEqual(48);
		expect(text).toContain("남은 4");
		expect(text).toContain("남은 6");
		expect(text.endsWith("23:30")).toBe(true);
		expect(text).toContain("abcdefghij…");
		expect(text).toContain("opqrstuvwx…");
	});

	test("six conds with counts overflow into …+N instead of eating the counts or the time", () => {
		const j = job(
			[
				[cond("s1", "abcdefghijkl"), cond("s2", "bcdefghijklm"), cond("s3", "cdefghijklmn")],
				[cond("s4", "defghijklmno"), cond("s5", "efghijklmnop"), cond("s6", "fghijklmnopq")],
			],
			AT,
		);
		const entries = ["s1", "s2", "s3", "s4", "s5", "s6"].map(
			(id) => [id, { alive: true, todo: { total: 3, open: 3 } }] as [string, SessionSnapshot],
		);
		const text = statusText(j, snaps(...entries), { now: NOW }) ?? "";
		expect(text).toContain("…+3");
		expect(displayWidth(text.slice("⏰ ".length))).toBeLessThanOrEqual(48);
		expect(text.endsWith(" | 23:30")).toBe(true);
		expect(text.split("남은 3").length - 1).toBe(3);
	});

	test("a crowded job hides whole conds rather than shrinking labels below 3 cells", () => {
		const conds = Array.from({ length: 12 }, (_, i) => cond(`s${i}`, "abcdefgh"));
		const j = job([conds.slice(0, 4), conds.slice(4, 8), conds.slice(8)], AT);
		const entries = conds.map((c) => [c.sessionId, { alive: true, todo: { total: 12, open: 12 } }] as [string, SessionSnapshot]);
		const text = statusText(j, snaps(...entries), { now: NOW }) ?? "";
		const visible = text.split("남은 12").length - 1;
		const hidden = 12 - visible;
		expect(hidden).toBe(10);
		expect(text).toContain(`…+${hidden}`);
		expect(displayWidth(text.slice("⏰ ".length))).toBeLessThanOrEqual(48);
		expect(text.endsWith("23:30")).toBe(true);
	});

	test("when no cond fits, only the overflow marker and the time remain (k = 0)", () => {
		const bloated: Paint = { ok: (text) => text, warn: (text) => `[${text.repeat(20)}]`, dim: (text) => text };
		const j = job([[cond("s1", "alpha"), cond("s2", "beta")], [cond("s3", "gamma")]], AT);
		const text = statusText(j, snaps(["s1", { alive: false }], ["s2", { alive: true, todo: { total: 1, open: 1 } }], ["s3", { alive: true }]), { paint: bloated, now: NOW }) ?? "";
		expect(text).toBe("⏰ …+3 | 23:30");
	});

	test("a Korean label is measured as two cells per character", () => {
		const j = job([[cond("s1", "데스크톱")]], AT);
		const text = statusText(j, snaps(["s1", { alive: true, todo: { total: 3, open: 3 } }]), { now: NOW }) ?? "";
		expect(text).toBe("⏰ 데스크톱 남은 3 | 23:30");
		expect(displayWidth("데스크톱")).toBe(8);
	});

	test("a label wider than 14 cells is cut by cells, not by characters", () => {
		const j = job([[cond("s1", "아주긴한글라벨입니다")]]);
		const text = statusText(j, snaps(["s1", { alive: true }])) ?? "";
		expect(text).toBe("⏰ 아주긴한글라…");
		expect(displayWidth(text.slice("⏰ ".length))).toBe(13);
	});

	test("the paint tags the ended mark, the dead mark and both joiners", () => {
		const ended = job([[cond("s1", "alpha", 1000)]]);
		expect(statusText(ended, snaps(["s1", { alive: false }]), { paint: tagging })).toContain("<ok>✓</ok>");

		const dead = job([[cond("s1", "alpha")]]);
		expect(statusText(dead, snaps(["s1", { alive: false }]), { paint: tagging })).toContain("<warn>꺼짐</warn>");

		const andGroup = job([[cond("a", "a", 1000), cond("b", "b")]]);
		expect(statusText(andGroup, snaps(), { paint: tagging })).toContain("<dim> & </dim>");

		const twoGroups = job([[cond("s1", "alpha")], [cond("s2", "beta")]]);
		expect(statusText(twoGroups, snaps(), { paint: tagging })).toContain("<dim> | </dim>");
	});
});
