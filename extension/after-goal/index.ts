// after-goal: run a prompt in this session when another running session's goal
// ends, or when a given time passes, whichever comes first.
// Prompts that start with "/" (skills, commands) are typed into this session's
// Orca terminal, because omo ignores extension-sourced input when it decides
// whether the user requested a skill (the ulw-plan plan gate, for example).
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fireReason, latch, satisfiedGroup, toConds, triggerSummary } from "./conditions.ts";
import { labelSessions } from "./labels.ts";
import { ConditionPicker, rowLabel } from "./picker.ts";
import { goalEndReason, listRunningGoals, snapshot } from "./sessions.ts";
import { statusText } from "./status.ts";
import { loadStore, saveStore } from "./store.ts";
import { firstLine } from "./text.ts";
import { formatClock, parseWhen } from "./time.ts";
import { STATUS_KEY, plainPaint } from "./types.ts";
import type { Job, Paint, PickResult, RunningGoal, SessionSnapshot } from "./types.ts";

type Options = {
	sessionsDir: string;
	storeDir: string;
	pollMs?: number;
	retryMs?: number;
};

const ORCA_TEXT_LIMIT = 1500;

function uniqueLabels(labels: string[]): string[] {
	const seen = new Map<string, number>();
	return labels.map((label) => {
		const n = (seen.get(label) ?? 0) + 1;
		seen.set(label, n);
		return n === 1 ? label : `${label} (${n})`;
	});
}

