# Real-terminal QA harness

`qa/tui-qa.mjs` runs the real omo TUI in a pty, drives it with a step file and snapshots the screen
(`.txt` + `.png` + `.ansi`) through xterm.js in headless Chrome. `qa/fake-sessions.mjs` creates the
waited sessions the reservation waits on, so a scenario can make a goal end or a session die while omo
is running.

Preconditions: `bun`, Chrome at `C:/Program Files/Google/Chrome/Application/chrome.exe` (override with
`QA_CHROME`), omo at `C:/Users/yjack/.bun/install/global/node_modules/omo-ai/bin/omo.js` (override with
`QA_OMO_JS`), and network access to `cdn.jsdelivr.net` for xterm.js.

Everything runs in a temp dir: the scripts never touch the real agent dir. `npm`-style flags are not
used; run these from the repo root.

## Harness

```sh
bun qa/tui-qa.mjs --agent-dir <tmp>/agent --session --cwd <tmp> \
  --ext extension/after-goal/index.ts --steps qa/steps/and.json --out <tmp>/and
```

| flag | meaning |
| --- | --- |
| `--cwd <dir>` | omo's working directory (required) |
| `--steps <json>` | step file (required) |
| `--out <dir>` | shot/evidence directory (default `.omo/evidence/qa`) |
| `--agent-dir <dir>` | sets **both** `OMO_CODING_AGENT_DIR` and `SENPI_CODING_AGENT_DIR`; `{agentDir}` in an `exec` argument resolves to it |
| `--session` | keep omo's session (drops `--no-session`); needed for `/after`, which only works in a saved session |
| `--keep-extensions` | load the installed packages/extensions: omits `--no-extensions` and every `-e` |
| `--ext <file>[;<file>...]` | extension files under test, loaded with `-e` |
| `--cols N` / `--rows N` | pty size (default 150x45); `--cols 80` proves the narrow footer |
| `--timeout <s>` | per-wait timeout (default 120) |
| `--editor <cmd>` | sets `VISUAL` for the child |

The child env drops `ORCA_PANE_KEY`, so a delivered prompt can never be typed into a real terminal.

### Steps

| step | effect |
| --- | --- |
| `{"wait": "text"}` | wait until `text` appears anywhere in the output |
| `{"waitNew": "text"}` | wait until `text` appears **after** the last `send`/`exec` |
| `{"send": "keys"}` | write raw keys (e.g. `"\r"`, `"\u001b[B"`) and move the `waitNew` mark |
| `{"idle": ms}` | wait until no output arrived for `ms` (supported by the harness, but the step files below never use it: an input is always preceded by an observable UI change) |
| `{"exec": ["bun", ...]}` | run a command synchronously with cwd = repo, fail the run on a non-zero exit, and move the `waitNew` mark **before** running, so the next `waitNew` waits for the state change the fixture caused |
| `{"shot": "name"}` | write `name.txt` / `name.png` / `name.ansi` |
| `{"expect": "text"}` / `{"expectNot": "text"}` | check the most recent shot's `.txt`; append `PASS|FAIL <shot> <text>` to `<out>/summary.txt` |
| `{"mark": "label"}` / `{"rm": "path"}` | timing mark / delete a fixture path mid-session |

The run exits 1 when any wait times out, an `exec` fails, or `summary.txt` holds a `FAIL` line.
`wait`/`waitNew` always run under `--timeout <s>` (default 120), so a wait that never becomes true fails
the run instead of hanging.

### No fixed idles: every input is guarded by an observable change

A `waitNew`/`wait` always precedes the next key. The guards the step files use:

| input | waited for before sending it |
| --- | --- |
| the first key | `[Extensions]` (extension loaded) and `Welcome to OmO` (the empty-session splash, drawn in the same frame as the composer) |
| `/after`, `/aft` | the typed command's completion text (`after`, `/after`) |
| `/after now`, `/after cancel` | the argument completion (`예약을 지금 실행`, `예약 취소`), then `\r\r`: with an argument completion open the editor's first Enter only applies it, the second submits (a user presses Enter twice too) |
| `Enter` on the picker / a select | the next dialog title (`대기할 goal`, `시간`, `실행할 프롬프트`, `예약`, `예약 바꾸기`, `예약 취소`) |
| `&` / `|` | the updated expression line (`& ▢` / `| ▢`) |
| an arrow | the cursor row (`→ qa-b`) |
| `Enter` on a confirm selector | the confirm selector's own bottom hint (`esc/ctrl+c cancel`) before the dialog shot |
| `Enter` on the prompt editor | the editor's bottom hint (`external editor`) before the shot |
| `exec` (a fixture command) | the footer/delivery text the fixture causes (`qa-a ✓`, `qa-a 꺼짐`, `Follow-up: <prompt>`) |
| `Esc` on the prompt editor | the main editor's `❯` coming back |

A delivery is observed as the notice `예약 실행: <reason>` plus the queued line `Follow-up: <prompt>`. The isolated agent dir has no model, so omo queues the delivered prompt instead of running it, and the queue preview shows only its first line; the full delivered text (`<prompt>\n\n[after-goal] 예약 실행 사유: <reason>`) is covered by `test/index.test.ts`.

Fixed `idle` waits are never used to wait for a fixture-driven change.

