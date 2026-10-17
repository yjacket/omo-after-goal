import { decodeKey } from "./keys.ts";
import { fitCells, padCells } from "./text.ts";
import { formatDuration } from "./time.ts";
import type { PickResult, RunningGoal } from "./types.ts";

/** Group colors cycle in this order; group 1 is accent, group 2 success, group 3 warning. */
const PALETTE = ["accent", "success", "warning"] as const;
/** At most this many rows are shown at once; a taller list follows the cursor. */
const WINDOW = 10;

const TIME_ROW = "시간 조건만";

type Pick = { index: number; op?: "&" | "|" };

type Theme = {
	fg(color: string, text: string): string;
	bold(text: string): string;
};

type Options = {
	onDone(result: PickResult): void;
	onCancel(): void;
	keybindings?: { matches(data: string, id: string): boolean };
};

/** One list row: label, objective, elapsed time, and the open todo count when there is one. */
export function rowLabel(goal: RunningGoal, label: string): string {
	return [
		label,
		goal.objective,
		formatDuration(goal.seconds),
		goal.todo ? `남은 ${goal.todo.open}` : undefined,
	].filter(Boolean).join(" · ");
}

/** Picks goals with `&` (all in a group) and `|` (opens the next group); Enter confirms, Esc cancels. */
export class ConditionPicker {
	private cursor = 0;
	private picks: Pick[] = [];

	constructor(
		private theme: Theme,
		private goals: RunningGoal[],
		private labels: ReadonlyMap<string, string>,
		private options: Options,
	) {}

	handleInput(data: string): void {
		const key = decodeKey(data, this.options.keybindings);
		if (key === undefined) return;
		const rows = this.rowCount();
		switch (key) {
			case "up":
				this.cursor = (this.cursor + rows - 1) % rows;
				break;
			case "down":
				this.cursor = (this.cursor + 1) % rows;
				break;
			case "&":
				this.add("&");
				break;
			case "|":
				this.add("|");
				break;
			case "enter":
				this.confirm();
				break;
			case "backspace":
				this.picks.pop();
				break;
			case "escape":
				this.options.onCancel();
				break;
			default:
				break;
		}
	}

	invalidate(): void {}

	/** Rows are the goals in order, then the time-only row. */
	private rowCount(): number {
		return this.goals.length + 1;
	}

	private labelFor(index: number): string {
		const goal = this.goals[index];
		if (goal === undefined) return "";
		return this.labels.get(goal.sessionId) ?? goal.sessionId;
	}

	/** The group still open for `&`: every pick appended after the last `|`. */
	private openGroup(): number[] {
		let current: number[] = [];
		for (const pick of this.picks) {
			current.push(pick.index);
			if (pick.op === "|") current = [];
		}
		return current;
	}

	/** Goal indexes grouped left to right; a pick marked `|` closes its group. */
	private derived(): number[][] {
		const groups: number[][] = [];
		let current: number[] = [];
		for (const pick of this.picks) {
			current.push(pick.index);
			if (pick.op === "|") {
				groups.push(current);
				current = [];
			}
		}
		if (current.length > 0) groups.push(current);
		return groups;
	}

	private add(op: "&" | "|"): void {
		if (this.cursor >= this.goals.length) return;
		const index = this.cursor;
		if (!this.openGroup().includes(index)) {
			this.picks.push({ index, op });
			return;
		}
		if (op === "&") return;
		// `|` on a goal already in the open group closes that group after its last pick.
		const last = this.picks.at(-1);
		if (last) last.op = "|";
	}

	private confirm(): void {
		// The last pick closed its group with `|`: Enter on that same row only finishes.
		// Re-adding it would read `(A & B) | B`, which is never what the user meant.
		const last = this.picks.at(-1);
		const justClosed = last !== undefined && last.op === "|" && last.index === this.cursor;
		if (this.cursor < this.goals.length && !this.openGroup().includes(this.cursor) && !justClosed) {
			this.picks.push({ index: this.cursor });
		}
		this.finish();
	}

	private finish(): void {
		const groups = this.derived()
			.map((group) => group.map((index) => this.goals[index]).filter((goal): goal is RunningGoal => goal !== undefined))
			.filter((group) => group.length > 0);
		this.options.onDone({ groups });
	}

	private expression(): string {
		if (this.picks.length === 0) return this.theme.fg("dim", "고른 goal 없음");
		const parts: string[] = [];
		let group = 0;
		for (const pick of this.picks) {
			parts.push(this.theme.fg(PALETTE[group % PALETTE.length] as string, this.labelFor(pick.index)));
			if (pick.op) parts.push(this.theme.fg("dim", ` ${pick.op} `));
			if (pick.op === "|") group++;
		}
		if (this.picks.at(-1)?.op) parts.push(this.theme.fg("dim", "▢"));
		return parts.join("");
	}

	/** Every group holding the row gets its own number badge in that group's color, left to right. */
	private badges(index: number): string {
		const numbers = this.derived()
			.map((group, position) => (group.includes(index) ? position : undefined))
			.filter((position): position is number => position !== undefined);
		if (numbers.length === 0) return "";
		const text = numbers
			.map((position) => this.theme.fg(PALETTE[position % PALETTE.length] as string, String(position + 1)))
			.join(this.theme.fg("dim", ","));
		return `[${text}] `;
	}

	private windowStart(): number {
		const rows = this.rowCount();
		const max = Math.max(0, rows - WINDOW);
		return Math.max(0, Math.min(this.cursor - Math.floor(WINDOW / 2), max));
	}

	render(width: number): string[] {
		const w = Math.max(0, width);
		const dim = (text: string) => this.theme.fg("dim", text);
		const header = this.theme.bold(this.theme.fg("accent", "대기할 goal"));
		const border = this.theme.fg("border", "─".repeat(w));
		const lines: string[] = [
			this.rowCount() > WINDOW
				? `${header}${dim(` (${this.cursor + 1}/${this.rowCount()})`)}`
				: header,
			`조건 ${this.expression()}`,
			"",
		];
		const start = this.windowStart();
		for (let i = start; i < Math.min(this.rowCount(), start + WINDOW); i++) {
			const goal = this.goals[i];
			const label = goal === undefined ? TIME_ROW : rowLabel(goal, this.labelFor(i));
			const pointer = i === this.cursor ? this.theme.fg("accent", "→ ") : "  ";
			lines.push(`${pointer}${this.badges(i)}${label}`);
		}
		lines.push("");
		lines.push(dim("↑↓ 이동 · & 그리고 · | 또는 · Enter 확정 · ⌫ 되돌리기 · Esc 취소"));
		// Framed like the host's own selectors (border, blank, 1-cell indent), since it takes the editor's place.
		const framed = [border, "", ...lines.map((line) => (line === "" ? "" : ` ${line}`)), "", border];
		return framed.map((line) => padCells(fitCells(line, w), w));
	}
}
