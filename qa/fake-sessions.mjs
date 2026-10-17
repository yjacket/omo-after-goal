// qa/fake-sessions.mjs: create and drive the fake "waited sessions" that qa/tui-qa.mjs runs against.
//
// A fake session is a session slug under <agentDir>/sessions whose shape omo itself writes:
//   <agentDir>/sessions/--qa-<name>--/session-holders/<sessionId>/<pid>.json   (a live keeper process)
//   <agentDir>/sessions/--qa-<name>--/extensions/goal/<sessionId>.json         (the awaited goal)
//   <agentDir>/sessions/--qa-<name>--/<timestamp>_<sessionId>.jsonl            (todo records)
// The keeper is `bun -e "setInterval(()=>{},1e9)"`; its pid is recorded in <agentDir>/qa-keepers.json
// so cleanup can always kill it. Scripts never touch the real agent dir unless it is passed explicitly
// (and the real agent dir is refused outright).
//
// usage:
//   bun qa/fake-sessions.mjs create <agentDir> <name> [--open N] [--total M] [--seconds S]
//   bun qa/fake-sessions.mjs todo   <agentDir> <name> [--open N] [--total M]   (appends a newer record)
//   bun qa/fake-sessions.mjs finish <agentDir> <name>                          (goal status complete)
//   bun qa/fake-sessions.mjs kill   <agentDir> <name>                          (kills that keeper)
//   bun qa/fake-sessions.mjs cleanup <agentDir>                                (kills every keeper, removes every --qa-* slug)
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const KEEPERS = "qa-keepers.json";
const SLUG_PREFIX = "--qa-";

const command = process.argv[2];
const agentDirRaw = process.argv[3];
const name = process.argv[4];
const flags = {};
for (let i = 5; i < process.argv.length; i++) {
	const a = process.argv[i];
	if (a.startsWith("--")) flags[a.slice(2)] = process.argv[++i];
}

function usage() {
	console.error("usage: bun qa/fake-sessions.mjs <create|todo|finish|kill|cleanup> <agentDir> [name] [--open N] [--total M] [--seconds S]");
	process.exit(1);
}
if (!command || !agentDirRaw) usage();
if (command !== "cleanup" && !name) usage();

const agentDir = resolve(agentDirRaw);
const realAgentDir = join(homedir(), ".omo", "agent");
if (agentDir === realAgentDir || agentDir === join(homedir(), ".omo") || agentDir.startsWith(`${join(homedir(), ".omo")}\\`)) {
	console.error(`refusing the real OMO dir: ${agentDir} (pass a temp dir instead)`);
	process.exit(1);
}

const sessionsDir = join(agentDir, "sessions");
const keepersPath = join(agentDir, KEEPERS);
const slugDirOf = (n) => join(sessionsDir, `${SLUG_PREFIX}${n}--`);

function isAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code === "EPERM";
	}
}

