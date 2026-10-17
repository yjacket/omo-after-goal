import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { goalEndReason, isAlive, listRunningGoals, readTodo, sessionAlive, slugDirOf, snapshot } from "../extension/after-goal/sessions.ts";

const ALIVE = process.pid;
const DEAD = 999999999;

const dirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "after-goal-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

type Task = { content: string; status: string };

function phases(tasks: Task[]): unknown {
	return [{ name: "일", tasks }];
}

function customRecord(phaseList: unknown): string {
	return JSON.stringify({ type: "custom", customType: "senpi.todo-state", data: { schema: "v2", phases: phaseList } });
}

function toolRecord(tasks: Task[]): string {
	return JSON.stringify({
		type: "message",
		message: {
			role: "toolResult",
			toolName: "todo",
			content: [{ type: "text", text: "Overall: 3/7 done, 7 open." }],
			details: { op: "init", phases: phases(tasks), storage: "session" },
		},
	});
}

function filler(text: string): string {
	return JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } });
}

function writeJsonl(slugDir: string, sessionId: string, lines: string[]): string {
	mkdirSync(slugDir, { recursive: true });
	const path = join(slugDir, `2026-01-01T00-00-00_${sessionId}.jsonl`);
	writeFileSync(path, `${lines.join("\n")}\n`);
	return path;
}

describe("isAlive / sessionAlive / slugDirOf", () => {
	test("isAlive separates this process from an unused pid", () => {
		expect(isAlive(ALIVE)).toBe(true);
		expect(isAlive(DEAD)).toBe(false);
	});

	test("slugDirOf strips three levels off a Windows goal path", () => {
		expect(slugDirOf("C:\\agent\\sessions\\--qa-a--\\extensions\\goal\\s1.json")).toBe("C:\\agent\\sessions\\--qa-a--");
	});

	test("sessionAlive follows the holder pids", () => {
		const slugDir = tempDir();
		mkdirSync(join(slugDir, "session-holders", "s1"), { recursive: true });
		expect(sessionAlive(slugDir, "s1")).toBe(false);
		expect(sessionAlive(slugDir, "other")).toBe(false);
		writeFileSync(join(slugDir, "session-holders", "s1", `${DEAD}.json`), JSON.stringify({ pid: DEAD }));
		expect(sessionAlive(slugDir, "s1")).toBe(false);
		writeFileSync(join(slugDir, "session-holders", "s1", `${ALIVE}.json`), JSON.stringify({ pid: ALIVE }));
		expect(sessionAlive(slugDir, "s1")).toBe(true);
	});
});

describe("goalEndReason", () => {
	const ref = (goalFile: string) => ({ goalFile, goalId: "g1", label: "qa-a" });

	function goalFile(goal: unknown): string {
		const dir = tempDir();
		const file = join(dir, "session.json");
		writeFileSync(file, JSON.stringify({ version: 1, goal }));
		return file;
	}

	test("a missing file is released only while the session is alive", () => {
		const file = join(tempDir(), "gone.json");
		expect(goalEndReason(ref(file), true)).toBe("qa-a goal이 해제됨");
		expect(goalEndReason(ref(file), false)).toBeUndefined();
	});

	test("a file without a goal is released either way", () => {
		const file = goalFile(null);
		expect(goalEndReason(ref(file), true)).toBe("qa-a goal이 해제됨");
		expect(goalEndReason(ref(file), false)).toBe("qa-a goal이 해제됨");
	});

	test("another goal id beats the status", () => {
		const file = goalFile({ id: "g2", status: "complete" });
		expect(goalEndReason(ref(file))).toBe("qa-a goal이 다른 goal로 바뀜");
	});

	test("complete counts even after the session exited", () => {
		const file = goalFile({ id: "g1", status: "complete" });
		expect(goalEndReason(ref(file), true)).toBe("qa-a goal 완료");
		expect(goalEndReason(ref(file), false)).toBe("qa-a goal 완료");
	});

	test("blocked carries the first line of the reason", () => {
		expect(goalEndReason(ref(goalFile({ id: "g1", status: "blocked", blockedReason: "자격 증명 없음\n자세히" })), false)).toBe(
			"qa-a goal 중단(blocked): 자격 증명 없음",
		);
		expect(goalEndReason(ref(goalFile({ id: "g1", status: "blocked" })))).toBe("qa-a goal 중단(blocked)");
	});

	test("active, paused and unreadable files never end a goal", () => {
		expect(goalEndReason(ref(goalFile({ id: "g1", status: "active" })), false)).toBeUndefined();
		expect(goalEndReason(ref(goalFile({ id: "g1", status: "paused" })))).toBeUndefined();
		const broken = join(tempDir(), "broken.json");
		writeFileSync(broken, "{not json");
		expect(goalEndReason(ref(broken), true)).toBeUndefined();
		expect(goalEndReason(ref(broken), false)).toBeUndefined();
	});
});

