/* Event log: device entries arrive via `log` events (persisted on the device; the control
 * server adds its own online / offline ones); browser entries (connection, request failures)
 * live in this page only. */
import m from "mithril";
import { LOG_MAX, type LogEntry, type LogEvent, label } from "../../../src/logMessages";
import { Card } from "../components/ui";
import { t } from "../i18n";
import { type Level, levelIcon } from "../icons";
import { css, cx } from "styled-system/css";

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
	return (
		<time datetime={date.toISOString()} title={date.toLocaleString()}>
			{today ? date.toLocaleTimeString() : date.toLocaleString()}
		</time>
	);
}

export const LogCard: m.Component = {
	view: () => (
		<Card title={t("dev.card.log")}>
			<code id="log" class={css({display: "flex", flexDirection: "column", overflowY: "auto", fontFamily: "mono", fontSize: "0.75rem", lineHeight: "1rem"})}>
				{sorted().map((e) => (
					<li key={keyOf(e)} class={cx(css({ display: "flex", alignItems: "center", gap: "0.5rem", borderRadius: "0.25rem", paddingInline: "0.5rem", paddingBlock: "0.25rem" }), e.level === "error" ? css({ color: "error" }) : e.level === "warn" ? css({ color: "warning" }) : undefined)}>
						{levelIcon(e.level)}
						{time(e.at)}
						<span class={css({textTransform: "uppercase", opacity: "0.6"})}>{t(LEVEL_KEY[e.level])}</span>
						<span class={css({opacity: "0.7"})}>{label(e.section)}</span>
						<span class={css({minWidth: "0px", flex: "1"})}>{e.message}</span>
						{(e.count ?? 1) > 1 && <span class={css({opacity: "0.6"})}>×{e.count}</span>}
					</li>
				))}
			</code>
		</Card>
	),
};
