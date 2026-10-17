#!/usr/bin/env bun
// Checks that README.md and README.ko.md are mirrors: the ordered heading-level
// sequence must be identical, and both must contain the required strings.
// Usage: bun qa/check-headings.mjs [enPath] [koPath]
import { readFileSync } from "node:fs";

const REQUIRED = ["/after", "/after now", "/after cancel", "omo install", "omo-after-goal"];

const [enPath = "README.md", koPath = "README.ko.md"] = process.argv.slice(2);

/** Ordered headings of an ATX markdown file, ignoring fenced code blocks. */
function headings(path, text) {
	const out = [];
	let fence = false;
	const lines = text.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (/^\s*(```|~~~)/.test(line)) {
			fence = !fence;
			continue;
		}
		if (fence) continue;
		const m = /^(#{1,6})\s+(.*)$/.exec(line);
		if (m) out.push({ level: m[1].length, line: i + 1, text: m[2].trim() });
	}
	return { path, headings: out, text };
}

function read(path) {
	try {
		return headings(path, readFileSync(path, "utf8"));
	} catch (err) {
		fail(`cannot read ${path}: ${err.message}`);
	}
}

function fail(message) {
	console.error(`FAIL ${message}`);
	process.exit(1);
}

const en = read(enPath);
const ko = read(koPath);

const n = Math.max(en.headings.length, ko.headings.length);
for (let i = 0; i < n; i++) {
	const a = en.headings[i];
	const b = ko.headings[i];
	if (!a) fail(`heading #${i + 1} "${b.text}" (${koPath}:${b.line}, level ${b.level}) is missing from ${enPath}`);
	if (!b) fail(`heading #${i + 1} "${a.text}" (${enPath}:${a.line}, level ${a.level}) is missing from ${koPath}`);
	if (a.level !== b.level)
		fail(
			`heading #${i + 1} level differs: ${enPath}:${a.line} "${a.text}" is ${"#".repeat(a.level)} ` +
				`but ${koPath}:${b.line} "${b.text}" is ${"#".repeat(b.level)}`,
		);
}

for (const file of [en, ko]) {
	for (const needle of REQUIRED) {
		if (!file.text.includes(needle)) fail(`${file.path} does not contain ${JSON.stringify(needle)}`);
	}
}

console.log(
	`OK ${enPath} / ${koPath}: ${en.headings.length} headings in the same order (levels ${en.headings
		.map((h) => h.level)
		.join(",")}); required strings present`,
);