describe("readTodo", () => {
	test("no transcript and no record are both undefined", () => {
		const dir = tempDir();
		expect(readTodo(dir, "s-none")).toBeUndefined();
		writeJsonl(dir, "s-empty", [filler("Overall: 3/7 done, 4 open.")]);
		expect(readTodo(dir, "s-empty")).toBeUndefined();
	});

	test("the newest structured record wins over an older toolResult", () => {
		const dir = tempDir();
		writeJsonl(dir, "s-order", [toolRecord([{ content: "a", status: "pending" }]), customRecord(phases([{ content: "b", status: "in_progress" }]))]);
		expect(readTodo(dir, "s-order")).toEqual({ total: 1, open: 1 });
	});

	test("the newest structured record wins over an older custom entry", () => {
		const dir = tempDir();
		writeJsonl(dir, "s-order2", [
			customRecord(phases([{ content: "a", status: "pending" }, { content: "b", status: "pending" }])),
			toolRecord([{ content: "c", status: "completed" }]),
		]);
		expect(readTodo(dir, "s-order2")).toEqual({ total: 1, open: 0 });
	});

	test("counts pending and in_progress as open, not completed or abandoned", () => {
		const dir = tempDir();
		writeJsonl(dir, "s-count", [
			customRecord(
				phases([
					{ content: "a", status: "pending" },
					{ content: "b", status: "in_progress" },
					{ content: "c", status: "completed" },
					{ content: "d", status: "abandoned" },
				]),
			),
		]);
		expect(readTodo(dir, "s-count")).toEqual({ total: 4, open: 2 });
	});

	test("a cleared list reads as zero open", () => {
		const dir = tempDir();
		writeJsonl(dir, "s-cleared", [customRecord(phases([{ content: "a", status: "pending" }])), customRecord([])]);
		expect(readTodo(dir, "s-cleared")).toEqual({ total: 0, open: 0 });
	});

	test("a toolResult counts only when the message is a toolResult", () => {
		const dir = tempDir();
		writeJsonl(dir, "s-assistant", [
			JSON.stringify({ type: "message", message: { role: "assistant", toolName: "todo", content: [{ type: "text", text: "칭찬" }], details: { phases: phases([{ content: "a", status: "pending" }]) } } }),
		]);
		expect(readTodo(dir, "s-assistant")).toBeUndefined();
	});

	test("skips a corrupt record and keeps scanning", () => {
		const dir = tempDir();
		writeJsonl(dir, "s-corrupt", [
			customRecord(phases([{ content: "a", status: "pending" }])),
			`{"type":"custom","customType":"senpi.todo-state","data":{"phases":`,
		]);
		expect(readTodo(dir, "s-corrupt")).toEqual({ total: 1, open: 1 });
	});

	test("a record without a phases array is not a count", () => {
		const dir = tempDir();
		writeJsonl(dir, "s-nophases", [
			customRecord(phases([{ content: "a", status: "completed" }])),
			JSON.stringify({ type: "custom", customType: "senpi.todo-state", data: { schema: "v2" } }),
		]);
		expect(readTodo(dir, "s-nophases")).toEqual({ total: 1, open: 0 });
	});

	test("the newest transcript of several wins", () => {
		const dir = tempDir();
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, `2026-01-01T00-00-00_s-two.jsonl`), `${customRecord(phases([{ content: "old", status: "pending" }]))}\n`);
		writeFileSync(join(dir, `2026-02-01T00-00-00_s-two.jsonl`), `${customRecord(phases([{ content: "new", status: "completed" }]))}\n`);
		expect(readTodo(dir, "s-two")).toEqual({ total: 1, open: 0 });
	});

	test("drops the partial first line of a file larger than the tail window", () => {
		const dir = tempDir();
		// One physical line: a long whitespace prefix followed by a complete record. The tail
		// window's cut point lands inside that prefix, so the piece left after the cut is a
		// parseable record (prefix tail + full JSON) that only the shift() can discard; every
		// piece after it is filler without a record.
		const record = customRecord(phases([{ content: "a", status: "pending" }, { content: "b", status: "completed" }]));
		const prefix = " ".repeat(512 * 1024);
		const path = writeJsonl(dir, "s-partial", [prefix + record, filler("x".repeat(768 * 1024))]);
		const size = statSync(path).size;
		expect(size).toBeGreaterThan(1024 * 1024);
		const cut = size - 1024 * 1024;
		expect(cut).toBeGreaterThan(0);
		expect(cut).toBeLessThan(prefix.length);
		expect(readTodo(dir, "s-partial")).toBeUndefined();
	});

	test("caches an unchanged file and re-reads after an append", () => {
		const dir = tempDir();
		const path = writeJsonl(dir, "s-cache", [customRecord(phases([{ content: "a", status: "pending" }, { content: "b", status: "pending" }]))]);
		const first = readTodo(dir, "s-cache");
		expect(first).toEqual({ total: 2, open: 2 });
		expect(readTodo(dir, "s-cache")).toBe(first);
		appendFileSync(path, `${customRecord(phases([{ content: "c", status: "completed" }]))}\n`);
		expect(readTodo(dir, "s-cache")).toEqual({ total: 1, open: 0 });
	});

	test("keeps the last summary when appended bytes push the record out of the tail window", () => {
		const dir = tempDir();
		const path = writeJsonl(dir, "s-window", [
			customRecord(phases([{ content: "a", status: "pending" }, { content: "b", status: "in_progress" }, { content: "c", status: "completed" }])),
		]);
		const first = readTodo(dir, "s-window");
		expect(first).toEqual({ total: 3, open: 2 });
		appendFileSync(path, `${Array.from({ length: 4 }, () => filler("y".repeat(300 * 1024))).join("\n")}\n`);
		expect(readTodo(dir, "s-window")).toEqual(first);
	});
});

