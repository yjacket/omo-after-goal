// Real-TUI QA harness: runs omo in a PTY with only the extensions under test (plus --ext),
// drives it with steps, and snapshots the screen through xterm.js in headless Chrome.
//
// Adaptations from omo-status-arrange/qa/tui-qa.mjs:
//   --agent-dir <dir>     sets BOTH OMO_CODING_AGENT_DIR and SENPI_CODING_AGENT_DIR
//   --session             keep omo's session (drops --no-session)
//   --keep-extensions     load the installed packages/extensions (omits --no-extensions and every -e)
//   the child env drops ORCA_PANE_KEY so a delivered prompt can never be typed into a real terminal
//   {"expect": text} / {"expectNot": text}   check the most recent shot's .txt; append
//                                            PASS|FAIL <shot> <text> to <out>/summary.txt; any FAIL exits 1
//   {"exec": ["bun", "qa/fake-sessions.mjs", ...]}  run synchronously with cwd = repo, fail the run on a
//                                            non-zero exit, and move the waitNew mark to the current output
//                                            position BEFORE running (like send), so a following waitNew
//                                            waits for the state change the fixture caused. {agentDir} in an
//                                            argument is replaced with the resolved --agent-dir.
// steps: {"wait": text} (anywhere in output), {"waitNew": text} (after the last send/exec), {"idle": ms},
//        {"send": keys}, {"shot": name}, {"mark": label}, {"rm": path}, {"exec": [...]},
//        {"expect": text}, {"expectNot": text}
// usage: bun qa/tui-qa.mjs --cwd <dir> --steps <json> --out <dir> [--cols N] [--rows N] [--editor <cmd>]
//        [--timeout <s>=120] [--agent-dir <dir>] [--ext <file>[;<file>...]] [--session] [--keep-extensions]
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const OMO_JS = process.env.QA_OMO_JS || "C:/Users/yjack/.bun/install/global/node_modules/omo-ai/bin/omo.js";
const CHROME = process.env.QA_CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const XTERM = "https://cdn.jsdelivr.net/npm/@xterm/xterm@6.0.0/";

const repo = resolve(import.meta.dirname, "..");
const args = {};
for (let i = 2; i < process.argv.length; i++) {
	const a = process.argv[i];
	if (!a.startsWith("--")) continue;
	const name = a.slice(2);
	if (name === "session" || name === "keep-extensions") args[name] = true;
	else args[name] = process.argv[++i];
}
const cols = Number(args.cols ?? 150);
const rows = Number(args.rows ?? 45);
const timeoutMs = Number(args.timeout ?? 120) * 1000;
const out = resolve(args.out ?? ".omo/evidence/qa");
const agentDir = args["agent-dir"] ? resolve(args["agent-dir"]) : undefined;

class Fail extends Error {}
const fail = (m) => {
	throw new Fail(m);
};

const stripAnsi = (s) =>
	s
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\x1b[()][A-Z0-9]/g, "")
		.replace(/\x1b[@-Z\\-_=>]/g, "")
		.replace(/\r/g, "");

