import type { GoalCond, Job, Paint, SessionSnapshot } from "./types.ts";
import { plainPaint } from "./types.ts";
import { displayWidth, fitCells } from "./text.ts";
import { formatClock } from "./time.ts";

/** Cells the footer body may use after the "⏰ " icon. The budget is spent labels-last, then conds-last: counts, marks, operators and the time are never cut. */
const BODY_CELLS = 48;
/** Widest a single label gets. Below three cells a label stops meaning anything, so whole conds are dropped instead. */
const LABEL_CELLS = 14;
const MIN_LABEL_CELLS = 3;

/** The alarm-clock footer: which sessions this reservation awaits, their open todos, and when it fires. */
export function statusText(
	job: Job | null,
	snaps: ReadonlyMap<string, SessionSnapshot>,
	opts: { paint?: Paint; now?: Date } = {},
): string | undefined {
	if (job === null) return undefined;
	if (job.fired) return "⏰ 실행 대기";
	const paint = opts.paint ?? plainPaint;
	const suffixOf = (cond: GoalCond): string => {
		if (cond.endedAt !== undefined) return ` ${paint.ok("✓")}`;
		const snap = snaps.get(cond.sessionId);
		if (snap?.alive === false) return ` ${paint.warn("꺼짐")}`;
		if (snap?.todo) return ` 남은 ${snap.todo.open}`;
		return "";
	};
	// Flattened in group order, each cond remembering its group so the operators of any prefix can be rebuilt.
	const terms = job.groups.flatMap((group, g) => group.map((cond) => ({ group: g, label: cond.label, suffix: suffixOf(cond) })));
	const conds = terms.length;
	const andJoin = paint.dim(" & ");
	const orJoin = paint.dim(" | ");
	const time = job.at !== undefined ? formatClock(job.at, opts.now) : "";
	if (conds === 0) return time ? `⏰ ${time}` : "⏰ 예약";
	const timePart = time ? paint.dim(" | ") + time : "";
	const joinOf = (i: number): string => (terms[i].group === terms[i - 1].group ? andJoin : orJoin);
	const marker = (hidden: number, visible: number): string => `${visible > 0 ? " " : ""}…+${hidden}`;
	// Everything the first k conds cost except their labels: operators, suffixes, the overflow marker and the time.
	const fixedCells = (k: number): number => {
		let cells = displayWidth(timePart);
		for (let i = 0; i < k; i++) {
			cells += displayWidth(terms[i].suffix);
			if (i > 0) cells += displayWidth(joinOf(i));
		}
		if (k < conds) cells += displayWidth(marker(conds - k, k));
		return cells;
	};
	const render = (k: number): string => {
		const perLabel = k === 0 ? LABEL_CELLS : Math.max(MIN_LABEL_CELLS, Math.min(LABEL_CELLS, Math.floor((BODY_CELLS - fixedCells(k)) / k)));
		let goals = "";
		for (let i = 0; i < k; i++) {
			if (i > 0) goals += joinOf(i);
			goals += fitCells(terms[i].label, perLabel) + terms[i].suffix;
		}
		if (k < conds) goals += marker(conds - k, k);
		return goals + timePart;
	};
	// The largest prefix that fits; when even one cond does not, k = 0 renders the marker alone.
	let k = conds;
	let body = render(k);
	while (k > 0 && displayWidth(body) > BODY_CELLS) {
		k -= 1;
		body = render(k);
	}
	return `⏰ ${body}`;
}