function taskkill(pid) {
	try {
		Bun.spawnSync(["taskkill", "/PID", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" });
	} catch {}
}

/** Waits (bounded) for a killed pid to be gone, so a printed check is not a lie. */
async function goneWithin(pid, ms = 5000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (!isAlive(pid)) return true;
		await Bun.sleep(25);
	}
	return !isAlive(pid);
}

function loadKeepers() {
	try {
		const parsed = JSON.parse(readFileSync(keepersPath, "utf8"));
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function saveKeepers(list) {
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(keepersPath, `${JSON.stringify(list, null, 2)}\n`);
}

const find = (record) => loadKeepers().find((r) => r.name === record);
const fail = (message) => {
	console.error(message);
	process.exit(1);
};

const missing = (what, record) =>
	fail(`${what}: no fake session named ${record} in ${agentDir} (known: ${loadKeepers().map((r) => r.name).join(", ") || "none"})`);

function tasks(open, total) {
	return Array.from({ length: total }, (_, i) => ({
		content: `QA task ${i + 1}`,
		status: i < open ? (i === 0 ? "in_progress" : "pending") : "completed",
	}));
}

function todoLine(open, total) {
	return JSON.stringify({ type: "custom", customType: "senpi.todo-state", data: { schema: "v2", phases: [{ name: "QA", tasks: tasks(open, total) }] } });
}

function appendTodo(record, open, total) {
	writeFileSync(record.jsonlFile, `${readFileSync(record.jsonlFile, "utf8").replace(/\n?$/, "\n")}${todoLine(open, total)}\n`);
}

function create() {
	const open = Number(flags.open ?? 0);
	const total = Number(flags.total ?? 3);
	const seconds = Number(flags.seconds ?? 600 - loadKeepers().length * 100);
	const slugDir = slugDirOf(name);
	const sessionId = randomUUID();
	const goalId = randomUUID();
	// detached: on Windows a plain child dies with this script, and the holder needs a pid that is
	// still alive while omo runs (the whole point of the fixture).
	const keeper = Bun.spawn([Bun.which("bun") ?? "bun", "-e", "setInterval(()=>{},1e9)"], { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
	keeper.unref();
	const pid = keeper.pid;
	const now = Date.now();

	const holderDir = join(slugDir, "session-holders", sessionId);
	mkdirSync(holderDir, { recursive: true });
	writeFileSync(join(holderDir, `${pid}.json`), `${JSON.stringify({ pid, bootAtMs: now, processStartedAtMs: now, cwd: `C:\\qa\\qa-${name}` }, null, 2)}\n`);

	const goalFile = join(slugDir, "extensions", "goal", `${sessionId}.json`);
	mkdirSync(join(slugDir, "extensions", "goal"), { recursive: true });
	writeFileSync(goalFile, `${JSON.stringify({ version: 1, goal: { id: goalId, objective: `QA ${name} 작업`, status: "active", timeUsedSeconds: seconds } }, null, 2)}\n`);

	const jsonlFile = join(slugDir, `${now}_${sessionId}.jsonl`);
	writeFileSync(jsonlFile, `${todoLine(open, total)}\n`);

	const record = { name, sessionId, goalId, pid, slug: `${SLUG_PREFIX}${name}--`, slugDir, goalFile, jsonlFile, createdAt: now };
	saveKeepers([...loadKeepers().filter((r) => r.name !== name), record]);
	if (!isAlive(pid)) fail(`keeper for ${name} died immediately (pid ${pid})`);
	console.log(`create ${name}: session ${sessionId}, keeper pid ${pid} alive=${isAlive(pid)}, goal ${goalFile}`);
	console.log(`create ${name}: todo open ${open}/${total}, cwd C:\\qa\\qa-${name}`);
}

function todo() {
	const record = find(name) ?? missing("todo", name);
	if (!existsSync(record.jsonlFile)) fail(`todo: ${record.jsonlFile} is missing`);
	appendTodo(record, Number(flags.open ?? 0), Number(flags.total ?? 3));
	console.log(`todo ${name}: appended open ${flags.open ?? 0}/${flags.total ?? 3} to ${record.jsonlFile}`);
}

function finish() {
	const record = find(name) ?? missing("finish", name);
	const file = JSON.parse(readFileSync(record.goalFile, "utf8"));
	file.goal.status = "complete";
	writeFileSync(record.goalFile, `${JSON.stringify(file, null, 2)}\n`);
	console.log(`finish ${name}: goal ${record.goalId} status=complete`);
}

async function kill() {
	const record = find(name) ?? missing("kill", name);
	taskkill(record.pid);
	const gone = await goneWithin(record.pid);
	console.log(`kill ${name}: keeper pid ${record.pid} alive=${gone ? "false" : "true"}`);
	if (!gone) process.exit(1);
}

async function cleanup() {
	const keepers = loadKeepers();
	const pids = keepers.map((r) => r.pid);
	// Belt and braces: also pick up holder pids from the slugs themselves, in case qa-keepers.json is stale.
	const slugs = existsSync(sessionsDir) ? readdirSync(sessionsDir).filter((slug) => slug.startsWith(SLUG_PREFIX)) : [];
	for (const slug of slugs) {
		const holders = join(sessionsDir, slug, "session-holders");
		for (const sessionId of existsSync(holders) ? readdirSync(holders) : []) {
			for (const file of readdirSync(join(holders, sessionId))) {
				const pid = Number(file.replace(/\.json$/, ""));
				if (pid > 0) pids.push(pid);
			}
		}
	}
	for (const pid of [...new Set(pids)]) taskkill(pid);

	let alive = 0;
	for (const pid of [...new Set(pids)]) if (!(await goneWithin(pid))) alive++;

	for (const slug of slugs) rmSync(join(sessionsDir, slug), { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	rmSync(keepersPath, { force: true });

	const leftSlugs = existsSync(sessionsDir) ? readdirSync(sessionsDir).filter((slug) => slug.startsWith(SLUG_PREFIX)) : [];
	console.log(`cleanup: keepers checked ${[...new Set(pids)].length} stopped=${[...new Set(pids)].length - alive}, still alive ${alive}`);
	console.log(`cleanup: --qa- slugs left ${leftSlugs.length}${leftSlugs.length ? ` (${leftSlugs.join(", ")})` : ""}`);
	console.log(`cleanup: qa-keepers.json removed=${!existsSync(keepersPath) && !existsSync(join(agentDir, KEEPERS))} agentDir=${agentDir}`);
	if (alive > 0 || leftSlugs.length > 0) {
		console.error("cleanup: leftovers remain");
		process.exit(1);
	}
}

switch (command) {
	case "create": create(); break;
	case "todo": todo(); break;
	case "finish": finish(); break;
	case "kill": await kill(); break;
	case "cleanup": await cleanup(); break;
	default: usage();
}