describe("snapshot", () => {
	test("reports liveness and the open work of the session", () => {
		const sessionsDir = tempDir();
		const slugDir = join(sessionsDir, "--qa-a--");
		const goalFile = join(slugDir, "extensions", "goal", "s1.json");
		mkdirSync(join(slugDir, "session-holders", "s1"), { recursive: true });
		writeFileSync(join(slugDir, "session-holders", "s1", `${ALIVE}.json`), JSON.stringify({ pid: ALIVE, cwd: "C:\\dev\\omo\\proj-a" }));
		writeJsonl(slugDir, "s1", [customRecord(phases([{ content: "a", status: "in_progress" }, { content: "b", status: "completed" }]))]);
		const cond = { sessionId: "s1", goalId: "g1", goalFile, label: "proj-a" };
		expect(snapshot(cond)).toEqual({ alive: true, todo: { total: 2, open: 1 } });
	});

	test("a dead session without a todo is alive: false and no todo field", () => {
		const sessionsDir = tempDir();
		const slugDir = join(sessionsDir, "--qa-b--");
		const goalFile = join(slugDir, "extensions", "goal", "s2.json");
		mkdirSync(join(slugDir, "session-holders", "s2"), { recursive: true });
		writeFileSync(join(slugDir, "session-holders", "s2", `${DEAD}.json`), JSON.stringify({ pid: DEAD }));
		const snap = snapshot({ sessionId: "s2", goalId: "g1", goalFile, label: "proj-b" });
		expect(snap.alive).toBe(false);
		expect(snap.todo).toBeUndefined();
	});
});

