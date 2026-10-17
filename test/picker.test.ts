import { describe, expect, mock, test } from "bun:test";
import { ConditionPicker, rowLabel } from "../extension/after-goal/picker.ts";
import { displayWidth } from "../extension/after-goal/text.ts";
import type { PickResult, RunningGoal } from "../extension/after-goal/types.ts";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
const BACKSPACE = "\x7f";
const ESC = "\x1b";
const AND = "&";
const OR = "|";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const tagging = {
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	bold: (text: string) => `<b>${text}</b>`,
};

function goal(
	sessionId: string,
	objective = `goal ${sessionId}`,
	todo?: { total: number; open: number },
): RunningGoal {
	return {
		sessionId,
		goalId: `g-${sessionId}`,
		goalFile: `${sessionId}.json`,
		project: sessionId,
		objective,
		seconds: 180,
		todo,
	};
}

const goals = [goal("A"), goal("B"), goal("C")];
const labels = new Map([["A", "A"], ["B", "B"], ["C", "C"]]);

function pickerFor(
	themeLike: typeof theme,
	list: RunningGoal[],
	names: ReadonlyMap<string, string>,
	onDone: (result: PickResult) => void,
	onCancel: () => void = () => {},
): ConditionPicker {
	return new ConditionPicker(themeLike, list, names, { onDone, onCancel });
}

/** Types a key sequence into a fresh picker and returns the confirmed result, if any. */
function play(
	keys: string[],
	overrides: { goals?: RunningGoal[]; labels?: ReadonlyMap<string, string> } = {},
): { result?: PickResult; cancelled: number } {
	const done = mock((_result: PickResult) => {});
	const cancel = mock(() => {});
	const picker = pickerFor(
		theme,
		overrides.goals ?? goals,
		overrides.labels ?? labels,
		done,
		cancel,
	);
	for (const key of keys) picker.handleInput(key);
	return { result: done.mock.calls[0]?.[0], cancelled: cancel.mock.calls.length };
}

function ids(result: PickResult | undefined): string[][] {
	return (result?.groups ?? []).map((group) => group.map((item) => item.sessionId));
}

describe("rowLabel", () => {
	test("joins the label, objective, duration and open todo count", () => {
		expect(rowLabel(goal("A", "배포 준비"), "A")).toBe("A · 배포 준비 · 3분");
		expect(rowLabel(goal("A", "배포 준비", { total: 4, open: 2 }), "A")).toBe(
			"A · 배포 준비 · 3분 · 남은 2",
		);
	});
});