export function createAfterGoal(options: Options) {
	const pollMs = options.pollMs ?? 3000;
	const retryMs = options.retryMs ?? 5000;

	return function afterGoal(pi: any) {
		let ctx: any;
		let selfId: string | undefined;
		// The one reservation of this session: a fired job keeps the slot until delivery starts.
		let job: Job | null = null;
		let snaps: ReadonlyMap<string, SessionSnapshot> = new Map();
		let lastStatus: string | undefined;
		let atTimer: ReturnType<typeof setTimeout> | undefined;
		let pollTimer: ReturnType<typeof setInterval> | undefined;
		let retryTimer: ReturnType<typeof setTimeout> | undefined;
		let flushing = false;
		let heldNoticeShown = false;

		function save() {
			if (!selfId) return;
			saveStore(options.storeDir, selfId, job);
		}

		function paint(): Paint {
			const theme = ctx?.ui?.theme;
			if (!theme) return plainPaint;
			return {
				ok: (s: string) => theme.fg("success", s),
				warn: (s: string) => theme.fg("warning", s),
				dim: (s: string) => theme.fg("dim", s),
			};
		}

		function updateStatus() {
			const text = statusText(job, snaps, { paint: paint() });
			if (text === lastStatus) return;
			lastStatus = text;
			try {
				ctx?.ui?.setStatus?.(STATUS_KEY, text);
			} catch {}
		}

		function disarm() {
			if (atTimer) clearTimeout(atTimer);
			atTimer = undefined;
			if (pollTimer) clearInterval(pollTimer);
			pollTimer = undefined;
		}

		function refresh() {
			try {
				if (!job || job.fired) return;
				const current = job;
				const map = new Map<string, SessionSnapshot>();
				for (const group of current.groups) {
					for (const cond of group) {
						if (cond.endedAt !== undefined || map.has(cond.sessionId)) continue;
						map.set(cond.sessionId, snapshot(cond));
					}
				}
				snaps = map;
				const changed = latch(current, (cond) => goalEndReason(cond, map.get(cond.sessionId)?.alive ?? false), Date.now());
				if (changed) save();
				const group = satisfiedGroup(current);
				if (group) {
					trigger(fireReason(group));
					return;
				}
				updateStatus();
			} catch {}
		}

		function armTime() {
			if (!job || job.at === undefined) return;
			const current = job;
			const delay = current.at! - Date.now();
			if (delay <= 0) {
				trigger(`예약 시간 ${formatClock(current.at!)} 도달`);
				return;
			}
			// setTimeout overflows above ~24.8 days; re-arm in steps. A throw must never escape the timer.
			atTimer = setTimeout(() => {
				try {
					armTime();
				} catch {}
			}, Math.min(delay, 2 ** 31 - 1));
		}

		function arm() {
			if (!job) return;
			const armed = job;
			armTime();
			// A past `at` fires the job inside armTime; no poll interval may outlive it.
			if (job !== armed || job.fired) return;
			if (!pollTimer) {
				pollTimer = setInterval(refresh, pollMs);
				pollTimer.unref?.();
			}
			refresh();
		}

		function trigger(reason: string) {
			if (!job || job.fired) return;
			disarm();
			job.fired = { reason, at: Date.now() };
			// A failed save keeps the fired slot in memory: only restart safety is lost, not the delivery.
			try {
				save();
			} catch {}
			updateStatus();
			void flush();
		}

		function deliveryText(job: Job, reason: string): string {
			return `${job.prompt.trim()}\n\n[after-goal] 예약 실행 사유: ${reason}`;
		}

		// Text typed into the terminal must be one line; long or multi-line prompts go through a file.
		function terminalText(job: Job, reason: string): string {
			const prompt = job.prompt.trim();
			if (!/\r?\n/.test(prompt) && prompt.length <= ORCA_TEXT_LIMIT) return `${prompt} (예약 실행 사유: ${reason})`;
			const dir = join(options.storeDir, "prompts");
			mkdirSync(dir, { recursive: true });
			const file = join(dir, `${job.id}.md`);
			writeFileSync(file, `${deliveryText(job, reason)}\n`);
			const head = prompt.split(/\r?\n/)[0].trim().slice(0, 300);
			return `${head} 전체 지시는 ${file} 파일을 읽고 따르라. (예약 실행 사유: ${reason})`;
		}

		async function sendViaOrca(text: string): Promise<string | undefined> {
			const pane = process.env.ORCA_PANE_KEY;
			if (!pane) return "Orca 터미널이 아님";
			const list = await pi.exec("orca", ["terminal", "list", "--json"], { timeout: 15_000 });
			if (list.code !== 0) return `orca terminal list 실패: ${list.stderr || list.stdout}`;
			let handle: string | undefined;
			try {
				const terminals = JSON.parse(list.stdout)?.result?.terminals ?? [];
				handle = terminals.find((t: any) => `${t.tabId}:${t.leafId}` === pane)?.handle;
			} catch {}
			if (!handle) return "이 세션의 Orca 터미널을 찾지 못함";
			const sent = await pi.exec("orca", ["terminal", "send", "--terminal", handle, "--text", text, "--enter", "--json"], { timeout: 120_000 });
			if (sent.killed) return "ambiguous";
			return sent.code === 0 ? undefined : `orca terminal send 실패: ${sent.stderr || sent.stdout}`;
		}

		function canDeliver(): boolean {
			if (!ctx) return false;
			if (typeof ctx.isIdle === "function" && !ctx.isIdle()) return false;
			if (typeof ctx.hasPendingMessages === "function" && ctx.hasPendingMessages()) return false;
			const draft = typeof ctx.ui?.getEditorText === "function" ? ctx.ui.getEditorText() : "";
			if (draft && draft.trim() !== "") {
				if (!heldNoticeShown) ctx.ui?.notify?.("예약 작업 대기 중: 입력창이 비면 실행합니다", "info");
				heldNoticeShown = true;
				return false;
			}
			return true;
		}

		function errorText(error: unknown): string {
			return error instanceof Error ? error.message : String(error);
		}

		// ctx can disappear between an await and the notify that follows it (shutdown); a notify never throws.
		function notify(text: string, level: string) {
			try {
				ctx?.ui?.notify?.(text, level);
			} catch {}
		}

		// Nothing was delivered: the fired job goes back to its own session's slot, so that session's next start
		// delivers it once. It never lands in another session or over a reservation made meanwhile.
		function giveBack(current: Job, owner: string | undefined) {
			try {
				if (selfId === owner && job === null) {
					job = current;
					updateStatus();
					save();
				} else if (owner && selfId !== owner) {
					saveStore(options.storeDir, owner, current);
				}
			} catch {}
		}

		async function flush() {
			if (flushing) return;
			flushing = true;
			try {
				const current = job;
				if (!current || !current.fired) return;
				if (!canDeliver()) {
					if (!retryTimer) {
						retryTimer = setTimeout(() => {
							retryTimer = undefined;
							void flush();
						}, retryMs);
					}
					return;
				}
				heldNoticeShown = false;
				const reason = current.fired.reason;
				// session_start may swap selfId and job during the Orca await below
				const owner = selfId;
				job = null;
				// Clear first, then persist: at most once. A failing save only costs restart safety.
				try {
					save();
				} catch {}
				updateStatus();
				if (current.prompt.trimStart().startsWith("/")) {
					let failure: string | undefined;
					try {
						failure = await sendViaOrca(terminalText(current, reason));
					} catch (error) {
						// a thrown send (spawn ENOENT, an unwritable prompt file) is the same as a reported failure
						failure = errorText(error);
					}
					if (failure === undefined) {
						notify(`예약 실행: ${reason}`, "info");
						return;
					}
					if (failure === "ambiguous") {
						notify(`터미널 입력 응답이 없어 다시 보내지 않았습니다: ${reason}`, "warning");
						return;
					}
					notify(`터미널 입력 실패(${failure}), 확장 메시지로 보냅니다. 사용자 전용 스킬 게이트는 열리지 않을 수 있습니다`, "warning");
				}
				if (selfId !== owner) {
					// The session switched during the Orca await: a fallback message would land in the new session.
					giveBack(current, owner);
					notify("세션이 바뀌어 예약을 원래 세션으로 되돌렸습니다", "warning");
					return;
				}
				try {
					pi.sendUserMessage(deliveryText(current, reason), { expandPromptTemplates: true });
				} catch (error) {
					giveBack(current, owner);
					notify(`예약 전달 실패: ${errorText(error)}`, "warning");
					return;
				}
				notify(`예약 실행: ${reason}`, "info");
			} catch {
				// flush is fire-and-forget; a throw here would surface as an unhandled rejection
			} finally {
				flushing = false;
			}
		}

		async function schedule(cmdCtx: any) {
			const ui = cmdCtx?.ui ?? {};
			if (job) {
				const held = job.fired ? `실행 대기 중: ${job.fired.reason}` : triggerSummary(job);
				const ok = await ui.confirm("예약 바꾸기", `${held}\n${firstLine(job.prompt, 80)}\n\n새로 예약하면 지금 예약은 지워집니다`);
				if (!ok) return;
			}
			const goals = listRunningGoals(options.sessionsDir, selfId);
			const labels = labelSessions(goals);
			let groups: RunningGoal[][] = [];
			if (typeof ui.custom === "function") {
				const picked = await ui.custom(
					(_tui: any, theme: any, keybindings: any, done: (result: PickResult | undefined) => void) =>
						new ConditionPicker(theme, goals, labels, {
							keybindings,
							onDone: (result: PickResult) => done(result),
							onCancel: () => done(undefined),
						}),
				);
				if (picked === undefined) return;
				groups = (picked as PickResult).groups;
			} else {
				const rows = uniqueLabels([...goals.map((g) => rowLabel(g, labels.get(g.sessionId)!)), "시간 조건만"]);
				const picked = await ui.select("대기할 goal", rows);
				if (picked === undefined) return;
				const goal = goals[rows.indexOf(picked)];
				groups = goal ? [[goal]] : [];
			}
			const whenRaw = await ui.input(groups.length > 0 ? "시간 (선택, 예: 90m, 2h, 23:30)" : "시간 (예: 90m, 2h, 23:30)", "");
			if (whenRaw === undefined) return;
			const at = parseWhen(whenRaw);
			if (at === null) {
				ui.notify?.(`시간 형식을 알 수 없습니다: ${whenRaw}`, "error");
				return;
			}
			if (groups.length === 0 && at === undefined) {
				ui.notify?.("goal이나 시간 중 하나는 지정해야 합니다", "error");
				return;
			}
			const prompt = await ui.editor("실행할 프롬프트", job?.prompt ?? "");
			if (!prompt || prompt.trim() === "") return;
			const newJob: Job = {
				id: randomUUID(),
				createdAt: Date.now(),
				prompt,
				groups: toConds(groups, labels),
				...(at !== undefined ? { at } : {}),
			};
			const ok = await ui.confirm("예약", `${triggerSummary(newJob)}\n${firstLine(prompt, 80)}`);
			if (!ok) return;
			disarm();
			job = newJob;
			save();
			arm();
			if (job === newJob) ui.notify?.(`예약됨: ${triggerSummary(newJob)}`, "info");
		}

		async function cancel(cmdCtx: any) {
			const ui = cmdCtx?.ui ?? {};
			if (!job) {
				ui.notify?.("예약된 작업이 없습니다", "info");
				return;
			}
			const held = job.fired ? `실행 대기 중: ${job.fired.reason}` : triggerSummary(job);
			const ok = await ui.confirm("예약 취소", `${held}\n${firstLine(job.prompt, 80)}`);
			if (!ok) return;
			disarm();
			job = null;
			save();
			updateStatus();
			ui.notify?.("예약을 취소했습니다", "info");
		}

		function forceRun(cmdCtx: any) {
			if (!job) {
				cmdCtx?.ui?.notify?.("예약된 작업이 없습니다", "info");
				return;
			}
			if (job.fired) {
				void flush();
				return;
			}
			trigger("강제 실행");
		}

		pi.on("session_start", async (_event: unknown, startCtx: any) => {
			ctx = startCtx;
			selfId = startCtx.sessionManager?.getSessionId?.();
			// A session switch must never leave the previous job's timers or footer alive.
			disarm();
			if (retryTimer) clearTimeout(retryTimer);
			retryTimer = undefined;
			snaps = new Map();
			lastStatus = undefined;
			if (!selfId) {
				// No store to load: the previous session's job must not stay armed or be delivered here.
				job = null;
				return;
			}
			const loaded = loadStore(options.storeDir, selfId);
			job = loaded.job;
			if (loaded.extraCount) ctx.ui?.notify?.(`이전 예약 ${loaded.extraCount}건은 ${loaded.extraFile}에 옮겼습니다`, "warning");
			updateStatus();
			if (job?.fired) void flush();
			else if (job) arm();
		});

		pi.on("agent_settled", async (_event: unknown, settledCtx: any) => {
			ctx = settledCtx;
			if (job?.fired) void flush();
		});

		pi.on("session_shutdown", async () => {
			disarm();
			if (retryTimer) clearTimeout(retryTimer);
			retryTimer = undefined;
			// Fired-but-undelivered jobs already live in the store with their `fired` slot.
			ctx = undefined;
		});

		pi.registerCommand("after", {
			description: "다른 세션 goal 종료나 지정 시간에 프롬프트 실행",
			requiresArguments: false,
			getArgumentCompletions: (prefix: string) => {
				const items = [
					{ value: "now", label: "now", description: "예약을 지금 실행" },
					{ value: "cancel", label: "cancel", description: "예약 취소" },
				];
				const filtered = items.filter((item) => item.value.startsWith((prefix ?? "").trim()));
				return filtered.length > 0 ? filtered : null;
			},
			handler: async (args: string, cmdCtx: any) => {
				const ui = cmdCtx?.ui ?? {};
				if (!selfId) {
					ui.notify?.("저장된 세션에서만 쓸 수 있습니다", "error");
					return;
				}
				const arg = (args ?? "").trim();
				if (arg === "") {
					await schedule(cmdCtx);
					return;
				}
				if (arg === "now") {
					forceRun(cmdCtx);
					return;
				}
				if (arg === "cancel" || arg === "list") {
					await cancel(cmdCtx);
					return;
				}
				ui.notify?.(`알 수 없는 인자: ${arg} (now, cancel)`, "error");
			},
		});
	};
}

const agentDir = process.env.SENPI_CODING_AGENT_DIR || process.env.OMO_CODING_AGENT_DIR || join(homedir(), ".omo", "agent");

export default createAfterGoal({
	sessionsDir: join(agentDir, "sessions"),
	storeDir: join(agentDir, "after-goal"),
});