describe("listRunningGoals", () => {
	function makeSession(
		sessionsDir: string,
		slug: string,
		sessionId: string,
		pid: number,
		goal: Record<string, unknown> | null,
		options: { cwd?: string; tasks?: Task[] } = {},
	): void {
		const slugDir = join(sessionsDir, slug);
		mkdirSync(join(slugDir, "session-holders", sessionId), { recursive: true });
		writeFileSync(
			join(slugDir, "session-holders", sessionId, `${pid}.json`),
			JSON.stringify({ pid, cwd: options.cwd ?? "C:\\dev\\omo\\proj-a" }),
		);
		if (goal) {
			mkdirSync(join(slugDir, "extensions", "goal"), { recursive: true });
			writeFileSync(join(slugDir, "extensions", "goal", `${sessionId}.json`), JSON.stringify({ version: 1, goal }));
		}
		if (options.tasks) writeJsonl(slugDir, sessionId, [customRecord(phases(options.tasks))]);
	}

	test("keeps only other live sessions with an active goal, newest work first", () => {
		const sessionsDir = tempDir();
		makeSession(sessionsDir, "--self--", "self", ALIVE, { id: "g1", objective: "내 일", status: "active", timeUsedSeconds: 10 });
		makeSession(sessionsDir, "--qa-a--", "sa", ALIVE, { id: "ga", objective: "첫 줄\n둘째 줄", status: "active", timeUsedSeconds: 100 }, {
			cwd: "C:\\dev\\omo\\proj-a",
			tasks: [{ content: "a", status: "pending" }, { content: "b", status: "completed" }],
		});
		makeSession(sessionsDir, "--qa-b--", "sb", ALIVE, { id: "gb", objective: "긴 일", status: "active", timeUsedSeconds: 3000 }, { cwd: "C:\\qa\\qa-b" });
		makeSession(sessionsDir, "--qa-dead--", "sd", DEAD, { id: "gd", objective: "죽음", status: "active", timeUsedSeconds: 9999 });
		makeSession(sessionsDir, "--qa-done--", "sf", ALIVE, { id: "gf", objective: "끝", status: "complete", timeUsedSeconds: 8888 });
		makeSession(sessionsDir, "--qa-none--", "sn", ALIVE, null);
		const goals = listRunningGoals(sessionsDir, "self");
		expect(goals.map((g) => g.sessionId)).toEqual(["sb", "sa"]);
		expect(goals[0]).toEqual({
			sessionId: "sb",
			goalId: "gb",
			goalFile: join(sessionsDir, "--qa-b--", "extensions", "goal", "sb.json"),
			project: "qa-b",
			objective: "긴 일",
			seconds: 3000,
			todo: undefined,
		});
		expect(goals[1]!.project).toBe("proj-a");
		expect(goals[1]!.objective).toBe("첫 줄");
		expect(goals[1]!.todo).toEqual({ total: 2, open: 1 });
	});

	test("falls back to the slug when the holder has no cwd", () => {
		const sessionsDir = tempDir();
		const slugDir = join(sessionsDir, "--qa-c--");
		mkdirSync(join(slugDir, "session-holders", "sc"), { recursive: true });
		writeFileSync(join(slugDir, "session-holders", "sc", `${ALIVE}.json`), JSON.stringify({ pid: ALIVE }));
		mkdirSync(join(slugDir, "extensions", "goal"), { recursive: true });
		writeFileSync(join(slugDir, "extensions", "goal", "sc.json"), JSON.stringify({ version: 1, goal: { id: "gc", objective: "일", status: "active" } }));
		const goals = listRunningGoals(sessionsDir, undefined);
		expect(goals).toHaveLength(1);
		expect(goals[0]!.project).toBe("qa-c");
		expect(goals[0]!.seconds).toBe(0);
	});
});
