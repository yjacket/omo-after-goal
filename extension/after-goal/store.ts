import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GoalCond, Job, StoreFile } from "./types.ts";

export type LoadedStore = { job: Job | null; extraFile?: string; extraCount?: number };

/** The old single-slot shape: a `goal` object instead of `groups`, and no `fired` slot. */
type V1Job = {
	id?: unknown;
	createdAt?: unknown;
	prompt?: unknown;
	at?: unknown;
	goal?: { sessionId?: unknown; goalId?: unknown; goalFile?: unknown; label?: unknown } | null;
};

export function storePath(storeDir: string, sessionId: string): string {
	return join(storeDir, `${sessionId}.json`);
}

/** Writes the single reservation of a session: pretty `{version:2, job}` through a `.tmp` rename. */
export function saveStore(storeDir: string, sessionId: string, job: Job | null): void {
	mkdirSync(storeDir, { recursive: true });
	const file = storePath(storeDir, sessionId);
	const tmp = `${file}.tmp`;
	const data: StoreFile = { version: 2, job };
	writeFileSync(tmp, JSON.stringify(data, null, 2));
	renameSync(tmp, file);
}

/** Missing or unparsable stores read as `{job: null}` and the file is left alone. */
export function loadStore(storeDir: string, sessionId: string): LoadedStore {
	let raw: string;
	try {
		raw = readFileSync(storePath(storeDir, sessionId), "utf8");
	} catch {
		return { job: null };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { job: null };
	}
	const file = (typeof parsed === "object" && parsed !== null ? parsed : {}) as { version?: unknown; job?: unknown; jobs?: unknown };
	if (Array.isArray(file.jobs)) return migrateV1(storeDir, sessionId, file.jobs);
	if (file.version !== 2) return { job: null };
	return { job: validJob(file.job) };
}

/** A goal condition must carry all four strings, with only `endedAt`/`endReason` optional and typed. */
function isCond(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	const cond = value as Partial<GoalCond>;
	if (typeof cond.sessionId !== "string" || typeof cond.goalId !== "string" || typeof cond.goalFile !== "string" || typeof cond.label !== "string") return false;
	if (cond.endedAt !== undefined && typeof cond.endedAt !== "number") return false;
	if (cond.endReason !== undefined && typeof cond.endReason !== "string") return false;
	return true;
}

/** A shape-corrupt job is rejected wholesale, so it reads as `{job: null}` like a missing store. */
function validJob(value: unknown): Job | null {
	if (typeof value !== "object" || value === null) return null;
	const job = value as Partial<Job>;
	if (typeof job.id !== "string" || typeof job.prompt !== "string" || !Array.isArray(job.groups)) return null;
	for (const group of job.groups) {
		if (!Array.isArray(group) || !group.every(isCond)) return null;
	}
	if (job.at !== undefined && typeof job.at !== "number") return null;
	const fired = job.fired;
	if (fired !== undefined) {
		if (typeof fired !== "object" || fired === null || typeof fired.reason !== "string" || typeof fired.at !== "number") return null;
	}
	return job as Job;
}

/** Keeps the earliest v1 reservation, parks the rest in `<sessionId>.v1-extra.json`, and rewrites the slot as v2. */
function migrateV1(storeDir: string, sessionId: string, raw: unknown[]): LoadedStore {
	const sorted = raw
		.filter((entry): entry is V1Job => typeof entry === "object" && entry !== null)
		.sort((a, b) => Number(a.createdAt ?? 0) - Number(b.createdAt ?? 0));
	if (sorted.length === 0) return { job: null };
	const first = sorted[0];
	const goal = first.goal;
	const job: Job = {
		id: String(first.id),
		createdAt: Number(first.createdAt) || 0,
		prompt: String(first.prompt ?? ""),
		groups: goal
			? [
					[
						{
							sessionId: String(goal.sessionId),
							goalId: String(goal.goalId),
							goalFile: String(goal.goalFile),
							label: String(goal.label),
						},
					],
				]
			: [],
	};
	if (typeof first.at === "number") job.at = first.at;
	saveStore(storeDir, sessionId, job);
	const rest = sorted.slice(1);
	if (rest.length === 0) return { job };
	const extraFile = join(storeDir, `${sessionId}.v1-extra.json`);
	writeFileSync(extraFile, JSON.stringify({ version: 1, jobs: rest }, null, 2));
	return { job, extraFile, extraCount: rest.length };
}
