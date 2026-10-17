import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadStore, saveStore, storePath } from "../extension/after-goal/store.ts";
import type { GoalCond, Job } from "../extension/after-goal/types.ts";

const dirs: string[] = [];

function storeDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "after-goal-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SESSION = "01a14634-d647-7fa7-b15e-af0669629381";
const GOAL_FILE = "C:\\Users\\yjack\\.omo\\agent\\sessions\\--C--dev-searchad--\\extensions\\goal\\01a14634-d647-7fa7-b15e-af0669629381.json";

function cond(overrides: Partial<GoalCond> = {}): GoalCond {
	return { sessionId: SESSION, goalId: "66e10db0-6504-4743-939b-4c43960206b0", goalFile: GOAL_FILE, label: "searchad", ...overrides };
}

function job(overrides: Partial<Job> = {}): Job {
	return { id: "2fc6d435-fd70-4e59-8f5b-1cd519b0b0e4", createdAt: 1792183127996, prompt: "끝나면 알려줘", groups: [[cond()]], ...overrides };
}

/** The old single-slot shape: a `goal` object instead of `groups`. */
function v1Job(overrides: Record<string, unknown> = {}) {
	const { groups: _groups, ...base } = job();
	return { ...base, goal: cond(), ...overrides };
}

describe("storePath", () => {
	test("names the store after the session", () => {
		expect(storePath(join("tmp", "after-goal"), SESSION)).toBe(join("tmp", "after-goal", `${SESSION}.json`));
	});
});

describe("v2 round trip", () => {
	test("saving twice to the same path overwrites on Windows", () => {
		const dir = storeDir();
		saveStore(dir, SESSION, job({ prompt: "first" }));
		const second = job({ id: "second-id", prompt: "second", groups: [] });
		saveStore(dir, SESSION, second);
		expect(loadStore(dir, SESSION).job).toEqual(second);
	});

	test("writes version 2 pretty JSON", () => {
		const dir = storeDir();
		const one = job();
		saveStore(dir, SESSION, one);
		const raw = readFileSync(storePath(dir, SESSION), "utf8");
		expect(JSON.parse(raw)).toEqual({ version: 2, job: one });
		expect(raw).toContain("\n  ");
	});

	test("keeps a fired marker as is", () => {
		const dir = storeDir();
		const fired = job({ fired: { reason: "searchad goal 종료", at: 1792183200000 } });
		saveStore(dir, SESSION, fired);
		expect(loadStore(dir, SESSION).job).toEqual(fired);
	});

	test("keeps latched conditions", () => {
		const dir = storeDir();
		const latched = job({ groups: [[cond({ endedAt: 1792183199999, endReason: "searchad goal 종료" })]] });
		saveStore(dir, SESSION, latched);
		const loaded = loadStore(dir, SESSION).job;
		expect(loaded?.groups[0][0].endedAt).toBe(1792183199999);
		expect(loaded?.groups[0][0].endReason).toBe("searchad goal 종료");
	});

	test("a null slot round trips", () => {
		const dir = storeDir();
		saveStore(dir, SESSION, job());
		saveStore(dir, SESSION, null);
		expect(loadStore(dir, SESSION).job).toBeNull();
	});

	test("a v2 job with a non-object job field reads as null", () => {
		const dir = storeDir();
		writeFileSync(storePath(dir, SESSION), JSON.stringify({ version: 2, job: { id: 7, prompt: "x", groups: [] } }));
		expect(loadStore(dir, SESSION).job).toBeNull();
	});

	test("a job with every optional field round trips", () => {
		const dir = storeDir();
		const full = job({
			at: 1792183200000,
			fired: { reason: "searchad goal 종료", at: 1792183199999 },
			groups: [[cond({ endedAt: 1792183199998, endReason: "searchad goal 종료" })]],
		});
		saveStore(dir, SESSION, full);
		expect(loadStore(dir, SESSION).job).toEqual(full);
	});
});

describe("shape-corrupt v2 jobs read as null", () => {
	function loadRaw(value: unknown): { job: unknown; dir: string; bytes: string } {
		const dir = storeDir();
		const bytes = JSON.stringify({ version: 2, job: value });
		writeFileSync(storePath(dir, SESSION), bytes);
		return { job: loadStore(dir, SESSION).job, dir, bytes };
	}

	const base = () => job();

	test("groups is not an array of arrays", () => {
		const { job: loaded, dir, bytes } = loadRaw({ ...base(), groups: ["x"] });
		expect(loaded).toBeNull();
		expect(readFileSync(storePath(dir, SESSION), "utf8")).toBe(bytes);
	});

	test("a group holding a non-object cond", () => {
		expect(loadRaw({ ...base(), groups: [[null]] }).job).toBeNull();
	});

	test("a cond missing goalFile", () => {
		const { goalFile: _goalFile, ...noGoalFile } = cond();
		expect(loadRaw({ ...base(), groups: [[noGoalFile]] }).job).toBeNull();
	});

	test("a boolean fired marker", () => {
		expect(loadRaw({ ...base(), fired: true }).job).toBeNull();
	});

	test("a fired marker with mistyped fields", () => {
		expect(loadRaw({ ...base(), fired: { reason: 1, at: 2 } }).job).toBeNull();
	});

	test("a non-numeric at", () => {
		expect(loadRaw({ ...base(), at: "soon" }).job).toBeNull();
	});
});

