import { afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createAfterGoal } from "../extension/after-goal/index.ts";
import { loadStore, storePath } from "../extension/after-goal/store.ts";
import { STATUS_KEY } from "../extension/after-goal/types.ts";

const ALIVE = process.pid;
const DEAD = 999999999;
const POLL = 20;
const RETRY = 20;
const SELF = "self-session";
const TIME_ROW = "시간 조건만";

// ---------------------------------------------------------------- fixtures

const roots: string[] = [];

function makeEnv() {
	const root = mkdtempSync(join(tmpdir(), "after-goal-index-"));
	roots.push(root);
	const sessionsDir = join(root, "sessions");
	const storeDir = join(root, "store");
	mkdirSync(sessionsDir, { recursive: true });
	mkdirSync(storeDir, { recursive: true });
	return {
		root,
		sessionsDir,
		storeDir,
		writeGoal(goalFile: string, goal: unknown) {
			mkdirSync(dirname(goalFile), { recursive: true });
			writeFileSync(goalFile, JSON.stringify({ version: 1, goal }));
		},
		removeGoal(goalFile: string) {
			unlinkSync(goalFile);
		},
	};
}

type Env = ReturnType<typeof makeEnv>;

type SessionSpec = {
	slug: string;
	sessionId: string;
	cwd: string;
	pid?: number;
	goalId?: string;
	status?: string;
	objective?: string;
	seconds?: number;
	open?: number;
	total?: number;
};

function todoLine(open: number, total: number): string {
	const tasks = [];
	for (let i = 0; i < total; i++) tasks.push({ content: `t${i}`, status: i < open ? "pending" : "completed" });
	return JSON.stringify({ type: "custom", customType: "senpi.todo-state", data: { schema: "v2", phases: [{ name: "p", tasks }] } });
}

function todoFile(slugDir: string, sessionId: string): string {
	return join(slugDir, `2026-01-01T00-00-00_${sessionId}.jsonl`);
}

function writeSession(env: Env, spec: SessionSpec) {
	const slugDir = join(env.sessionsDir, spec.slug);
	const holderDir = join(slugDir, "session-holders", spec.sessionId);
	mkdirSync(holderDir, { recursive: true });
	const pid = spec.pid ?? ALIVE;
	writeFileSync(join(holderDir, `${pid}.json`), JSON.stringify({ pid, cwd: spec.cwd }));
	const goalFile = join(slugDir, "extensions", "goal", `${spec.sessionId}.json`);
	env.writeGoal(goalFile, {
		id: spec.goalId ?? "g1",
		objective: spec.objective ?? "목표",
		status: spec.status ?? "active",
		timeUsedSeconds: spec.seconds ?? 60,
	});
	if (spec.open !== undefined) {
		writeFileSync(todoFile(slugDir, spec.sessionId), `${todoLine(spec.open, spec.total ?? spec.open)}\n`);
	}
	return { slugDir, goalFile };
}

function appendTodo(slugDir: string, sessionId: string, open: number, total: number): void {
	appendFileSync(todoFile(slugDir, sessionId), `${todoLine(open, total)}\n`);
}

// ---------------------------------------------------------------- fake host

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

type HostConfig = {
	isIdle?: boolean;
	draft?: string;
	noCustom?: boolean;
	selectPick?: (options: string[]) => string | undefined;
	editorText?: string | undefined;
	inputText?: string;
	confirmAnswer?: boolean | ((title: string) => boolean);
	setStatusThrows?: boolean;
};

