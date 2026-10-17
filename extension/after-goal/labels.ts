import type { RunningGoal } from "./types.ts";

/** sessionId -> the one name every dialog and the footer use; a second session of the same project reads `<project>#2`. */
export function labelSessions(goals: RunningGoal[]): Map<string, string> {
	const labels = new Map<string, string>();
	const perProject = new Map<string, number>();
	for (const goal of goals) {
		if (labels.has(goal.sessionId)) continue;
		const n = (perProject.get(goal.project) ?? 0) + 1;
		perProject.set(goal.project, n);
		labels.set(goal.sessionId, n === 1 ? goal.project : `${goal.project}#${n}`);
	}
	return labels;
}
