import { describe, expect, test } from "bun:test";
import {
	expressionText,
	fireReason,
	latch,
	satisfiedGroup,
	toConds,
	triggerSummary,
} from "../extension/after-goal/conditions.ts";
import { labelSessions } from "../extension/after-goal/labels.ts";
import type { GoalCond, Job, RunningGoal } from "../extension/after-goal/types.ts";

function goal(sessionId: string, project: string, goalId = "g1"): RunningGoal {
	return {
		sessionId,
		goalId,
		goalFile: `C:/tmp/goals/${sessionId}.json`,
		project,
		objective: `objective of ${sessionId}`,
		seconds: 0,
	};
}

function cond(label: string, id = label): GoalCond {
	return { sessionId: `s-${id}`, goalId: `g-${id}`, goalFile: `C:/tmp/goals/${id}.json`, label };
}

function job(groups: GoalCond[][], at?: number): Job {
	return { id: "job-1", createdAt: 0, prompt: "prompt", groups, at };
}

describe("toConds", () => {
	test("maps goals to conditions through the labels map", () => {
		const a = goal("s1", "proj-a");
		const b = goal("s2", "proj-b");
		const labels = labelSessions([a, b]);
		const groups = toConds([[a], [b]], labels);

		expect(groups).toEqual([
			[{ sessionId: "s1", goalId: "g1", goalFile: "C:/tmp/goals/s1.json", label: "proj-a" }],
			[{ sessionId: "s2", goalId: "g1", goalFile: "C:/tmp/goals/s2.json", label: "proj-b" }],
		]);
	});

	test("falls back to the project name and drops empty groups", () => {
		const a = goal("s1", "proj-a");
		const b = goal("s2", "proj-b");
		const groups = toConds([[], [a, b]], new Map([["s1", "renamed"]]));

		expect(groups).toEqual([
			[
				{ sessionId: "s1", goalId: "g1", goalFile: "C:/tmp/goals/s1.json", label: "renamed" },
				{ sessionId: "s2", goalId: "g1", goalFile: "C:/tmp/goals/s2.json", label: "proj-b" },
			],
		]);
	});
});

describe("latch", () => {
	test("latches newly ended conditions and reports the change", () => {
		const a = cond("A");
		const b = cond("B");
		const job1 = job([[a, b]]);

		const changed = latch(job1, (c) => (c.label === "B" ? "B ended" : undefined), 1000);

		expect(changed).toBe(true);
		expect(a.endedAt).toBeUndefined();
		expect(b.endedAt).toBe(1000);
		expect(b.endReason).toBe("B ended");
	});

	test("keeps an already latched condition and returns false when nothing changed", () => {
		const a = cond("A");
		const job1 = job([[a]]);
		latch(job1, () => "first", 1000);

		const changed = latch(job1, () => "second", 2000);

		expect(changed).toBe(false);
		expect(a.endedAt).toBe(1000);
		expect(a.endReason).toBe("first");
	});

	test("latches every group, so the same goal in two groups is set in both", () => {
		const sharedInFirst = cond("shared");
		const sharedInSecond = cond("shared");
		const alone = cond("alone");
		const job1 = job([[sharedInFirst], [sharedInSecond, alone]]);

		const changed = latch(job1, (c) => `${c.label} ended`, 500);

		expect(changed).toBe(true);
		expect(sharedInFirst.endedAt).toBe(500);
		expect(sharedInSecond.endedAt).toBe(500);
		expect(alone.endedAt).toBe(500);
	});
});

describe("satisfiedGroup", () => {
	test("(A&B)|C is satisfied only by {A,B} or by {C}", () => {
		const build = () => job([[cond("A"), cond("B")], [cond("C")]]);

		const neither = build();
		expect(satisfiedGroup(neither)).toBeUndefined();

		const onlyA = build();
		latch(onlyA, (c) => (c.label === "A" ? "A ended" : undefined), 1);
		expect(satisfiedGroup(onlyA)).toBeUndefined();

		const ab = build();
		latch(ab, () => "ended", 1);
		expect(satisfiedGroup(ab)?.map((c) => c.label)).toEqual(["A", "B"]);

		const onlyC = build();
		latch(onlyC, (c) => (c.label === "C" ? "C ended" : undefined), 1);
		expect(satisfiedGroup(onlyC)?.map((c) => c.label)).toEqual(["C"]);
	});

	test("never treats a group with no conditions as satisfied", () => {
		expect(satisfiedGroup(job([[]]))).toBeUndefined();
	});
});

describe("fireReason", () => {
	test("joins end reasons and falls back to the label", () => {
		expect(fireReason([{ ...cond("A"), endReason: "A ended" }, cond("B")])).toBe("A ended, B goal 종료");
	});
});

describe("expressionText", () => {
	test("joins labels with & inside a group and | between groups", () => {
		expect(expressionText([[{ label: "A" }, { label: "B" }], [{ label: "C" }]])).toBe("A & B | C");
	});
});

describe("triggerSummary", () => {
	const at = new Date(2026, 0, 1, 23, 30).getTime();
	const now = new Date(2026, 0, 1, 12, 0);

	test("goals only", () => {
		expect(triggerSummary(job([[cond("A"), cond("B")], [cond("C")]]), now)).toBe("A & B | C goal 종료");
	});

	test("time only", () => {
		expect(triggerSummary(job([], at), now)).toBe("23:30");
	});

	test("both", () => {
		expect(triggerSummary(job([[cond("A")]], at), now)).toBe("A goal 종료 또는 23:30");
	});
});