const killTree = (pid) => {
	if (!pid) return;
	try {
		Bun.spawnSync(["taskkill", "/PID", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" });
	} catch {}
};

// ---- state to clean up
let proc = null, chrome = null, server = null, profile = null, browserWs = null;
let cleaned = false;
const cleanup = async () => {
	if (cleaned) return;
	cleaned = true;
	try { browserWs?.send(JSON.stringify({ id: 9999, method: "Browser.close" })); } catch {}
	try { browserWs?.close(); } catch {}
	killTree(proc?.pid);
	killTree(chrome?.pid);
	try { await Promise.all([proc?.exited, chrome?.exited].filter(Boolean)); } catch {}
	try { server?.stop(true); } catch {}
	if (profile) {
		try { rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch {}
	}
	console.log(`omo pid ${proc?.pid ?? "none"} / chrome pid ${chrome?.pid ?? "none"} stopped`);
};

// ---- PTY output
const chunks = [];
let plain = "";
let sendMark = 0; // plain.length at the last send/exec; waitNew only searches output after it
let lastData = performance.now();
const decoder = new TextDecoder();
let omoExited = null;
const watchers = new Set();
const notify = () => {
	for (const w of [...watchers]) w();
};

const waitFor = (text, ms, from = 0) =>
	new Promise((res, rej) => {
		let timer;
		const check = () => {
			if (plain.indexOf(text, from) !== -1) { done(); res(); }
			else if (omoExited !== null) { done(); rej(new Fail(`omo exited (code ${omoExited}) while waiting for "${text}"`)); }
		};
		const done = () => { clearTimeout(timer); watchers.delete(check); };
		watchers.add(check);
		timer = setTimeout(() => { done(); rej(new Fail(`timeout ${ms}ms waiting for "${text}"`)); }, ms);
		check();
	});

// Resolves once no PTY output arrived for quietMs (the TUI finished redrawing), bounded by ms.
const waitIdle = (quietMs, ms) =>
	new Promise((res, rej) => {
		const end = performance.now() + ms;
		const tick = () => {
			const now = performance.now();
			if (now - lastData >= quietMs) return res();
			if (now > end) return rej(new Fail(`output never went quiet for ${quietMs}ms`));
			setTimeout(tick, Math.min(quietMs, Math.max(10, quietMs - (now - lastData))));
		};
		tick();
	});

// ---- Chrome / CDP
let cdpSeq = 0;
const pending = new Map();
let sessionId = null;
const cdp = (method, params = {}, withSession = true) =>
	new Promise((res, rej) => {
		const id = ++cdpSeq;
		pending.set(id, { res, rej });
		const msg = { id, method, params };
		if (withSession && sessionId) msg.sessionId = sessionId;
		browserWs.send(JSON.stringify(msg));
	});
const evalJs = async (expression, awaitPromise = false) => {
	const r = await cdp("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
	if (r.exceptionDetails) fail("page eval failed: " + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
	return r.result.value;
};
const until = async (fn, ms, what) => {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await fn()) return;
		await new Promise((r) => setTimeout(r, 50));
	}
	fail(`timeout waiting for ${what}`);
};

const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${XTERM}css/xterm.css">
<script src="${XTERM}lib/xterm.js"></script>
<style>html,body{margin:0;background:#000}#t{display:inline-block}</style></head>
<body><div id="t"></div><script>
window.term = new Terminal({cols:${cols},rows:${rows},fontSize:14,scrollback:0,allowProposedApi:true,fontFamily:"Consolas, 'Malgun Gothic', monospace"});
term.open(document.getElementById("t"));
window.__ready = true;
</script></body></html>`;

async function ensureBrowser() {
	if (browserWs) return;
	profile = mkdtempSync(join(tmpdir(), "after-goal-qa-chrome-"));
	server = Bun.serve({ port: 0, fetch: () => new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } }) });
	chrome = Bun.spawn([CHROME, "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
		"--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=2400,1600", "about:blank"],
		{ stdout: "ignore", stderr: "ignore" });
	console.log(`chrome pid ${chrome.pid}`);
	const portFile = join(profile, "DevToolsActivePort");
	// Chrome replaces the file while writing it, so a read can briefly fail with ENOENT after existsSync said yes.
	const readPort = () => {
		try {
			return readFileSync(portFile, "utf8");
		} catch {
			return "";
		}
	};
	await until(() => readPort().split("\n").length >= 2, 30000, "DevToolsActivePort");
	const [port, path] = readPort().trim().split("\n");
	browserWs = new WebSocket(`ws://127.0.0.1:${port}${path}`);
	await new Promise((res, rej) => { browserWs.onopen = res; browserWs.onerror = () => rej(new Fail("CDP websocket error")); });
	browserWs.onmessage = (ev) => {
		const m = JSON.parse(ev.data);
		const p = m.id && pending.get(m.id);
		if (!p) return;
		pending.delete(m.id);
		m.error ? p.rej(new Fail("CDP " + m.error.message)) : p.res(m.result);
	};
	const { targetId } = await cdp("Target.createTarget", { url: `http://127.0.0.1:${server.port}/` }, false);
	({ sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true }, false));
	await cdp("Runtime.enable");
	await until(async () => (await evalJs("window.__ready === true").catch(() => false)), 30000, "xterm page (CDN reachable?)");
}

async function shot(name) {
	await ensureBrowser();
	const bytes = Buffer.concat(chunks);
	writeFileSync(join(out, `${name}.ansi`), bytes);
	await evalJs(`term.reset(); new Promise(r => term.write(Uint8Array.from(atob(${JSON.stringify(bytes.toString("base64"))}), c => c.charCodeAt(0)), r))`, true);
	const text = await evalJs(`(() => { const b = term.buffer.active, l = []; for (let i = 0; i < b.length; i++) l.push(b.getLine(i).translateToString(true)); return l.join("\\n"); })()`);
	writeFileSync(join(out, `${name}.txt`), text);
	const rect = await evalJs(`(() => { const r = document.getElementById("t").getBoundingClientRect(); return {x:r.x,y:r.y,width:Math.ceil(r.width),height:Math.ceil(r.height)}; })()`);
	const { data } = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { ...rect, scale: 1 } });
	writeFileSync(join(out, `${name}.png`), Buffer.from(data, "base64"));
}

// Runs a fixture command synchronously in the repo, failing the run on a non-zero exit.
function execStep(argv) {
	const [command, ...rest] = argv.map((a) => String(a).replaceAll("{agentDir}", agentDir ?? ""));
	const result = Bun.spawnSync([command, ...rest], {
		cwd: repo,
		env: { ...process.env, QA_AGENT_DIR: agentDir ?? "" },
		stdout: "pipe",
		stderr: "pipe",
	});
	const output = `${result.stdout?.toString() ?? ""}${result.stderr?.toString() ?? ""}`.trim();
	if (output) console.log(output);
	if (result.exitCode !== 0) fail(`exec failed (exit ${result.exitCode}): ${argv.join(" ")}`);
}

