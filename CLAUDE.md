# CLAUDE.md

This file guides Claude Code (claude.ai/code) in this repository.

## What this is

`extension/after-goal/` is an OMO/Senpi extension, installed as an omo package (`omo install git:github.com/yjacket/omo-after-goal`, updated with `omo update --extensions`; `package.json` `pi.extensions` names `extension/after-goal/index.ts`). A session holds at most one reservation: a prompt plus OR of AND goal groups (`&` inside a group, `|` between groups) and/or a time, and the prompt is delivered when the condition is met. `/after` opens a picker, `/after now` fires the reservation at once, `/after cancel` cancels it. The footer carries one status, key `omo-after-goal`. README.md is the user-facing spec; README.ko.md mirrors it with the same headings in the same order, and `bun qa/check-headings.mjs` checks that mirror.

Modules: `types.ts`, `text.ts`, `keys.ts`, `time.ts`, `labels.ts` (shared contract, used by every lane), `conditions.ts` (group model, latch, trigger summary), `sessions.ts` (running goals, liveness, structured todo summary), `store.ts` (v2 single-job file, v1 migration), `status.ts` (footer text), `picker.ts` (the `&`/`|` picker), `index.ts` (wiring, commands, poll, delivery).

## Commands

```sh
bun test
bun run typecheck
bun qa/check-headings.mjs
bun qa/fake-sessions.mjs create <agentDir> a --open 2 --total 3
bun qa/tui-qa.mjs --agent-dir <agentDir> --session --cwd <cwd> --ext extension/after-goal/index.ts --steps qa/steps/and.json --out <out>
omo install <path-to-this-clone>   # dev checks only; switch back to the git install afterwards
```

`qa/fake-sessions.mjs` takes `create|todo|finish|kill <agentDir> <name> [--open N --total M]` and `cleanup <agentDir>`. `qa/tui-qa.mjs` flags: `--agent-dir`, `--session`, `--keep-extensions`, `--cwd`, `--ext`, `--steps`, `--out`. QA runs in an isolated agent dir with fake waited sessions; scripts never touch the real agent dir unless it is passed explicitly, and a run must leave no keeper process and no `--qa-` slug behind.

## Invariants

- The footer status key is `omo-after-goal` (`STATUS_KEY`), and `setStatus` is called only when the text changed. It runs inside `try/catch`, so a stale ctx can never escape the poll timer.
- Delivery is unchanged: `/` prompts are typed in the Orca terminal, longer prompts go through a file, everything else is `sendUserMessage`; the text stays `[after-goal] 예약 실행 사유: <reason>`.
- Delivery happens only when the session is idle and the prompt editor is empty; the job is cleared from the store before sending (at most once), and a fired-but-undelivered job survives a restart.
- One reservation per session, including one that already fired and is waiting to be delivered.
- Ended goals latch (`endedAt`/`endReason` persisted); a missing goal file counts as ended only while its session is alive.
- The store is `{ version: 2, job }`, written to `<file>.tmp` and renamed; v1 stores migrate, extras go to `<sessionId>.v1-extra.json`.
- No runtime dependencies, and no runtime import of `@earendil-works/pi-tui` or other senpi packages (devDependencies are for typecheck only).
- The contract files are shared: change one only when every lane importing it agrees.

## Testing

Tests use `bun:test` and live in `test/`, importing `../extension/after-goal/<file>.ts`. No sleeps and no timing waits: call the code synchronously, or await a promise the code itself resolves, with a bounded timeout. Temp dirs come from `mkdtempSync(join(tmpdir(), "after-goal-"))` and are removed in `afterEach`/`afterAll`. An alive pid in fixtures is `process.pid`; a dead one is `999999999`. A test must be able to fail for the behavior it names.

## Workflow

Work in a worktree on a new branch and land through a PR; `master` is protected and the `test` check (`bun run test`, windows-latest) must pass. Live tests use a temp HOME/USERPROFILE/APPDATA/LOCALAPPDATA and agent dir, never the real `~/.omo`. Don't commit `.omo/` scratch, tokens or internal host names.

## Commits

`after-goal: <what changed>`