function makeHost(config: HostConfig = {}) {
	const host: any = {
		sent: [] as string[],
		statuses: [] as (string | undefined)[],
		statusMap: new Map<string, string | undefined>(),
		notifies: [] as { message: string; level?: string }[],
		confirms: [] as { title: string; message: string }[],
		editors: [] as { title: string; initial: string }[],
		inputs: [] as { title: string; initial: string }[],
		selects: [] as { title: string; options: string[] }[],
		pickerKeys: [] as string[],
		customResult: undefined as unknown,
		picker: undefined as any,
		customOptions: undefined as unknown,
		isIdle: config.isIdle ?? true,
		draft: config.draft ?? "",
		setStatusThrows: config.setStatusThrows ?? false,
		editorText: config.editorText === undefined ? "예약 프롬프트" : config.editorText,
		inputText: config.inputText ?? "",
		selectPick: config.selectPick ?? (() => undefined),
		confirmAnswer: config.confirmAnswer ?? true,
	};
	host.ui = {
		setStatus: mock((key: string, value: string | undefined) => {
			// recorded before the throw so a throwing host can still be asserted
			host.statuses.push(value);
			host.statusMap.set(key, value);
			if (host.setStatusThrows) throw new Error("stale ctx");
		}),
		notify: mock((message: string, level?: string) => {
			host.notifies.push({ message, level });
		}),
		confirm: mock(async (title: string, message: string) => {
			host.confirms.push({ title, message });
			return typeof host.confirmAnswer === "function" ? host.confirmAnswer(title) : host.confirmAnswer;
		}),
		editor: mock(async (title: string, initial: string) => {
			host.editors.push({ title, initial });
			return host.editorText;
		}),
		input: mock(async (title: string, initial: string) => {
			host.inputs.push({ title, initial });
			return host.inputText;
		}),
		select: mock(async (title: string, options: string[]) => {
			host.selects.push({ title, options });
			return host.selectPick(options);
		}),
		getEditorText: () => host.draft,
	};
	if (!config.noCustom) {
		host.ui.custom = mock(async (factory: any, options: unknown) => {
			host.customOptions = options;
			return await new Promise((resolve) => {
				const component = factory(
					{ requestRender() {} },
					theme,
					{ matches: () => false },
					(result: unknown) => {
						host.customResult = result;
						resolve(result);
					},
				);
				host.picker = component;
				for (const key of host.pickerKeys) component.handleInput(key);
			});
		});
	}
	host.ctx = {
		hasUI: true,
		mode: "tui",
		isIdle: () => host.isIdle,
		hasPendingMessages: () => false,
		sessionManager: { getSessionId: () => SELF },
		ui: host.ui,
	};
	host.pi = {
		handlers: new Map<string, ((event: unknown, ctx: any) => unknown)[]>(),
		commands: new Map<string, any>(),
		sendUserMessage: mock((text: string) => {
			host.sent.push(text);
		}),
		exec: mock(async () => ({ code: 0, stdout: "" })),
		on(name: string, handler: (event: unknown, ctx: any) => unknown) {
			host.pi.handlers.set(name, [...(host.pi.handlers.get(name) ?? []), handler]);
		},
		registerCommand(name: string, spec: any) {
			host.pi.commands.set(name, spec);
		},
	};
	return host;
}

type Host = ReturnType<typeof makeHost>;

const hosts: Host[] = [];

function newHost(config: HostConfig = {}): Host {
	const host = makeHost(config);
	hosts.push(host);
	return host;
}

async function start(host: Host, env: Env): Promise<void> {
	createAfterGoal({ sessionsDir: env.sessionsDir, storeDir: env.storeDir, pollMs: POLL, retryMs: RETRY })(host.pi);
	await fire(host, "session_start", host.ctx);
}

async function fire(host: Host, name: string, ctx: unknown): Promise<void> {
	for (const handler of host.pi.handlers.get(name) ?? []) await handler({}, ctx);
}

async function command(host: Host, args: string, ctx: unknown = host.ctx): Promise<void> {
	await host.pi.commands.get("after").handler(args, ctx);
}

/** Runs `n` poll ticks and drains the microtasks they queued. No sleeps: the poll timer is faked. */
async function tick(n = 1): Promise<void> {
	for (let i = 0; i < n; i++) jest.advanceTimersByTime(POLL);
	await Promise.resolve();
}

function status(host: Host): string | undefined {
	return host.statusMap.get(STATUS_KEY);
}

/** Schedules a reservation through the real picker: `keys` drive ConditionPicker, then Enter/Esc confirms. */
async function schedule(host: Host, keys: string[], prompt = host.editorText): Promise<void> {
	host.pickerKeys = keys;
	host.editorText = prompt;
	await command(host, "");
}

