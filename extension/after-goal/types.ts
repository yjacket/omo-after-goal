/** One awaited goal of another session. `endedAt`/`endReason` latch once the goal is seen ended. */
export type GoalCond = {
	sessionId: string;
	goalId: string;
	/** `<sessionsDir>/<slug>/extensions/goal/<sessionId>.json` */
	goalFile: string;
	label: string;
	endedAt?: number;
	endReason?: string;
};

/** The one reservation of a session: fires when every goal of any group ended (`&` inside a group, `|` between groups), or at `at`. */
export type Job = {
	id: string;
	createdAt: number;
	prompt: string;
	/** OR of AND groups; empty when the reservation waits for a time only. */
	groups: GoalCond[][];
	at?: number;
	/** Set when the condition was met; the job keeps its slot until delivery starts. */
	fired?: { reason: string; at: number };
};

export type StoreFile = { version: 2; job: Job | null };

/** Open = pending + in_progress tasks of a session's newest todo list. */
export type TodoSummary = { total: number; open: number };

export type SessionSnapshot = { alive: boolean; todo?: TodoSummary };

export type RunningGoal = {
	sessionId: string;
	goalId: string;
	goalFile: string;
	project: string;
	objective: string;
	seconds: number;
	todo?: TodoSummary;
};

export type Paint = {
	ok(text: string): string;
	warn(text: string): string;
	dim(text: string): string;
};

export const plainPaint: Paint = {
	ok: (text) => text,
	warn: (text) => text,
	dim: (text) => text,
};

export type PickResult = { groups: RunningGoal[][] };

export const STATUS_KEY = "omo-after-goal";