describe("v1 migration", () => {
	test("a byte-for-byte v1 fixture with a backslash goalFile migrates", () => {
		const dir = storeDir();
		const fixture = JSON.stringify(
			{
				version: 1,
				jobs: [
					{
						id: "2fc6d435-fd70-4e59-8f5b-1cd519b0b0e4",
						createdAt: 1792183127996,
						prompt: "이 확장을 기본으로 inbox 를 만들어보고자 한다.",
						goal: { sessionId: SESSION, goalId: "66e10db0-6504-4743-939b-4c43960206b0", goalFile: GOAL_FILE, label: "searchad" },
					},
				],
			},
			null,
			2,
		);
		writeFileSync(storePath(dir, SESSION), fixture);
		expect(readFileSync(storePath(dir, SESSION), "utf8")).toContain("C:\\\\Users\\\\yjack");
		const { job: migrated, extraFile, extraCount } = loadStore(dir, SESSION);
		expect(migrated).toEqual(job({ prompt: "이 확장을 기본으로 inbox 를 만들어보고자 한다." }));
		expect(migrated?.groups).toEqual([[cond()]]);
		expect(migrated?.at).toBeUndefined();
		expect(extraFile).toBeUndefined();
		expect(extraCount).toBeUndefined();
	});

	test("a single goal job leaves a version 2 file on disk", () => {
		const dir = storeDir();
		writeFileSync(storePath(dir, SESSION), JSON.stringify({ version: 1, jobs: [v1Job()] }));
		const { job: migrated } = loadStore(dir, SESSION);
		const disk = JSON.parse(readFileSync(storePath(dir, SESSION), "utf8"));
		expect(disk.version).toBe(2);
		expect(disk.job).toEqual(migrated);
		expect(migrated?.groups).toEqual([[cond()]]);
	});

	test("a time-only job migrates to no groups with at", () => {
		const dir = storeDir();
		const at = 1792185000000;
		writeFileSync(storePath(dir, SESSION), JSON.stringify({ version: 1, jobs: [{ id: "time-1", createdAt: 1792183000000, prompt: "30분 뒤", at }] }));
		const { job: migrated } = loadStore(dir, SESSION);
		expect(migrated).toEqual({ id: "time-1", createdAt: 1792183000000, prompt: "30분 뒤", groups: [], at });
	});

	test("three jobs keep the earliest and park the other two in the extras file", () => {
		const dir = storeDir();
		const jobs = [
			{ id: "third", createdAt: 300, prompt: "셋", goal: { ...cond(), label: "third" } },
			{ id: "first", createdAt: 100, prompt: "하나", goal: { ...cond(), label: "first" } },
			{ id: "second", createdAt: 200, prompt: "둘", goal: { ...cond(), label: "second" } },
		];
		writeFileSync(storePath(dir, SESSION), JSON.stringify({ version: 1, jobs }));
		const { job: kept, extraFile, extraCount } = loadStore(dir, SESSION);
		expect(kept?.id).toBe("first");
		expect(kept?.groups).toEqual([[{ ...cond(), label: "first" }]]);
		expect(extraCount).toBe(2);
		expect(extraFile).toBe(join(dir, `${SESSION}.v1-extra.json`));
		const extra = JSON.parse(readFileSync(String(extraFile), "utf8"));
		expect(extra.version).toBe(1);
		expect(extra.jobs.map((j: { id: string }) => j.id)).toEqual(["second", "third"]);
		expect(JSON.parse(readFileSync(storePath(dir, SESSION), "utf8")).version).toBe(2);
	});

	test("an empty jobs list reads as null", () => {
		const dir = storeDir();
		writeFileSync(storePath(dir, SESSION), JSON.stringify({ version: 1, jobs: [] }));
		expect(loadStore(dir, SESSION).job).toBeNull();
	});
});

describe("damaged and missing stores", () => {
	test("corrupt JSON reads as null and leaves the bytes alone", () => {
		const dir = storeDir();
		const bytes = '{"version":2,"job":{oh no';
		writeFileSync(storePath(dir, SESSION), bytes);
		expect(loadStore(dir, SESSION).job).toBeNull();
		expect(readFileSync(storePath(dir, SESSION), "utf8")).toBe(bytes);
	});

	test("a missing store reads as null", () => {
		const dir = storeDir();
		expect(loadStore(dir, SESSION).job).toBeNull();
	});
});