describe("ConditionPicker", () => {
	test("A & then B Enter -> [[A, B]]", () => {
		expect(ids(play([AND, DOWN, ENTER]).result)).toEqual([["A", "B"]]);
	});

	test("A | then C Enter -> [[A], [C]]", () => {
		expect(ids(play([OR, DOWN, DOWN, ENTER]).result)).toEqual([["A"], ["C"]]);
	});

	test("A & B | C Enter -> [[A, B], [C]]", () => {
		expect(ids(play([AND, DOWN, OR, DOWN, ENTER]).result)).toEqual([["A", "B"], ["C"]]);
	});

	test("Enter on the goal that just closed the group with | finishes without re-adding it", () => {
		expect(ids(play([AND, DOWN, OR, ENTER]).result)).toEqual([["A", "B"]]);
	});

	test("Enter on any goal of the group | just closed finishes without re-adding it", () => {
		expect(ids(play([AND, DOWN, AND, UP, OR, ENTER]).result)).toEqual([["A", "B"]]);
	});

	test("Enter on a later goal after | still opens the next group", () => {
		expect(ids(play([AND, DOWN, OR, DOWN, ENTER]).result)).toEqual([["A", "B"], ["C"]]);
	});

	test("| on a goal already in the open group closes the group at the last pick", () => {
		expect(ids(play([AND, DOWN, AND, UP, OR, DOWN, DOWN, ENTER]).result)).toEqual([
			["A", "B"],
			["C"],
		]);
	});

	test("backspace undoes the last pick", () => {
		expect(ids(play([AND, DOWN, AND, BACKSPACE, DOWN, DOWN, ENTER]).result)).toEqual([["A"]]);
	});

	test("Enter on the time row with no picks -> { groups: [] }", () => {
		expect(play([DOWN, DOWN, DOWN, ENTER]).result).toEqual({ groups: [] });
	});

	test("A & then Enter on the time row -> [[A]]", () => {
		expect(play([AND, DOWN, DOWN, DOWN, ENTER]).result).toEqual({ groups: [[goals[0]!]] });
	});

	test("a duplicate & on a goal already in the open group is ignored", () => {
		expect(play([AND, AND, DOWN, DOWN, DOWN, ENTER]).result).toEqual({ groups: [[goals[0]!]] });
	});

	test("escape cancels without finishing", () => {
		const played = play([AND, ESC]);
		expect(played.cancelled).toBe(1);
		expect(played.result).toBeUndefined();
	});

	test("kitty CSI u sequences read as & and |", () => {
		expect(ids(play(["\x1b[55:38;2u", DOWN, "\x1b[92:124;2u", DOWN, ENTER]).result)).toEqual([
			["A", "B"],
			["C"],
		]);
	});

	test("up from the first row wraps to the time row", () => {
		const picker = pickerFor(theme, [goal("A"), goal("B")], labels, () => {});
		picker.handleInput(UP);
		expect(picker.render(80).find((line) => line.includes("→"))).toContain("시간 조건만");
	});

	test("& and | on the time row are ignored", () => {
		const picker = pickerFor(theme, [goal("A")], labels, () => {});
		picker.handleInput(DOWN);
		picker.handleInput(AND);
		picker.handleInput(OR);
		expect(picker.render(80).join("\n")).toContain("고른 goal 없음");
	});

	test("renders within the width, with expression, badges and cursor", () => {
		const picker = pickerFor(theme, goals, labels, () => {});
		for (const key of [AND, DOWN, OR, DOWN, ENTER]) picker.handleInput(key);
		for (const width of [80, 36]) {
			const lines = picker.render(width);
			expect(lines.every((line) => displayWidth(line) <= width)).toBe(true);
			const text = lines.join("\n");
			expect(text).toContain("대기할 goal");
			expect(text).toContain("조건 A & B | C");
			expect(text).toContain("[1]");
			expect(text).toContain("[2]");
			const cursorRow = lines.find((line) => line.includes("→"));
			expect(cursorRow).toContain("→ [2] C");
		}
		expect(picker.render(80).join("\n")).toContain(
			"↑↓ 이동 · & 그리고 · | 또는 · Enter 확정 · ⌫ 되돌리기 · Esc 취소",
		);
	});

	test("a trailing operator renders the pending box", () => {
		const picker = pickerFor(theme, goals, labels, () => {});
		picker.handleInput(AND);
		expect(picker.render(80).join("\n")).toContain("조건 A & ▢");
	});

	test("a tagging theme colors each group differently", () => {
		const picker = pickerFor(tagging, goals, labels, () => {});
		for (const key of [AND, DOWN, OR, DOWN, ENTER]) picker.handleInput(key);
		const text = picker.render(200).join("\n");
		expect(text).toContain("<accent>A</accent>");
		expect(text).toContain("<accent>B</accent>");
		expect(text).toContain("<success>C</success>");
		expect(text).toContain("<b><accent>대기할 goal</accent></b>");
	});

	test("no goals -> only the time row", () => {
		const picker = pickerFor(theme, [], new Map(), () => {});
		const lines = picker.render(80);
		expect(lines.join("\n")).toContain("시간 조건만");
		expect(lines.length).toBe(10);
		// framed like the host selectors: a full-width border above and below
		expect(lines[0]).toBe("─".repeat(80));
		expect(lines.at(-1)).toBe("─".repeat(80));
		const cursorRows = lines.filter((line) => line.includes("→"));
		expect(cursorRows.length).toBe(1);
		expect(cursorRows[0]).toContain("시간 조건만");
	});

	test("a list taller than ten rows follows the cursor and counts rows", () => {
		const many = Array.from({ length: 12 }, (_value, index) => goal(`S${index}`));
		const manyLabels = new Map(many.map((item) => [item.sessionId, item.sessionId]));
		const picker = pickerFor(theme, many, manyLabels, () => {});
		picker.handleInput(UP);
		const lines = picker.render(80);
		expect(lines.find((line) => line.includes("대기할 goal"))).toContain(" (13/13)");
		expect(lines.find((line) => line.includes("→"))).toContain("시간 조건만");
		expect(lines.filter((line) => /S\d/.test(line)).length).toBeLessThanOrEqual(10);
	});
});