## Fake sessions

```sh
bun qa/fake-sessions.mjs create <agentDir> a --open 2 --total 3 --seconds 600   # label qa-a
bun qa/fake-sessions.mjs create <agentDir> b --open 1 --total 4 --seconds 300   # label qa-b
bun qa/fake-sessions.mjs todo   <agentDir> a --open 4 --total 6   # append a newer todo record
bun qa/fake-sessions.mjs finish <agentDir> b                      # goal status complete
bun qa/fake-sessions.mjs kill   <agentDir> a                      # session dies, goal stays active
bun qa/fake-sessions.mjs cleanup <agentDir>                       # kill every keeper, remove every --qa-* slug
```

| command | effect |
| --- | --- |
| `create` | `<agentDir>/sessions/--qa-<name>--/` with a `session-holders/<id>/<pid>.json` for a detached keeper (`bun -e "setInterval(()=>{},1e9)"`, `detached: true` — a plain child dies with the CLI on Windows), an active goal file `extensions/goal/<id>.json`, and a `<ts>_<id>.jsonl` holding one `senpi.todo-state` record of `--total` tasks of which `--open` are pending/in_progress; the keeper pid is recorded in `<agentDir>/qa-keepers.json`; cwd field `C:\qa\qa-<name>` (so `<name>` `a` shows as the label `qa-a`) |
| `todo` | append a newer `senpi.todo-state` record (the footer's `남은 N` follows) |
| `finish` | goal `status: complete` (the session stays alive) |
| `kill` | kill that keeper only (the goal stays active, so the session reads as dead) |
| `cleanup` | kill every keeper, remove every `--qa-*` slug and `qa-keepers.json`, and print both checks |

`create` sorts nothing, but `listRunningGoals` sorts by elapsed time, so the picker shows the rows in
descending `--seconds` order: pass the larger value to the session that must be row 0 (`qa-a`).

Every fixture and agent dir comes from `os.tmpdir()`. The real agent dir (`~/.omo/agent`) is refused
outright; a run must leave no keeper process alive and no `--qa-*` dir behind.

## Scenarios

Fixtures: `create <agentDir> a --open 2 --total 3 --seconds 600` and `create <agentDir> b --open 1 --total 4
--seconds 300` (labels `qa-a` / `qa-b` at rows 0 / 1), then the step file. Expected observables are the
`expect`/`expectNot` lines in each file.

| steps | shots | observable |
| --- | --- | --- |
| (all) | | every key is preceded by its guard from the table above; a guard that never appears fails the run |
| `smoke.json` | `smoke` | `/after` answers: the goal picker title `대기할 goal`, or `저장된 세션에서만` in an agent dir without a saved session |
| `and.json` | `armed`, `one-done`, `fired` | picker `&` on qa-a + Enter on qa-b and an empty time arms one AND group; footer `⏰ qa-a 남은 2 & qa-b 남은 1`; finishing qa-a alone shows `qa-a ✓` and delivers nothing; finishing qa-b delivers: `예약 실행: qa-a goal 완료, qa-b goal 완료`, `Follow-up: QA-PROMPT-ALPHA`, `⏰` gone |
| `or.json` | `armed`, `fired` | `|` on qa-a + Enter on qa-b arms two OR groups; footer `⏰ qa-a 남은 2 | qa-b 남은 1`; finishing qa-b alone delivers: `예약 실행: qa-b goal 완료`, `Follow-up: QA-PROMPT-OR`, `⏰` gone |
| `now.json` | `armed`, `fired` | a one-goal reservation shows `qa-a 남은 2`; `/after now` delivers at once: `예약 실행: 강제 실행`, `Follow-up: QA-PROMPT-NOW`, `⏰` gone |
| `replace.json` | `armed`, `confirm-replace`, `prefilled`, `kept` | a second `/after` asks `예약 바꾸기`; the prompt editor is prefilled with the old prompt; Esc keeps the old reservation (`⏰ qa-a 남은 2`, no `qa-b`) |
| `cancel.json` | `armed`, `confirm-cancel`, `cancelled` | `/after cancel` asks `예약 취소` naming `qa-a goal 종료`, confirms, clears the footer (`⏰` gone) |
| `dead.json` | `armed`, `dead`, `fired` | OR of qa-a and qa-b; killing qa-a shows `qa-a 꺼짐` and delivers nothing; finishing qa-b then delivers: `예약 실행: qa-b goal 완료`, `Follow-up: QA-PROMPT-DEAD` |
| `autocomplete.json` | `autocomplete` | typing `/aft` shows one `/after` completion line (used after the package install) |

## Example

```sh
tmp=$(mktemp -d)
bun qa/fake-sessions.mjs create "$tmp/agent" a --open 2 --total 3 --seconds 600
bun qa/fake-sessions.mjs create "$tmp/agent" b --open 1 --total 4 --seconds 300
bun qa/tui-qa.mjs --agent-dir "$tmp/agent" --session --cwd "$tmp" \
  --ext extension/after-goal/index.ts --steps qa/steps/and.json --out "$tmp/and"
grep -q FAIL "$tmp/and/summary.txt" && echo "summary has FAIL"
bun qa/fake-sessions.mjs cleanup "$tmp/agent"
```
