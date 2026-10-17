import { describe, expect, test } from "bun:test";
import { labelSessions } from "../extension/after-goal/labels.ts";
import type { RunningGoal } from "../extension/after-goal/types.ts";

function goal(sessionId: string, project: string): RunningGoal {
	return {
		sessionId,
		goalId: `${sessionId}-goal`,
		goalFile: `/goals/${sessionId}.json`,
		project,
		objective: `objective of ${sessionId}`,
		seconds: 60,
	};
}

describe("labelSessions", () => {
	test("names each session after its project when projects differ", () => {
		const labels = labelSessions([goal("s1", "alpha"), goal("s2", "beta"), goal("s3", "gamma")]);
		expect(labels.get("s1")).toBe("alpha");
		expect(labels.get("s2")).toBe("beta");
		expect(labels.get("s3")).toBe("gamma");
	});

	test("a repeated project is numbered by list order", () => {
		const labels = labelSessions([goal("s1", "alpha"), goal("s2", "alpha"), goal("s3", "alpha")]);
		expect(labels.get("s1")).toBe("alpha");
		expect(labels.get("s2")).toBe("alpha#2");
		expect(labels.get("s3")).toBe("alpha#3");
	});

	test("each session is labelled once and does not consume a number", () => {
		const labels = labelSessions([goal("s1", "alpha"), goal("s1", "alpha"), goal("s2", "alpha")]);
		expect(labels.size).toBe(2);
		expect(labels.get("s1")).toBe("alpha");
		expect(labels.get("s2")).toBe("alpha#2");
	});
});
