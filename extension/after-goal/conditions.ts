import { formatClock } from "./time.ts";
import type { GoalCond, Job, RunningGoal } from "./types.ts";

/** OR of AND groups: every non-empty pick group becomes one `&` group of latched conditions. */
export function toConds(groups: RunningGoal[][], labels: ReadonlyMap<string, string>): GoalCond[][] {
	return groups
		.filter((group) => group.length > 0)
		.map((group) =>
			group.map((goal) => ({
				sessionId: goal.sessionId,
				goalId: goal.goalId,
				goalFile: goal.goalFile,
				label: labels.get(goal.sessionId) ?? goal.project,
			})),
		);
}

/** Asks `check` about every condition that has not ended yet; a text answer latches it. Returns whether anything changed. */
export function latch(job: Job, check: (cond: GoalCond) => string | undefined, now: number): boolean {
	let changed = false;
	for (const group of job.groups) {
		for (const cond of group) {
			if (cond.endedAt !== undefined) continue;
			const reason = check(cond);
			if (reason === undefined) continue;
			cond.endedAt = now;
			cond.endReason = reason;
			changed = true;
		}
	}
	return changed;
}

/** The first `&` group whose every condition ended; the `|` between groups is resolved by taking the first. */
export function satisfiedGroup(job: Job): GoalCond[] | undefined {
	return job.groups.find((group) => group.length > 0 && group.every((cond) => cond.endedAt !== undefined));
}

export function fireReason(group: GoalCond[]): string {
	return group.map((cond) => cond.endReason ?? `${cond.label} goal 종료`).join(", ");
}

export function expressionText(groups: Array<Array<{ label: string }>>): string {
	return groups.map((group) => group.map((cond) => cond.label).join(" & ")).join(" | ");
}

export function triggerSummary(job: Job, now?: Date): string {
	const parts: string[] = [];
	if (job.groups.length > 0) parts.push(`${expressionText(job.groups)} goal 종료`);
	if (job.at !== undefined) parts.push(formatClock(job.at, now));
	return parts.join(" 또는 ");
}
