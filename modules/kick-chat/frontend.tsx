// kick-chat frontend — the dashboard widget for the kick-chat channel module.
// Self-contained: owns its per-channel live map, fed by the dashboard
// websocket frames it cares about (`widget.snapshot`, `kick.chat`); no
// per-widget transport state. The core only forwards frames (`onFrame`).
import m from "mithril";
import type { ServerDashboardWidget } from "../../public/types";
import {
  ChannelWidgetModule,
  ChatLive,
  type ChannelLive,
  type WidgetContext,
} from "./types";
import { badge as badgeEl } from "../../public/ts/components/ui";
import { decorateText } from "../../public/ts/util";
import { t } from "../../public/ts/i18n";
import { DEFAULT_HISTORY_LINES, KICK_CHAT_CONFIG_FIELDS, historyLengthFromConfig } from "./backend";
import "./styles.css";

/** Live chat buffer size per channel — matches the backend rolling-buffer
 * HISTORY_CAP, so the widget keeps everything the hub sends (and caps further
 * per its own `history` config). */
const CAP = 500;

/** Live kick-chat data per channel, accumulated from the dashboard websocket. */
const live = new Map<string, ChannelLive>();
const liveFor = (channel: string): ChannelLive => {
  let l = live.get(channel);
  if (!l) {
    l = { chat: [] };
    live.set(channel, l);
  }
  return l;
};

/** Fold one dashboard-websocket frame into this module's live state; the kick
 * chat frames only — the other channels' frames are ignored here. */
function onFrame(event: string, data: unknown): void {
  if (event === "widget.snapshot") {
    const snap = data as { chat?: Record<string, { messages?: ChatLive[] }> };
    for (const [channel, c] of Object.entries(snap.chat ?? {}))
      liveFor(channel).chat = (c.messages ?? []).slice(0, CAP);
  } else if (event === "kick.chat") {
    const e = data as
      | { channel?: string; message: ChatLive }
      | { channel?: string; reconnect: boolean; messages: ChatLive[] };
    if (!e.channel) return;
    if ("message" in e)
      liveFor(e.channel).chat = [e.message, ...(liveFor(e.channel).chat ?? [])].slice(0, CAP);
    else if ("messages" in e) liveFor(e.channel).chat = e.messages.slice(0, CAP);
  }
}

/** The widget's channel name ("" when not configured) — the module owns which
 * config parameter carries it. */
function channelOf(w: ServerDashboardWidget): string {
  return (w.config?.["channel"] ?? "").trim().toLowerCase();
}

/** The most recent `historyLength` lines of the channel feed (newest first —
 * the backend buffer is stored newest-first, so slice from the front). Defaults
 * via the hub's validated config helper. */
function liveLines(w: ServerDashboardWidget, live: ChannelLive): ChannelLive["chat"] {
  const visible = historyLengthFromConfig(w.config) ?? DEFAULT_HISTORY_LINES;
  return (live.chat ?? []).slice(0, Math.max(1, visible));
}

/** Card head: the channel badge (not configured, else online/disconnected). */
function badge(w: ServerDashboardWidget, _ctx: WidgetContext): m.Vnode {
  const channel = channelOf(w);
  if (!channel) return badgeEl(t("dash.widget_not_configured"), "warn");
  const l = live.get(channel) ?? {};
  return badgeEl(
    l.connected === false ? t("dev.badge.offline") : t("dev.badge.online"),
    l.connected === false ? "off" : "on",
  );
}

/** One piece of a parsed chat line: a text run or an embedded Kick emote. */
type ChatSegment =
  | { kind: "text"; value: string }
  | { kind: "emote"; id: string; name: string };

/** Kick embeds emotes as `[emote:<id>:<name>]`; split a message into runs. */
const EMOTE_RE = /\[emote:(\d+):([^\]]*)\]/g;
function parseSegments(text: string): ChatSegment[] {
  const out: ChatSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(EMOTE_RE)) {
    const idx = match.index ?? 0;
    if (idx > last) out.push({ kind: "text", value: text.slice(last, idx) });
    out.push({ kind: "emote", id: match[1], name: match[2].trim() });
    last = idx + match[0].length;
  }
  if (last < text.length) out.push({ kind: "text", value: text.slice(last) });
  return out;
}

// Emote ids whose image 404'd — shown as a plain name afterwards instead of a
// broken image. Removing a Mithril-owned node directly desyncs reconciliation.
const failedEmotes = new Set<string>();

/** A message body: text runs plus `img` emotes sized to the line's font. */
function lineSegments(text: string): m.Children {
  return parseSegments(text).map((s, i) =>
    s.kind === "text" ? (
      <span key={i}>{m.trust(decorateText(s.value))}</span>
    ) : failedEmotes.has(s.id) ? (
      <span class={"chat-emote-name"} key={i}>
        {s.name}
      </span>
    ) : (
      <img
        class={"chat-emote"}
        key={i}
        src={`https://files.kick.com/emotes/${s.id}/fullsize`}
        alt={s.name}
        loading={"lazy"}
        onerror={() => {
          failedEmotes.add(s.id);
          m.redraw();
        }}
      />
    ),
  );
}

/** The card body: the chat feed (newest first, capped by historyLength). */
function body(w: ServerDashboardWidget, _ctx: WidgetContext): m.Children {
  const channel = channelOf(w);
  if (!channel) return <p class={"muted"}>{t("dash.widget_not_configured")}</p>;
  const l = live.get(channel) ?? { chat: [] };
  const lines = liveLines(w, l);
  const msgs = (lines ?? []).map((c) => (
    <div class={"kick-chat-line"} key={String(c.id)}>
      {c.username ? (
        <span
          class={"chat-user"}
          style={c.color ? `color:${c.color}` : undefined}
        >
          {c.username}
        </span>
      ) : null}
      <span class={"chat-text"}>{lineSegments(c.text ?? "")}</span>
    </div>
  ));
  return msgs.length ? (
    <div class={"kick-chat-feed"}>{msgs}</div>
  ) : (
    <p class={"muted"}>{t("kickchat.empty")}</p>
  );
}

const kickChatModule: ChannelWidgetModule<ServerDashboardWidget> = {
  id: "kick-chat",
  kind: "widget",
  widgetTypes: ["kick-chat"],
  defaultSize: { w: 3, h: 4 },
  configFields: KICK_CHAT_CONFIG_FIELDS,
  channelOf,
  body,
  badge,
  onFrame,
};

export default kickChatModule;