function complete(env: Env, goalFile: string, goalId = "g1"): void {
	env.writeGoal(goalFile, { id: goalId, objective: "목표", status: "complete", timeUsedSeconds: 60 });
}

// ---------------------------------------------------------------- lifecycle

beforeEach(() => {
	jest.useFakeTimers();
});

afterEach(async () => {
	for (const host of hosts.splice(0)) await fire(host, "session_shutdown", host.ctx);
	jest.useRealTimers();
	while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

// ---------------------------------------------------------------- tests

describe("/after scheduling and delivery", () => {
	test("(a) A & B: footer counts, A finished shows ✓, B finished delivers once and clears", async () => {
		const env = makeEnv();
		const a = writeSession(env, { slug: "--qa-a--", sessionId: "s-a", cwd: "C:/work/qa-a", open: 2 });
		const b = writeSession(env, { slug: "--qa-b--", sessionId: "s-b", cwd: "C:/work/qa-b", open: 1 });
		const host = newHost({ editorText: "합쳐진 프롬프트" });
		await start(host, env);

		await schedule(host, ["&", "\x1b[B", "&", "\r"]);
		await tick();
		expect(status(host)).toBe("⏰ qa-a 남은 2 & qa-b 남은 1");
		expect(host.customResult).toEqual({ groups: expect.any(Array) });

		complete(env, a.goalFile);
		await tick(2);
		expect(status(host)).toBe("⏰ qa-a ✓ & qa-b 남은 1");
		expect(host.sent).toHaveLength(0);

		complete(env, b.goalFile);
		await tick(2);
		expect(host.sent).toHaveLength(1);
		expect(host.sent[0]).toContain("합쳐진 프롬프트");
		expect(host.sent[0]).toContain("예약 실행 사유: qa-a goal 완료, qa-b goal 완료");
		expect(status(host)).toBeUndefined();
		expect(loadStore(env.storeDir, SELF).job).toBeNull();
	});

	test("(b) A | B: finishing B alone delivers", async () => {
		const env = makeEnv();
		writeSession(env, { slug: "--qa-a--", sessionId: "s-a", cwd: "C:/work/qa-a", open: 1 });
		const b = writeSession(env, { slug: "--qa-b--", sessionId: "s-b", cwd: "C:/work/qa-b", open: 1 });
		const host = newHost({ editorText: "또는 프롬프트" });
		await start(host, env);

		await schedule(host, ["|", "\x1b[B", "\r"]);
		await tick();
		expect(status(host)).toBe("⏰ qa-a 남은 1 | qa-b 남은 1");

		complete(env, b.goalFile);
		await tick(2);
		expect(host.sent).toHaveLength(1);
		expect(host.sent[0]).toContain("예약 실행 사유: qa-b goal 완료");
	});

	test("(c) /after now fires a pending reservation with 강제 실행", async () => {
		const env = makeEnv();
		writeSession(env, { slug: "--qa-a--", sessionId: "s-a", cwd: "C:/work/qa-a", open: 1 });
		const host = newHost({ editorText: "강제 프롬프트" });
		await start(host, env);

		await schedule(host, ["\r"]);
		await command(host, "now");
		await tick();
		expect(host.sent).toHaveLength(1);
		expect(host.sent[0]).toContain("강제 프롬프트");
		expect(host.sent[0]).toContain("예약 실행 사유: 강제 실행");
		expect(loadStore(env.storeDir, SELF).job).toBeNull();
	});

	test("(d) a second /after confirms 예약 바꾸기, prefills the old prompt, and a declined 예약 keeps the old job", async () => {
		const env = makeEnv();
		const a = writeSession(env, { slug: "--qa-a--", sessionId: "s-a", cwd: "C:/work/qa-a", open: 1 });
		const host = newHost({ editorText: "첫 프롬프트" });
		await start(host, env);

		await schedule(host, ["\r"]);
		const first = loadStore(env.storeDir, SELF).job!;
		const before = status(host);
		host.confirmAnswer = (title: string) => title !== "예약";

		await schedule(host, ["\r"], "첫 프롬프트");
		expect(host.confirms[1].title).toBe("예약 바꾸기");
		expect(host.confirms[1].message).toContain("새로 예약하면 지금 예약은 지워집니다");
		expect(host.editors.at(-1)!.initial).toBe("첫 프롬프트");
		expect(host.editors).toHaveLength(2);
		const after = loadStore(env.storeDir, SELF).job!;
		expect(after.id).toBe(first.id);
		expect(after.prompt).toBe("첫 프롬프트");
		expect(status(host)).toBe(before);

		// the declined replace left the OLD job armed: its own goal still delivers the OLD prompt
		complete(env, a.goalFile);
		await tick(2);
		expect(host.sent).toHaveLength(1);
		expect(host.sent[0]).toContain("첫 프롬프트");
		expect(host.sent[0]).toContain("예약 실행 사유: qa-a goal 완료");
		// the declined replace never armed the new time-only reservation
		expect(host.notifies.filter((n: { message: string }) => n.message.startsWith("예약됨"))).toHaveLength(1);
	});

	test("(e) /after cancel clears the store job and the footer", async () => {
		const env = makeEnv();
		writeSession(env, { slug: "--qa-a--", sessionId: "s-a", cwd: "C:/work/qa-a", open: 1 });
		const host = newHost({ editorText: "취소될 프롬프트" });
		await start(host, env);

		await schedule(host, ["\r"]);
		expect(loadStore(env.storeDir, SELF).job).not.toBeNull();
		await command(host, "cancel");
		expect(loadStore(env.storeDir, SELF).job).toBeNull();
		expect(status(host)).toBeUndefined();
		expect(host.notifies.at(-1)).toEqual({ message: "예약을 취소했습니다", level: "info" });
	});

	test("(e2) /after list is an alias of cancel", async () => {
		const env = makeEnv();
		writeSession(env, { slug: "--qa-a--", sessionId: "s-a", cwd: "C:/work/qa-a", open: 1 });
		const host = newHost({ editorText: "목록 취소" });
		await start(host, env);

		await schedule(host, ["\r"]);
		await command(host, "list");
		expect(loadStore(env.storeDir, SELF).job).toBeNull();
		expect(status(host)).toBeUndefined();
	});

	test("(f) /after foo notifies an error and unknown args leave the job alone", async () => {
		const env = makeEnv();
		writeSession(env, { slug: "--qa-a--", sessionId: "s-a", cwd: "C:/work/qa-a", open: 1 });
		const host = newHost({ editorText: "인자 프롬프트" });
		await start(host, env);
		await schedule(host, ["\r"]);
		const job = loadStore(env.storeDir, SELF).job!;

		await command(host, "foo");
		expect(host.notifies.at(-1)).toEqual({ message: "알 수 없는 인자: foo (now, cancel)", level: "error" });
		expect(loadStore(env.storeDir, SELF).job!.id).toBe(job.id);

		const spec = host.pi.commands.get("after");
		const items = [
			{ value: "now", label: "now", description: "예약을 지금 실행" },
			{ value: "cancel", label: "cancel", description: "예약 취소" },
		];
		expect(spec.getArgumentCompletions("")).toEqual(items);
		expect(spec.getArgumentCompletions("  ")).toEqual(items);
		expect(spec.getArgumentCompletions("n")).toEqual([items[0]]);
		expect(spec.getArgumentCompletions("c")).toEqual([items[1]]);
		expect(spec.getArgumentCompletions("x")).toBeNull();
		expect(spec.getArgumentCompletions("zzz")).toBeNull();
	});
});

describe("stores, sessions and liveness", () => {
	test("(g) a v1 store at session_start migrates, arms and shows the footer", async () => {
		const env = makeEnv();
		const a = writeSession(env, { slug: "--qa-a--", sessionId: "s-a", cwd: "C:/work/qa-a", open: 2 });
		writeFileSync(
			storePath(env.storeDir, SELF),
			JSON.stringify({
				version: 1,
				jobs: [{ id: "old", createdAt: 1, prompt: "예전 프롬프트", goal: { sessionId: "s-a", goalId: "g1", goalFile: a.goalFile, label: "qa-a" } }],
			}),
		);
		const host = newHost();
		await start(host, env);
		await tick();

		expect(status(host)).toBe("⏰ qa-a 남은 2");
		const stored = JSON.parse(readFileSync(storePath(env.storeDir, SELF), "utf8"));
		expect(stored.version).toBe(2);
		expect(stored.job.groups).toEqual([[{ sessionId: "s-a", goalId: "g1", goalFile: a.goalFile, label: "qa-a" }]]);
	});

	test("(h) a dead waited session reads 꺼짐, never delivers, even when its goal file disappears; a complete file counts", async () => {
		const env = makeEnv();
		const d = writeSession(env, { slug: "--qa-d--", sessionId: "s-d", cwd: "C:/work/qa-d", open: 1 });
		const host = newHost({ editorText: "죽은 세션 프롬프트" });
		await start(host, env);

		await schedule(host, ["\r"]);
		// the session stops running after the reservation was made
		const holderDir = join(d.slugDir, "session-holders", "s-d");
		unlinkSync(join(holderDir, `${ALIVE}.json`));
		writeFileSync(join(holderDir, `${DEAD}.json`), JSON.stringify({ pid: DEAD, cwd: "C:/work/qa-d" }));
		await tick(2);
		expect(status(host)).toBe("⏰ qa-d 꺼짐");
		expect(host.sent).toHaveLength(0);

		env.removeGoal(d.goalFile);
		await tick(3);
		expect(host.sent).toHaveLength(0);
		expect(status(host)).toBe("⏰ qa-d 꺼짐");

		complete(env, d.goalFile);
		await tick(2);
		expect(host.sent).toHaveLength(1);
		expect(host.sent[0]).toContain("예약 실행 사유: qa-d goal 완료");
	});

	test("(i) a throwing setStatus never escapes the poll timer", async () => {
		const env = makeEnv();
		const a = writeSession(env, { slug: "--qa-a--", sessionId: "s-a", cwd: "C:/work/qa-a", open: 1 });
		const host = newHost({ editorText: "던지는 상태", setStatusThrows: true });
		await start(host, env);

		await schedule(host, ["\r"]);
		await tick(2);
		complete(env, a.goalFile);
		await tick(3);
		expect(host.sent).toHaveLength(1);
		expect(loadStore(env.storeDir, SELF).job).toBeNull();
	});

	test("(j) a time-only reservation records empty groups and a past at fires on session_start", async () => {
		const env = makeEnv();
		writeSession(env, { slug: "--qa-a--", sessionId: "s-a", cwd: "C:/work/qa-a", open: 1 });
		const host = newHost({ editorText: "시간 프롬프트", inputText: "1m" });
		await start(host, env);

		await schedule(host, ["\x1b[B", "\r"]);
		const scheduled = loadStore(env.storeDir, SELF).job!;
		expect(scheduled.groups).toEqual([]);
		expect(typeof scheduled.at).toBe("number");
		await command(host, "cancel");

		const past = { id: "time-only", createdAt: 1, prompt: "지난 시간 프롬프트", groups: [], at: Date.now() - 1000 };
		writeFileSync(storePath(env.storeDir, SELF), JSON.stringify({ version: 2, job: past }));
		jest.useRealTimers();
		jest.useFakeTimers();
		const restarted = newHost();
		await start(restarted, env);
		await tick();
		expect(restarted.sent).toHaveLength(1);
		expect(restarted.sent[0]).toContain("지난 시간 프롬프트");
		expect(restarted.sent[0]).toMatch(/예약 실행 사유: 예약 시간 \d{2}:\d{2} 도달/);
		expect(loadStore(env.storeDir, SELF).job).toBeNull();
	});

	test("(l) a store holding a fired job with an unmet condition is delivered once after session_start", async () => {
		const env = makeEnv();
		const a = writeSession(env, { slug: "--qa-a--", sessionId: "s-a", cwd: "C:/work/qa-a", open: 2 });
		const fired = {
			id: "fired",
			createdAt: 1,
			prompt: "재시작 프롬프트",
			groups: [[{ sessionId: "s-a", goalId: "g1", goalFile: a.goalFile, label: "qa-a" }]],
			fired: { reason: "재시작 사유", at: 5 },
		};
		// the awaited goal is still active, so the condition is unmet; the fired marker alone delivers
		expect(JSON.parse(readFileSync(a.goalFile, "utf8")).goal.status).toBe("active");
		writeFileSync(storePath(env.storeDir, SELF), JSON.stringify({ version: 2, job: fired }));
		const host = newHost();
		await start(host, env);
		await tick(2);

		expect(host.sent).toHaveLength(1);
		expect(host.sent[0]).toContain("재시작 프롬프트");
		expect(host.sent[0]).toContain("예약 실행 사유: 재시작 사유");
		expect(loadStore(env.storeDir, SELF).job).toBeNull();
		await tick(2);
		expect(host.sent).toHaveLength(1);
	});

	test("(j2) a past at fires once at session_start and starts no live interval", async () => {
		const env = makeEnv();
		const past = { id: "past-only", createdAt: 1, prompt: "지나간 시간 프롬프트", groups: [], at: Date.now() - 1000 };
		writeFileSync(storePath(env.storeDir, SELF), JSON.stringify({ version: 2, job: past }));
		const host = newHost();
		await start(host, env);

		expect(host.sent).toHaveLength(1);
		expect(host.sent[0]).toContain("지나간 시간 프롬프트");
		expect(loadStore(env.storeDir, SELF).job).toBeNull();
		expect(jest.getTimerCount()).toBe(0);
	});

	test("(m) without ui.custom the fallback select is used and one picked goal makes a one-goal group", async () => {
		const env = makeEnv();
		const a = writeSession(env, { slug: "--qa-a--", sessionId: "s-a", cwd: "C:/work/qa-a", open: 2 });
		const host = newHost({ noCustom: true, editorText: "폴백 프롬프트", selectPick: (options) => options[0] });
		await start(host, env);

		await command(host, "");
		expect(host.ui.custom).toBeUndefined();
		expect(host.selects[0].title).toBe("대기할 goal");
		expect(host.selects[0].options).toEqual(["qa-a · 목표 · 1분 · 남은 2", TIME_ROW]);
		const job = loadStore(env.storeDir, SELF).job!;
		expect(job.groups).toEqual([[{ sessionId: "s-a", goalId: "g1", goalFile: a.goalFile, label: "qa-a" }]]);
	});

	test("(n) a newer todo record updates the footer open count within one poll", async () => {
		const env = makeEnv();
		const a = writeSession(env, { slug: "--qa-a--", sessionId: "s-a", cwd: "C:/work/qa-a", open: 3 });
		writeSession(env, { slug: "--qa-b--", sessionId: "s-b", cwd: "C:/work/qa-b", open: 2 });
		const host = newHost({ editorText: "todo 프롬프트" });
		await start(host, env);

		await schedule(host, ["&", "\x1b[B", "&", "\r"]);
		await tick();
		expect(status(host)).toBe("⏰ qa-a 남은 3 & qa-b 남은 2");

		appendTodo(a.slugDir, "s-a", 1, 3);
		await tick();
		expect(status(host)).toBe("⏰ qa-a 남은 1 & qa-b 남은 2");
	});

	test("(o) a latched cond keeps its ✓ on restart without re-reading its goal file", async () => {
		const env = makeEnv();
		writeSession(env, { slug: "--qa-a--", sessionId: "s-a", cwd: "C:/work/qa-a", open: 2 });
		const b = writeSession(env, { slug: "--qa-b--", sessionId: "s-b", cwd: "C:/work/qa-b", open: 1 });
		const job = {
			id: "latched",
			createdAt: 1,
			prompt: "래치 프롬프트",
			groups: [
				[
					{ sessionId: "s-a", goalId: "g1", goalFile: join(env.root, "gone", "s-a.json"), label: "qa-a", endedAt: 5, endReason: "qa-a goal 완료" },
					{ sessionId: "s-b", goalId: "g1", goalFile: b.goalFile, label: "qa-b" },
				],
			],
		};
		writeFileSync(storePath(env.storeDir, SELF), JSON.stringify({ version: 2, job }));
		const host = newHost();
		await start(host, env);
		await tick(2);

		expect(status(host)).toBe("⏰ qa-a ✓ & qa-b 남은 1");
		expect(host.sent).toHaveLength(0);
		const stored = JSON.parse(readFileSync(storePath(env.storeDir, SELF), "utf8"));
		expect(stored.job.groups[0][0].endReason).toBe("qa-a goal 완료");
		expect(stored.job.groups[0][0].endedAt).toBe(5);
	});
});

describe("command surface", () => {
	test("(q) a v1 store with three jobs warns that two older reservations went to the extras file", async () => {
		const env = makeEnv();
		const a = writeSession(env, { slug: "--qa-a--", sessionId: "s-a", cwd: "C:/work/qa-a", open: 2 });
		const goal = { sessionId: "s-a", goalId: "g1", goalFile: a.goalFile, label: "qa-a" };
		writeFileSync(
			storePath(env.storeDir, SELF),
			JSON.stringify({
				version: 1,
				jobs: [
					{ id: "one", createdAt: 1, prompt: "첫 예약", goal },
					{ id: "two", createdAt: 2, prompt: "둘째 예약", goal },
					{ id: "three", createdAt: 3, prompt: "셋째 예약", goal },
				],
			}),
		);
		const host = newHost();
		await start(host, env);
		await tick();

		const warning = host.notifies.find((n: { message: string }) => n.message.includes("이전 예약 2건은"));
		expect(warning).toBeDefined();
		expect(warning!.level).toBe("warning");
		expect(warning!.message).toContain(`${SELF}.v1-extra.json`);
		expect(loadStore(env.storeDir, SELF).job!.id).toBe("one");
	});

	test("(r) a prompt starting with / is typed into this session's Orca terminal, not sent as a message", async () => {
		const env = makeEnv();
		const a = writeSession(env, { slug: "--qa-a--", sessionId: "s-a", cwd: "C:/work/qa-a", open: 1 });
		const host = newHost({ editorText: "/skill 지시" });
		await start(host, env);

		const previous = process.env.ORCA_PANE_KEY;
		process.env.ORCA_PANE_KEY = "7:3";
		try {
			host.pi.exec = mock(async (_cmd: string, args: string[]) => {
				if (args[1] === "list") {
					return { code: 0, stdout: JSON.stringify({ result: { terminals: [{ tabId: 7, leafId: 3, handle: "h-1" }, { tabId: 9, leafId: 1, handle: "h-2" }] } }) };
				}
				return { code: 0, stdout: "" };
			});
			await schedule(host, ["\r"], "/skill 지시");
			complete(env, a.goalFile);
			await tick();
			for (let i = 0; i < 10; i++) await Promise.resolve();

			const sends = host.pi.exec.mock.calls.filter((call: any[]) => call[1]?.[1] === "send");
			expect(sends).toHaveLength(1);
			const sentArgs = sends[0][1] as string[];
			expect(sentArgs.slice(0, 4)).toEqual(["terminal", "send", "--terminal", "h-1"]);
			expect(sentArgs[4]).toBe("--text");
			expect(sentArgs[5]).toContain("(예약 실행 사유: ");
			expect(sentArgs.slice(6)).toEqual(["--enter", "--json"]);
			expect(host.pi.sendUserMessage).not.toHaveBeenCalled();
			expect(host.sent).toHaveLength(0);
		} finally {
			if (previous === undefined) delete process.env.ORCA_PANE_KEY;
			else process.env.ORCA_PANE_KEY = previous;
		}
	});

	test("(s) the /after handler refuses a session without a stored session id", async () => {
		const env = makeEnv();
		const host = newHost();
		createAfterGoal({ sessionsDir: env.sessionsDir, storeDir: env.storeDir, pollMs: POLL, retryMs: RETRY })(host.pi);
		host.ctx.sessionManager.getSessionId = () => undefined;
		await fire(host, "session_start", host.ctx);

		await command(host, "now");
		expect(host.notifies.at(-1)).toEqual({ message: "저장된 세션에서만 쓸 수 있습니다", level: "error" });
		expect(host.sent).toHaveLength(0);
	});

	test("(t) /after now with no reservation notifies that there is nothing to run", async () => {
		const env = makeEnv();
		const host = newHost();
		await start(host, env);

		await command(host, "now");
		expect(host.notifies.at(-1)).toEqual({ message: "예약된 작업이 없습니다", level: "info" });
		expect(host.sent).toHaveLength(0);
	});
});

describe("held delivery", () => {
	async function held(env: Env, host: Host) {
		const a = writeSession(env, { slug: "--qa-a--", sessionId: "s-a", cwd: "C:/work/qa-a", open: 1 });
		await start(host, env);
		await schedule(host, ["\r"]);
		const id = loadStore(env.storeDir, SELF).job!.id;
		complete(env, a.goalFile);
		await tick(3);
		return id;
	}

	test("(k1) a fired job waits in the store while busy, survives a declined replace, then delivers once", async () => {
		const env = makeEnv();
		const host = newHost({ isIdle: false, editorText: "보류 프롬프트" });
		const id = await held(env, host);

		expect(host.sent).toHaveLength(0);
		const stored = loadStore(env.storeDir, SELF).job!;
		expect(stored.id).toBe(id);
		expect(stored.fired?.reason).toBe("qa-a goal 완료");
		expect(status(host)).toBe("⏰ 실행 대기");

		host.confirmAnswer = (title: string) => title !== "예약 바꾸기";
		await command(host, "");
		expect(host.confirms.at(-1)!.title).toBe("예약 바꾸기");
		expect(host.confirms.at(-1)!.message).toContain("실행 대기 중: qa-a goal 완료");
		expect(loadStore(env.storeDir, SELF).job!.fired).toBeDefined();

		host.isIdle = true;
		host.confirmAnswer = true;
		await fire(host, "agent_settled", host.ctx);
		expect(host.sent).toHaveLength(1);
		expect(loadStore(env.storeDir, SELF).job).toBeNull();
		await tick(2);
		expect(host.sent).toHaveLength(1);
	});

	test("(p) /after now on a fired held job delivers it once with its original reason", async () => {
		const env = makeEnv();
		const host = newHost({ isIdle: false, editorText: "보류 강제 프롬프트" });
		const id = await held(env, host);
		const stored = loadStore(env.storeDir, SELF).job!;
		expect(stored.id).toBe(id);
		expect(stored.fired?.reason).toBe("qa-a goal 완료");
		expect(host.sent).toHaveLength(0);

		await command(host, "now");
		expect(host.sent).toHaveLength(0);
		expect(loadStore(env.storeDir, SELF).job!.id).toBe(id);

		host.isIdle = true;
		await fire(host, "agent_settled", host.ctx);
		expect(host.sent).toHaveLength(1);
		expect(host.sent[0]).toContain("보류 강제 프롬프트");
		expect(host.sent[0]).toContain("예약 실행 사유: qa-a goal 완료");
		expect(loadStore(env.storeDir, SELF).job).toBeNull();
		await tick(2);
		expect(host.sent).toHaveLength(1);
	});

	test("(k2) a held job cancelled from the footer never delivers", async () => {
		const env = makeEnv();
		const host = newHost({ isIdle: false, editorText: "보류 취소" });
		const id = await held(env, host);
		expect(loadStore(env.storeDir, SELF).job!.id).toBe(id);

		await command(host, "cancel");
		expect(host.confirms.at(-1)!.message).toContain("실행 대기 중: qa-a goal 완료");
		expect(loadStore(env.storeDir, SELF).job).toBeNull();
		expect(status(host)).toBeUndefined();

		host.isIdle = true;
		await fire(host, "agent_settled", host.ctx);
		await tick(3);
		expect(host.sent).toHaveLength(0);
	});
});
