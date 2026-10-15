// chat frontend — the dashboard widget for the chat channel module.
// Self-contained: owns its per-channel live map, fed by the dashboard
// websocket frames it cares about (`widget.snapshot`, `youtube.chat`,
// `twitch.chat`, `tiktok.chat`, `kick.chat`); no per-widget transport state.
// The core only forwards frames (`onFrame`).
//
// One widget merges the messages of every platform whose channel is filled
// in its config: the feeds are combined (newest first by message time),
// capped by the widget's `history` config, and shown newest-first by default
// (`order: "bottom"` flips to a log-style feed with auto-scroll).
import m from "mithril";
import { Badge } from "../../public/ts/components/ui";
import { t } from "../../public/ts/i18n";
import { decorateText } from "../../public/ts/util";
import type { ServerDashboardWidget } from "../../public/types";
import {
  CHAT_CONFIG_FIELDS,
  CHAT_PLATFORMS,
  chatOrderFromConfig,
  historyLengthFromConfig,
  platformChannel,
} from "./config";
import type {
  ChannelLive,
  ChannelWidgetModule,
  ChatLive,
  ChatPlatform,
  WidgetContext,
} from "./types";
import "./styles.css";

/** Live chat buffer size per channel — matches the backend rolling-buffer
 * HISTORY_CAP, so the widget keeps everything the hub sends (and caps the
 * merged feed further per its own `history` config). */
const CAP = 500;

/** Distance from the bottom of the chat container at which auto-scroll engages. */
const DISTANCE_THRESHOLD = 50;

/** The widget's spec keys — one `<platform>:<channel>` per filled platform
 * channel in its config (the hub keys its snapshot by the same). */
function chatSpecsOf(w: ServerDashboardWidget): { platform: ChatPlatform; spec: string }[] {
  const out: { platform: ChatPlatform; spec: string }[] = [];
  for (const platform of CHAT_PLATFORMS) {
    const channel = platformChannel(platform, w.config);
    if (channel) out.push({ platform, spec: `${platform}:${channel}` });
  }
  return out;
}

/** Live chat data per `<platform>:<channel>`, accumulated from the dashboard
 * websocket. */
const live = new Map<string, ChannelLive>();
const liveFor = (spec: string): ChannelLive => {
  let l = live.get(spec);
  if (!l) {
    l = { chat: [] };
    live.set(spec, l);
  }
  return l;
};

/** One platform chat frame (all four platforms share the same shape). */
type ChatFrame =
  | { channel?: string; message: ChatLive }
  | { channel?: string; reconnect: boolean; messages: ChatLive[] }
  | { channel?: string; disconnected: boolean };

const CHAT_EVENTS = new Set(["youtube.chat", "twitch.chat", "tiktok.chat", "kick.chat"]);

/** Fold one dashboard-websocket frame into this module's live state; the chat
 * frames only — the other widgets' frames are ignored here. */
function onFrame(event: string, data: unknown): void {
  if (event === "widget.snapshot") {
    const snap = data as { chat?: Record<string, { connected?: boolean; messages?: ChatLive[] }> };
    for (const [spec, c] of Object.entries(snap.chat ?? {})) {
      const l = liveFor(spec);
      l.connected = c.connected;
      l.chat = (c.messages ?? []).slice(0, CAP);
    }
    return;
  }
  if (!CHAT_EVENTS.has(event)) return;
  const e = data as ChatFrame;
  if (!e.channel) return;
  // The event is platform-tagged; the channel is not — prefix the platform.
  const platform = event.slice(0, event.indexOf("."));
  const l = liveFor(`${platform}:${e.channel}`);
  if ("message" in e) {
    l.chat = [e.message, ...(l.chat ?? [])].slice(0, CAP);
  } else if ("messages" in e) {
    l.chat = e.messages.slice(0, CAP);
    l.connected = true;
  } else if ("disconnected" in e) {
    l.connected = false;
  }
}

/** The merged feed: the channels' lines combined, newest first by message
 * time, capped by the widget's `history` config, flipped oldest-first when
 * `order` is "bottom" (new messages then enter the feed at the bottom). */
