/* Event log: device entries arrive via `log` events (persisted on the device; the control
 * server adds its own online / offline ones); browser entries (connection, request failures)
 * live in this page only. */
import m from "mithril";
import { LOG_MAX, type LogEntry, type LogEvent, label } from "../../../src/logMessages";
import { Card } from "../components/ui";
import { t } from "../i18n";
import { type Level, levelIcon } from "../icons";

const LEVEL_KEY: Record<Level, string> = {
	info: "log.level.info",
	warn: "log.level.warning",
	error: "log.level.error",
};

const rows = new Map<string, LogEntry>();
const keyOf = (e: LogEntry) => `${e.origin ?? "device"}:${e.id}`;
let nextLocalId = 1;

export function applyLog(data: LogEvent): void {
	if (data.reset) {
		for (const [key, e] of rows) if (e.origin !== "browser") rows.delete(key);
	}
	for (const e of data.entries) rows.set(keyOf(e), e);
	m.redraw();
}

/** Browser-side entry; a repeat of the newest entry bumps its counter instead. */
export function log(level: Level, section: string, message: string): void {
	const at = Date.now();
	const newest = [...rows.values()].reduce<LogEntry | undefined>((n, e) => (!n || e.at >= n.at ? e : n), undefined);
	if (
		newest?.origin === "browser" &&
		newest.level === level &&
		newest.section === section &&
		newest.message === message
	) {
		newest.count = (newest.count ?? 1) + 1;
		newest.at = at;
	} else {
		const entry: LogEntry = { id: nextLocalId++, origin: "browser", at, level, section, message };
		rows.set(keyOf(entry), entry);
	}
	m.redraw();
}

/** Newest first, trimmed to LOG_MAX. */
function sorted(): LogEntry[] {
	const list = [...rows.values()].sort((a, b) => b.at - a.at || b.id - a.id);
	for (const old of list.splice(LOG_MAX)) rows.delete(keyOf(old));
	return list;
}

function time(at: number): m.Vnode {
	const date = new Date(at);
	const today = date.toDateString() === new Date().toDateString();
	return m(
		"time",
		{ datetime: date.toISOString(), title: date.toLocaleString() },
		today ? date.toLocaleTimeString() : date.toLocaleString(),
	);
}

export const LogCard: m.Component = {
	view: () =>
		m(
			Card,
			{ title: t("dev.card.log") },
			m(
				"code#log",
				sorted().map((e) =>
					m(
						"li",
						{ key: keyOf(e), class: `log-${e.level}` },
						levelIcon(e.level),
						time(e.at),
						m("span.log-level", t(LEVEL_KEY[e.level])),
						m("span.log-section", label(e.section)),
						m("span.log-message", e.message),
						m("span.log-count", (e.count ?? 1) > 1 ? `×${e.count}` : null),
					),
				),
			),
		),
};
