// after-goal: run a prompt in this session when another running session's goal
// ends, or when a given time passes, whichever comes first.
// Prompts that start with "/" (skills, commands) are typed into this session's
// Orca terminal, because omo ignores extension-sourced input when it decides
// whether the user requested a skill (the ulw-plan plan gate, for example).
import { readFileSync, readdirSync, mkdirSync, writeFileSync, watchFile, unwatchFile, existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";

type GoalRef = { sessionId: string; goalId: string; goalFile: string; label: string };
export type Job = { id: string; createdAt: number; prompt: string; goal?: GoalRef; at?: number };
export type RunningGoal = {
  sessionId: string;
  goalId: string;
  goalFile: string;
  project: string;
  objective: string;
  seconds: number;
  progress?: string;
};
type Options = {
  sessionsDir: string;
  storeDir: string;
  goalPollMs?: number;
  retryMs?: number;
};

const ORCA_TEXT_LIMIT = 1500;

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function firstLine(text: string, max = 40): string {
  const line = (text.trim().split(/\r?\n/)[0] ?? "").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}분`;
  const rest = minutes % 60;
  return rest === 0 ? `${Math.floor(minutes / 60)}시간` : `${Math.floor(minutes / 60)}시간 ${rest}분`;
}

function formatClock(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  const today = new Date();
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === today.toDateString() ? time : `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

// "" -> undefined (no time), "90m" | "2h" | "1h30m" | "2시간" | "23:30" -> epoch ms, else null.
export function parseWhen(input: string, now = new Date()): number | undefined | null {
  const s = input.trim().toLowerCase().replace(/시간/g, "h").replace(/분/g, "m").replace(/\s+/g, "");
  if (s === "") return undefined;
  const clock = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (clock) {
    const h = Number(clock[1]);
    const m = Number(clock[2]);
    if (h > 23 || m > 59) return null;
    const at = new Date(now);
    at.setHours(h, m, 0, 0);
    if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
    return at.getTime();
  }
  const rel = /^(?:(\d+)h)?(?:(\d+)m)?$/.exec(s);
  if (!rel || (rel[1] === undefined && rel[2] === undefined)) return null;
  const ms = (Number(rel[1] ?? 0) * 60 + Number(rel[2] ?? 0)) * 60_000;
  return ms > 0 ? now.getTime() + ms : null;
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

export function goalEndReason(ref: GoalRef): string | undefined {
  const read = readGoalFile(ref.goalFile);
  if (read.kind === "unreadable") return undefined;
  if (read.kind === "missing" || read.goal === null) return `${ref.label} goal이 해제됨`;
  const goal = read.goal;
  if (goal.id !== ref.goalId) return `${ref.label} goal이 다른 goal로 바뀜`;
  if (goal.status === "complete") return `${ref.label} goal 완료`;
  if (goal.status === "blocked") return `${ref.label} goal 중단(blocked)${goal.blockedReason ? `: ${firstLine(String(goal.blockedReason), 200)}` : ""}`;
  return undefined;
}

function readProgress(slugDir: string, sessionId: string): string | undefined {
  const file = safeReaddir(slugDir).find((f) => f.endsWith(`_${sessionId}.jsonl`));
  if (!file) return undefined;
  const path = join(slugDir, file);
  try {
    const size = statSync(path).size;
    const length = Math.min(size, 512 * 1024);
    const buffer = Buffer.alloc(length);
    const fd = openSync(path, "r");
    try {
      readSync(fd, buffer, 0, length, size - length);
    } finally {
      closeSync(fd);
    }
    const matches = [...buffer.toString("utf8").matchAll(/Overall: (\d+)\/(\d+) done/g)];
    const last = matches.at(-1);
    return last ? `${last[1]}/${last[2]}` : undefined;
  } catch {
    return undefined;
  }
}

// Running sessions (a session-holders/<id>/<pid>.json whose pid is alive) with an active goal.
export function listRunningGoals(sessionsDir: string, selfId: string | undefined): RunningGoal[] {
  const out: RunningGoal[] = [];
  for (const slug of safeReaddir(sessionsDir)) {
    const slugDir = join(sessionsDir, slug);
    const holdersDir = join(slugDir, "session-holders");
    for (const sessionId of safeReaddir(holdersDir)) {
      if (sessionId === selfId) continue;
      let cwd: string | undefined;
      const alive = safeReaddir(join(holdersDir, sessionId)).some((f) => {
        const pid = Number(f.replace(/\.json$/, ""));
        if (!(pid > 0) || !isAlive(pid)) return false;
        try {
          cwd = JSON.parse(readFileSync(join(holdersDir, sessionId, f), "utf8")).cwd;
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
        progress: readProgress(slugDir, sessionId),
      });
    }
  }
  return out.sort((a, b) => b.seconds - a.seconds);
}

function goalLabel(g: RunningGoal): string {
  return [g.project, g.objective, formatDuration(g.seconds), g.progress].filter(Boolean).join(" · ");
}

function triggerSummary(job: Job): string {
  const parts: string[] = [];
  if (job.goal) parts.push(`${job.goal.label} goal 종료`);
  if (job.at !== undefined) parts.push(formatClock(job.at));
  return parts.join(" 또는 ");
}

function uniqueLabels(labels: string[]): string[] {
  const seen = new Map<string, number>();
  return labels.map((label) => {
    const n = (seen.get(label) ?? 0) + 1;
    seen.set(label, n);
    return n === 1 ? label : `${label} (${n})`;
  });
}

export function createAfterGoal(options: Options) {
  const goalPollMs = options.goalPollMs ?? 3000;
  const retryMs = options.retryMs ?? 5000;

  return function afterGoal(pi: any) {
    let ctx: any;
    let selfId: string | undefined;
    let jobs: Job[] = [];
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const watched = new Map<string, () => void>();
    const ready: { job: Job; reason: string }[] = [];
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let flushing = false;
    let heldNoticeShown = false;

    const storeFile = () => join(options.storeDir, `${selfId}.json`);

    function save() {
      if (!selfId) return;
      mkdirSync(options.storeDir, { recursive: true });
      writeFileSync(storeFile(), JSON.stringify({ version: 1, jobs }, null, 2));
      updateStatus();
    }

    function load() {
      try {
        const parsed = JSON.parse(readFileSync(storeFile(), "utf8"));
        jobs = Array.isArray(parsed?.jobs) ? parsed.jobs : [];
      } catch {
        jobs = [];
      }
    }

    function updateStatus() {
      const pending = jobs.length + ready.length;
      ctx?.ui?.setStatus?.("after-goal", pending > 0 ? `예약 ${pending}건` : undefined);
    }

    function disarm(job: Job) {
      const timer = timers.get(job.id);
      if (timer) clearTimeout(timer);
      timers.delete(job.id);
      const listener = watched.get(job.id);
      if (listener && job.goal) unwatchFile(job.goal.goalFile, listener);
      watched.delete(job.id);
    }

    function trigger(job: Job, reason: string) {
      if (!jobs.some((j) => j.id === job.id)) return;
      disarm(job);
      jobs = jobs.filter((j) => j.id !== job.id);
      ready.push({ job, reason });
      save();
      void flush();
    }

    function armTime(job: Job) {
      if (job.at === undefined) return;
      const delay = job.at - Date.now();
      if (delay <= 0) {
        trigger(job, `예약 시간 ${formatClock(job.at)} 도달`);
        return;
      }
      // setTimeout overflows above ~24.8 days; re-arm in steps.
      const timer = setTimeout(() => armTime(job), Math.min(delay, 2 ** 31 - 1));
      timers.set(job.id, timer);
    }

    function armGoal(job: Job) {
      if (!job.goal) return;
      const goal = job.goal;
      const check = () => {
        const reason = goalEndReason(goal);
        if (reason) trigger(job, reason);
      };
      const listener = () => check();
      watchFile(goal.goalFile, { interval: goalPollMs, persistent: false }, listener);
      watched.set(job.id, listener);
      check();
    }

    function arm(job: Job) {
      armGoal(job);
      if (jobs.some((j) => j.id === job.id)) armTime(job);
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

    async function flush() {
      if (flushing) return;
      flushing = true;
      try {
        while (ready.length > 0) {
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
          const { job, reason } = ready.shift()!;
          updateStatus();
          if (job.prompt.trimStart().startsWith("/")) {
            const failure = await sendViaOrca(terminalText(job, reason));
            if (failure === undefined) {
              ctx.ui?.notify?.(`예약 실행: ${reason}`, "info");
              return;
            }
            if (failure === "ambiguous") {
              ctx.ui?.notify?.(`터미널 입력 응답이 없어 다시 보내지 않았습니다: ${reason}`, "warning");
              return;
            }
            ctx.ui?.notify?.(`터미널 입력 실패(${failure}), 확장 메시지로 보냅니다. 사용자 전용 스킬 게이트는 열리지 않을 수 있습니다`, "warning");
          }
          ctx.ui?.notify?.(`예약 실행: ${reason}`, "info");
          pi.sendUserMessage(deliveryText(job, reason), { expandPromptTemplates: true });
          return;
        }
      } finally {
        flushing = false;
      }
    }

    async function schedule(cmdCtx: any) {
      const goals = listRunningGoals(options.sessionsDir, selfId);
      const timeOnly = "시간 조건만";
      const labels = uniqueLabels([...goals.map(goalLabel), timeOnly]);
      const picked = await cmdCtx.ui.select("대기할 goal", labels);
      if (picked === undefined) return;
      const running = goals[labels.indexOf(picked)];
      const whenRaw = await cmdCtx.ui.input(running ? "시간 (선택, 예: 90m, 2h, 23:30)" : "시간 (예: 90m, 2h, 23:30)", "");
      if (whenRaw === undefined) return;
      const at = parseWhen(whenRaw);
      if (at === null) {
        cmdCtx.ui.notify(`시간 형식을 알 수 없습니다: ${whenRaw}`, "error");
        return;
      }
      if (!running && at === undefined) {
        cmdCtx.ui.notify("goal이나 시간 중 하나는 지정해야 합니다", "error");
        return;
      }
      const prompt = await cmdCtx.ui.editor("실행할 프롬프트", "");
      if (!prompt || prompt.trim() === "") return;
      const job: Job = {
        id: randomUUID(),
        createdAt: Date.now(),
        prompt,
        ...(running ? { goal: { sessionId: running.sessionId, goalId: running.goalId, goalFile: running.goalFile, label: running.project } } : {}),
        ...(at !== undefined ? { at } : {}),
      };
      const ok = await cmdCtx.ui.confirm("예약", `${triggerSummary(job)}\n${firstLine(prompt, 80)}`);
      if (!ok) return;
      jobs.push(job);
      save();
      arm(job);
      if (jobs.some((j) => j.id === job.id)) cmdCtx.ui.notify(`예약됨: ${triggerSummary(job)}`, "info");
    }

    async function manage(cmdCtx: any) {
      if (jobs.length === 0) {
        cmdCtx.ui.notify("예약된 작업이 없습니다", "info");
        return;
      }
      const labels = uniqueLabels(jobs.map((j) => `${triggerSummary(j)} → ${firstLine(j.prompt)}`));
      const picked = await cmdCtx.ui.select("예약 취소", labels);
      if (picked === undefined) return;
      const job = jobs[labels.indexOf(picked)];
      if (!job || !(await cmdCtx.ui.confirm("예약 취소", firstLine(job.prompt, 80)))) return;
      disarm(job);
      jobs = jobs.filter((j) => j.id !== job.id);
      save();
      cmdCtx.ui.notify("예약을 취소했습니다", "info");
    }

    pi.on("session_start", async (_event: unknown, startCtx: any) => {
      ctx = startCtx;
      selfId = startCtx.sessionManager?.getSessionId?.();
      if (!selfId) return;
      load();
      updateStatus();
      for (const job of [...jobs]) arm(job);
    });

    pi.on("agent_settled", async (_event: unknown, settledCtx: any) => {
      ctx = settledCtx;
      if (ready.length > 0) void flush();
    });

    pi.on("session_shutdown", async () => {
      for (const job of jobs) disarm(job);
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = undefined;
      // Fired but undelivered jobs go back to the store so the next start re-fires them.
      if (ready.length > 0) {
        jobs.push(...ready.map((r) => r.job));
        ready.length = 0;
        save();
      }
      ctx = undefined;
    });

    pi.registerCommand("after", {
      description: "다른 세션 goal 종료나 지정 시간에 프롬프트 실행",
      requiresArguments: false,
      getArgumentCompletions: (prefix: string) => ("list".startsWith(prefix) ? [{ value: "list", label: "list" }] : null),
      handler: async (args: string, cmdCtx: any) => {
        if (!selfId) {
          cmdCtx.ui.notify("저장된 세션에서만 쓸 수 있습니다", "error");
          return;
        }
        if (args.trim() === "list") await manage(cmdCtx);
        else await schedule(cmdCtx);
      },
    });
  };
}

const agentDir = process.env.SENPI_CODING_AGENT_DIR || process.env.OMO_CODING_AGENT_DIR || join(homedir(), ".omo", "agent");

export default createAfterGoal({
  sessionsDir: join(agentDir, "sessions"),
  storeDir: join(agentDir, "after-goal"),
});
