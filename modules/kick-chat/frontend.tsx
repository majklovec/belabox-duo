// kick-chat frontend — the dashboard widget for the kick-chat channel module.
// Self-contained: owns its per-channel live map, fed by the dashboard
// websocket frames it cares about (`widget.snapshot`, `kick.chat`); no
// per-widget transport state. The core only forwards frames (`onFrame`).
import m from "mithril";
import { Badge } from "../../public/ts/components/ui";
import { t } from "../../public/ts/i18n";
import { decorateText } from "../../public/ts/util";
import type { ServerDashboardWidget } from "../../public/types";
import {
  chatOrderFromConfig,
  DEFAULT_HISTORY_LINES,
  historyLengthFromConfig,
  KICK_CHAT_CONFIG_FIELDS,
} from "./backend";
import type {
  ChannelLive,
  ChannelWidgetModule,
  ChatLive,
  WidgetContext,
} from "./types";
import "./styles.css";

/** Live chat buffer size per channel — matches the backend rolling-buffer
 * HISTORY_CAP, so the widget keeps everything the hub sends (and caps further
 * per its own `history` config). */
const CAP = 500;

/** Distance from the bottom of the chat container at which auto-scroll engages. */
const DISTANCE_THRESHOLD = 50;

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
      liveFor(e.channel).chat = [
        e.message,
        ...(liveFor(e.channel).chat ?? []),
      ].slice(0, CAP);
    else if ("messages" in e)
      liveFor(e.channel).chat = e.messages.slice(0, CAP);
  }
}

/** The widget's channel name ("" when not configured) — the module owns which
 * config parameter carries it. */
function channelOf(w: ServerDashboardWidget): string {
  return (w.config?.["channel"] ?? "").trim().toLowerCase();
}

/** The most recent `historyLength` lines of the channel feed (newest first —
 * the backend buffer is stored newest-first, so slice from the front), flipped
 * oldest-first when the widget's `order` config is "bottom" (new messages then
 * enter the log at the bottom). Defaults via the hub's validated config helpers. */
function liveLines(
  w: ServerDashboardWidget,
  live: ChannelLive,
): ChannelLive["chat"] {
  const visible = historyLengthFromConfig(w.config) ?? DEFAULT_HISTORY_LINES;
  const lines = (live.chat ?? []).slice(0, Math.max(1, visible));
  return chatOrderFromConfig(w.config) === "bottom"
    ? [...lines].reverse()
    : lines;
}

/** Card head: the channel badge (not configured, else online/disconnected). */
function badge(w: ServerDashboardWidget, _ctx: WidgetContext): m.Vnode {
  const channel = channelOf(w);
  if (!channel)
    return <Badge text={t("dash.widget_not_configured")} kind="warn" />;
  const l = live.get(channel) ?? {};
  return (
    <Badge
      text={l.connected === false ? t("dev.badge.offline") : t("dev.badge.online")}
      kind={l.connected === false ? "off" : "on"}
    />
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

/**
 * The card body: the chat feed (capped by historyLength), newest first unless
 * the widget's `order` config is "bottom" (then oldest first, so new messages
 * land at the bottom). In "bottom" mode the feed auto-scrolls to the newest
 * line when the user is already at the bottom (scrolling up to read history
 * is not interrupted).
 */

const chatAutoScroll = new WeakMap<HTMLElement, boolean>();

function body(w: ServerDashboardWidget, _ctx: WidgetContext): m.Children {
  const channel = channelOf(w);
  if (!channel) return <p class="muted">{t("dash.widget_not_configured")}</p>;

  const l = live.get(channel) ?? { chat: [] };
  const lines = liveLines(w, l);
  const bottom = chatOrderFromConfig(w.config) === "bottom";

  if (!lines?.length) return <p class="muted">{t("kickchat.empty")}</p>;

  return (
    <div
      class="kick-chat-feed"
      key={channel}
      oncreate={(vnode) => {
        const el = vnode.dom as HTMLElement;
        chatAutoScroll.set(el, true);
        if (bottom) {
          requestAnimationFrame(() => {
            if (el.isConnected) el.scrollTop = el.scrollHeight;
          });
        }
      }}
      onscroll={(event) => {
        const el = event.currentTarget as HTMLElement;
        const distance = el.scrollHeight - el.clientHeight - el.scrollTop;
        chatAutoScroll.set(el, distance <= DISTANCE_THRESHOLD);
      }}
      onupdate={(vnode) => {
        const el = vnode.dom as HTMLElement;
        if (bottom && chatAutoScroll.get(el)) {
          requestAnimationFrame(() => {
            if (el.isConnected && chatAutoScroll.get(el))
              el.scrollTop = el.scrollHeight;
          });
        }
      }}
    >
      {lines.map((c) => (
        <div class="kick-chat-line" key={String(c.id)}>
          {c.username && (
            <span
              class="chat-user"
              style={c.color ? `color:${c.color}` : undefined}
            >
              {c.username}
            </span>
          )}
          <span class="chat-text">{lineSegments(c.text ?? "")}</span>
        </div>
      ))}
    </div>
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
