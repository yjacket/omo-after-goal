# omo-after-goal

[한국어](README.ko.md)

Reserve one prompt in this session and have it run when other sessions' goals end, or at a set time. The footer shows an alarm clock with what is awaited and how much work is left in each awaited session.

## Install

```sh
omo install git:github.com/yjacket/omo-after-goal
```

omo adds the package to `packages` in `<agentDir>/settings.json`. Type `/reload` in running sessions, or start a new one.

To update, run `omo update --extensions` (all git-installed extensions) or `omo update --extension git:github.com/yjacket/omo-after-goal` (this one only), then `/reload`.

If an older copy of this extension still sits at `<agentDir>/extensions/after-goal.ts`, delete or move it, or the extension loads twice. A reservation stored by that old file is migrated on the next start.

## Usage

`/after` opens a picker over the goals running in other sessions.

| Key | Action |
| --- | --- |
| `↑` `↓` | Move the cursor |
| `&` | Pick the goal into the current AND group |
| `\|` | Pick the goal into the current group, then start a new OR group for the next pick |
| `Enter` | Pick the goal and finish; on the `시간 조건만` row, finish with the goals picked so far (a time-only reservation when none) |
| `Backspace` | Undo the last pick |
| `Esc` | Cancel |

`&` binds tighter than `|`: `A &, B |, C Enter` means `(A & B) | C`, which fires when A and B have both ended, or when C ends. Goals only, a time only, or both together are all allowed.

The time row takes the usual forms: `90m`, `2h`, `1h30m`, `2시간`, `23:30`. A time condition is ORed with the goals.

Then the prompt editor opens, a summary is shown, and you confirm.

- `/after now` runs the reservation immediately, whatever its conditions say, and delivers it through the normal gate.
- `/after cancel` cancels the reservation after a confirmation. The old `/after list` does the same.
- One reservation per session. `/after` again shows the current one and asks whether to replace it; the prompt editor starts from the old prompt.

`/after` works in a saved session.

## Footer

While a reservation exists, one footer status appears under the key `omo-after-goal`:

```
⏰ omo-health 남은 4 & omo-inbox 남은 2 | 23:30
```

Each awaited goal is named by its session's project followed by how many of that session's todos are still open. `✓` replaces the count once the goal has ended, `꺼짐` replaces it when the session is no longer running, and a time condition adds the `| HH:MM` part. A reservation whose condition was met but whose prompt is still waiting to be delivered shows `⏰ 실행 대기`.

## How it works

The extension reads the goal files other sessions write, under `<sessionsDir>/<slug>/extensions/goal/`. A goal seen ended is latched into the reservation, so it stays ended even if the session exits.

Remaining work is read from the todo tool's structured records in the awaited session's log, newest record only, so a cleared list counts as 0 and text that merely quotes a todo list is never read. A missing goal file counts as ended only while its session is alive; a goal that is complete, blocked or replaced counts even after the session has exited.

The footer is refreshed by a 3-second poll and is written only when its text changed.

Delivery is unchanged: a prompt starting with `/` is typed into the Orca terminal, anything else is sent as a user message. Nothing is delivered while the session is busy, its prompt editor is not empty, or omo holds new turns (after Esc/Stop, or in a session reopened after it died mid-run, until terminal input or `/resume`); the reservation waits with one notice, and a waiting delivery survives a restart.

## Limits

- It never estimates remaining time. The count is open tasks, nothing more.
- Conditions have no parentheses and no NOT.
- A count appears only while the awaited session's todo list is maintained through the todo tool.
- A PID can be reused by another process, which can keep a dead session looking alive.
- After a session rewinds its branch, the count may show the abandoned branch until that session writes its todos again.

## Uninstall

```sh
omo remove git:github.com/yjacket/omo-after-goal
```

Then type `/reload`.

## Development

- Work in a git worktree on a new branch and land changes through a pull request. `master` accepts no direct pushes; a PR merges only when its `test` check passes (`bun run test` on windows-latest).
- Run the checks locally with `bun install`, then `bun test`, `bun run typecheck` and `bun qa/check-headings.mjs` (README.md and README.ko.md must keep the same headings).
- To try a working tree in omo, `omo install <path-to-your-clone>` loads it until you switch back with `omo install git:github.com/yjacket/omo-after-goal`. Use this for development checks only.
- Live tests never touch the real `~/.omo`. Point HOME, USERPROFILE, APPDATA, LOCALAPPDATA and `OMO_CODING_AGENT_DIR`/`SENPI_CODING_AGENT_DIR` at a temp dir. The TUI harness in [qa/README.md](qa/README.md) runs in a temp agent dir with fake sessions.
