// sessions.ts: which awaited sessions are still running, why their goal ended, and how much
// of their newest todo list is still open. The open count is read from the todo tool's
// structured records (a `senpi.todo-state` custom entry or a `todo`/`todowrite` toolResult),
// never from prose quoting an older "Overall: N/M done" line.
import { closeSync, existsSync, openSync, readFileSync, readdirSync, readSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { firstLine } from "./text.ts";
import type { GoalCond, RunningGoal, SessionSnapshot, TodoSummary } from "./types.ts";

/** Todo records are read from the tail only; 1 MiB is far more than a list needs. */
const TODO_TAIL_BYTES = 1024 * 1024;

function safeReaddir(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

export function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** `<sessionsDir>/<slug>/extensions/goal/<sessionId>.json` -> `<sessionsDir>/<slug>` */
export function slugDirOf(goalFile: string): string {
	return dirname(dirname(dirname(goalFile)));
}

/** A session counts as running while any of its holder records names a live pid. */
export function sessionAlive(slugDir: string, sessionId: string): boolean {
	for (const file of safeReaddir(join(slugDir, "session-holders", sessionId))) {
		if (!file.endsWith(".json")) continue;
		const pid = Number(file.replace(/\.json$/, ""));
		if (pid > 0 && isAlive(pid)) return true;
	}
	return false;
}

type GoalRead = { kind: "missing" } | { kind: "unreadable" } | { kind: "goal"; goal: Record<string, any> | null };

function readGoalFile(file: string): GoalRead {
	if (!existsSync(file)) return { kind: "missing" };
	try {
		const goal = JSON.parse(readFileSync(file, "utf8"))?.goal;
		return { kind: "goal", goal: goal && typeof goal === "object" ? goal : null };
	} catch {
		return { kind: "unreadable" };
	}
}

/**
 * Why the awaited goal ended, or undefined while it still runs.
 * A missing file is only "released" while the session is alive: a dead session that lost its
 * goal file is not proof that any work finished. Every reason the live session itself wrote
 * (goal replaced, complete, blocked) counts even after it exited.
 */
export function goalEndReason(ref: Pick<GoalCond, "goalFile" | "goalId" | "label">, alive = true): string | undefined {
	const read = readGoalFile(ref.goalFile);
	if (read.kind === "unreadable") return undefined;
	if (read.kind === "missing") return alive ? `${ref.label} goal이 해제됨` : undefined;
	if (read.goal === null) return `${ref.label} goal이 해제됨`;
	const goal = read.goal;
	if (goal.id !== ref.goalId) return `${ref.label} goal이 다른 goal로 바뀜`;
	if (goal.status === "complete") return `${ref.label} goal 완료`;
	if (goal.status === "blocked") return `${ref.label} goal 중단(blocked)${goal.blockedReason ? `: ${firstLine(String(goal.blockedReason), 200)}` : ""}`;
	return undefined;
}

type TodoCache = { size: number; mtimeMs: number; summary: TodoSummary | undefined };

const todoCache = new Map<string, TodoCache>();

/** Newest transcript of the session, by file name. */
function newestJsonl(slugDir: string, sessionId: string): string | undefined {
	return safeReaddir(slugDir)
		.filter((file) => file.endsWith(`_${sessionId}.jsonl`))
		.sort()
		.at(-1);
}

function summarize(phases: unknown): TodoSummary | undefined {
	if (!Array.isArray(phases)) return undefined;
	const tasks = phases.flatMap((phase: any) => (Array.isArray(phase?.tasks) ? phase.tasks : []));
	const open = tasks.filter((task: any) => task?.status === "pending" || task?.status === "in_progress").length;
	return { total: tasks.length, open };
}

/** Last matching todo record of the tail: scanning backwards makes the newest record win. */
function scanTail(path: string, size: number): TodoSummary | undefined {
	const length = Math.min(size, TODO_TAIL_BYTES);
	const buffer = Buffer.alloc(length);
	const fd = openSync(path, "r");
	try {
		readSync(fd, buffer, 0, length, size - length);
	} finally {
		closeSync(fd);
	}
	const pieces = buffer.toString("utf8").split("\n");
	if (size > length) pieces.shift();
	for (let i = pieces.length - 1; i >= 0; i--) {
		const line = pieces[i]!;
		let phases: unknown;
		try {
			if (line.includes(`"customType":"senpi.todo-state"`)) {
				phases = JSON.parse(line)?.data?.phases;
			} else if (line.includes(`"toolName":"todo"`) || line.includes(`"toolName":"todowrite"`)) {
				const entry = JSON.parse(line);
				if (entry?.message?.role !== "toolResult") continue;
				phases = entry.message.details?.phases;
			} else {
				continue;
			}
		} catch {
			continue;
		}
		const summary = summarize(phases);
		if (summary) return summary;
	}
	return undefined;
}

/**
 * Pending + in_progress tasks of the session's newest todo list.
 * The result is cached per file (size + mtimeMs) so an unchanged file is never re-read; when
 * appended bytes push the newest record out of the tail window, the last summary stays shown.
 */
export function readTodo(slugDir: string, sessionId: string): TodoSummary | undefined {
	const file = newestJsonl(slugDir, sessionId);
	if (!file) return undefined;
	const path = join(slugDir, file);
	let stat;
	try {
		stat = statSync(path);
	} catch {
		return undefined;
	}
	const cached = todoCache.get(path);
	if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.summary;
	try {
		const found = scanTail(path, stat.size);
		if (found) {
			todoCache.set(path, { size: stat.size, mtimeMs: stat.mtimeMs, summary: found });
			return found;
		}
	} catch {
		// an unreadable file keeps whatever summary the last successful read produced
	}
	if (cached?.summary && stat.size >= cached.size) {
		todoCache.set(path, { size: stat.size, mtimeMs: stat.mtimeMs, summary: cached.summary });
		return cached.summary;
	}
	todoCache.set(path, { size: stat.size, mtimeMs: stat.mtimeMs, summary: undefined });
	return undefined;
}

/** Liveness and open work of one awaited session, as the footer needs them. */
export function snapshot(cond: GoalCond): SessionSnapshot {
	const slugDir = slugDirOf(cond.goalFile);
	const alive = sessionAlive(slugDir, cond.sessionId);
	const todo = readTodo(slugDir, cond.sessionId);
	return todo ? { alive, todo } : { alive };
}

/** Running sessions (a `session-holders/<id>/<pid>.json` whose pid is alive) with an active goal. */
export function listRunningGoals(sessionsDir: string, selfId: string | undefined): RunningGoal[] {
	const out: RunningGoal[] = [];
	for (const slug of safeReaddir(sessionsDir)) {
		const slugDir = join(sessionsDir, slug);
		const holdersDir = join(slugDir, "session-holders");
		for (const sessionId of safeReaddir(holdersDir)) {
			if (sessionId === selfId) continue;
			let cwd: string | undefined;
			const alive = safeReaddir(join(holdersDir, sessionId)).some((file) => {
				const pid = Number(file.replace(/\.json$/, ""));
				if (!(pid > 0) || !isAlive(pid)) return false;
				try {
					cwd = JSON.parse(readFileSync(join(holdersDir, sessionId, file), "utf8")).cwd;
				} catch {}
				return true;
			});
			if (!alive) continue;
			const goalFile = join(slugDir, "extensions", "goal", `${sessionId}.json`);
			const read = readGoalFile(goalFile);
			if (read.kind !== "goal" || read.goal?.status !== "active") continue;
			out.push({
				sessionId,
				goalId: String(read.goal.id),
				goalFile,
				project: cwd ? basename(cwd) : slug.replace(/^-+|-+$/g, ""),
				objective: firstLine(String(read.goal.objective ?? "")),
				seconds: Number(read.goal.timeUsedSeconds ?? 0),
				todo: readTodo(slugDir, sessionId),
			});
		}
	}
	return out.sort((a, b) => b.seconds - a.seconds);
}