// ---- main
let lastShot = null;
let anyFail = false;

async function main() {
	if (!args.cwd || !args.steps) fail("--cwd and --steps are required");
	const steps = JSON.parse(readFileSync(resolve(args.steps), "utf8"));
	mkdirSync(out, { recursive: true });
	writeFileSync(join(out, "summary.txt"), "");

	// --no-extensions drops discovered and package extensions but keeps omo's builtins, so only the
	// --ext files under test add to the footer. --keep-extensions instead loads the installed ones.
	const cmd = ["bun", OMO_JS];
	if (!args.session) cmd.push("--no-session");
	if (!args["keep-extensions"]) {
		cmd.push("--no-extensions");
		if (args.ext) for (const ext of args.ext.split(";").filter(Boolean)) cmd.push("-e", resolve(ext));
	}
	const env = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" };
	delete env.ORCA_PANE_KEY; // never type a delivered prompt into the orchestrator's own terminal
	if (agentDir) {
		env.OMO_CODING_AGENT_DIR = agentDir;
		env.SENPI_CODING_AGENT_DIR = agentDir;
	}
	if (args.editor) env.VISUAL = args.editor;

	proc = Bun.spawn(cmd, {
		cwd: resolve(args.cwd),
		env,
		terminal: {
			cols,
			rows,
			data(_t, data) {
				chunks.push(Buffer.from(data));
				plain += stripAnsi(decoder.decode(data, { stream: true }));
				lastData = performance.now();
				notify();
			},
		},
	});
	console.log(`omo pid ${proc.pid}`);
	console.log(`agent dir ${agentDir ?? "(omo default)"}`);
	proc.exited.then((c) => { omoExited = c; notify(); });

	const timing = { sends: [], marks: [] };
	const t0 = performance.now();
	let lastSend = null;
	const settled = (text) => {
		if (!lastSend) return;
		timing.sends.push({ send: lastSend.text, wait: text, ms: Math.round(performance.now() - lastSend.t) });
		lastSend = null;
	};
	for (const step of steps) {
		if ("wait" in step) {
			await waitFor(step.wait, timeoutMs);
			settled(step.wait);
		} else if ("waitNew" in step) {
			await waitFor(step.waitNew, timeoutMs, sendMark);
			settled(step.waitNew);
		} else if ("rm" in step) {
			rmSync(resolve(step.rm), { recursive: true, force: true });
		} else if ("idle" in step) {
			await waitIdle(Number(step.idle), timeoutMs);
		} else if ("send" in step) {
			sendMark = plain.length;
			lastData = performance.now(); // idle counts quiet time from the keypress, not from older output
			lastSend = { text: step.send, t: performance.now() };
			proc.terminal.write(step.send);
		} else if ("exec" in step) {
			if (!Array.isArray(step.exec) || step.exec.length === 0) fail("exec needs a non-empty array");
			sendMark = plain.length; // a following waitNew must only see what this fixture command causes
			lastSend = { text: `exec ${step.exec.join(" ")}`, t: performance.now() };
			execStep(step.exec);
		} else if ("expect" in step || "expectNot" in step) {
			if (!lastShot) fail("expect/expectNot needs an earlier shot");
			const text = String("expect" in step ? step.expect : step.expectNot);
			const body = readFileSync(join(out, `${lastShot}.txt`), "utf8");
			const found = body.includes(text);
			const ok = "expect" in step ? found : !found;
			if (!ok) anyFail = true;
			appendFileSync(join(out, "summary.txt"), `${ok ? "PASS" : "FAIL"} ${lastShot} ${text}\n`);
			console.log(`${ok ? "PASS" : "FAIL"} ${lastShot} ${text}`);
		} else if ("shot" in step) {
			await shot(step.shot);
			lastShot = step.shot;
		} else if ("mark" in step) {
			timing.marks.push({ label: step.mark, ms: Math.round(performance.now() - t0) });
		} else fail("unknown step " + JSON.stringify(step));
	}
	writeFileSync(join(out, "timing.json"), JSON.stringify(timing, null, 2));
	if (anyFail) fail(`summary.txt has FAIL lines (${join(out, "summary.txt")})`);
}

let code = 0;
try {
	await main();
	await cleanup();
	console.log(`QA_DONE ${out}`);
} catch (e) {
	try { writeFileSync(join(out, "failure-tail.txt"), plain.slice(-4000)); } catch {}
	await cleanup();
	console.log(`QA_FAIL ${e instanceof Fail ? e.message : e?.stack ?? e}`);
	code = 1;
}
process.exit(code);