function mergedLines(
  w: ServerDashboardWidget,
): { line: ChatLive; key: string }[] {
  const all: { line: ChatLive; key: string }[] = [];
  for (const { platform, spec } of chatSpecsOf(w)) {
    for (const c of live.get(spec)?.chat ?? []) {
      all.push({ line: c, key: `${platform}:${c.id}` });
    }
  }
  all.sort((a, b) => (b.line.ts ?? 0) - (a.line.ts ?? 0));
  const visible = historyLengthFromConfig(w.config);
  const cut = all.slice(0, Math.max(1, visible));
  if (chatOrderFromConfig(w.config) === "bottom") cut.reverse();
  return cut;
}

/** Card head: the badge (not configured, else online when any channel is
 * connected, offline only when every channel is known to be down). */
function badge(w: ServerDashboardWidget, _ctx: WidgetContext): m.Vnode {
  const specs = chatSpecsOf(w);
  if (!specs.length)
    return <Badge text={t("dash.widget_not_configured")} kind="warn" />;
  let anyUp = false;
  let anyKnown = false;
  for (const { spec } of specs) {
    const c = live.get(spec)?.connected;
    if (c === true) anyUp = true;
    if (c !== undefined) anyKnown = true;
  }
  const down = anyKnown && !anyUp;
  return (
    <Badge
      text={down ? t("dev.badge.offline") : t("dev.badge.online")}
      kind={down ? "off" : "on"}
    />
  );
}

/** One piece of a parsed chat line: a text run or an embedded Kick emote. */
type ChatSegment =
  | { kind: "text"; value: string }
  | { kind: "emote"; id: string; name: string };

/** Kick embeds emotes as `[emote:<id>:<name>]`; split a message into runs
 * (the pattern never occurs on the other platforms). */
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

/** A message body: text runs (links + @mentions + DM dimming via
 * decorateText) plus `img` emotes sized to the line's font. */
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
 * The card body: the merged feed of every configured platform channel
 * (capped by `history`), newest first unless `order` is "bottom" (then oldest
 * first, so new messages land at the bottom). In "bottom" mode the feed
 * auto-scrolls to the newest line when the user is already at the bottom
 * (scrolling up to read history is not interrupted).
 */
const chatAutoScroll = new WeakMap<HTMLElement, boolean>();

function body(w: ServerDashboardWidget, _ctx: WidgetContext): m.Children {
  const specs = chatSpecsOf(w);
  if (!specs.length) return <p class="muted">{t("dash.widget_not_configured")}</p>;

  const lines = mergedLines(w);
  if (!lines.length) return <p class="muted">{t("chat.empty")}</p>;

  const bottom = chatOrderFromConfig(w.config) === "bottom";
  return (
    <div
      class="chat-feed"
      key={`chat-feed${specs.map((s) => s.spec).join(",")}`}
      oncreate={(vnode) => {
        const el = vnode.dom as HTMLElement;
        chatAutoScroll.set(el, true);
        if (bottom) {
          requestAnimationFrame(() => {
            if (el.isConnected) el.scrollTop = el.scrollHeight;
          });
        }
      }}
      onscroll={(event: Event) => {
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
      {lines.map(({ line, key }) => (
        <div class="chat-line" key={key}>
          {line.username && (
            <span
              class="chat-user"
              style={line.color ? `color:${line.color}` : undefined}
            >
              {line.username}
            </span>
          )}
          <span class="chat-text">{lineSegments(line.text ?? "")}</span>
        </div>
      ))}
    </div>
  );
}

/** The module owns its multi-channel config; the core's single-channel hook
 * has no applicable value here. */
function channelOf(_w: ServerDashboardWidget): string {
  return "";
}

const chatModule: ChannelWidgetModule<ServerDashboardWidget> = {
  id: "chat",
  kind: "widget",
  widgetTypes: ["chat"],
  defaultSize: { w: 3, h: 8 },
  configFields: CHAT_CONFIG_FIELDS,
  channelOf,
  body,
  badge,
  onFrame,
};

export default chatModule;
