export function formatDuration(seconds: number): string {
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}분`;
	const rest = minutes % 60;
	return rest === 0 ? `${Math.floor(minutes / 60)}시간` : `${Math.floor(minutes / 60)}시간 ${rest}분`;
}

export function formatClock(at: number, now: Date = new Date()): string {
	const d = new Date(at);
	const pad = (n: number) => String(n).padStart(2, "0");
	const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
	return d.toDateString() === now.toDateString() ? time : `${d.getMonth() + 1}/${d.getDate()} ${time}`;
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
