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
 * `order` is "bottom" (new messages then enter the feed at the bottom). Each
 * line carries its source platform so the view can badge them. */
function mergedLines(
  w: ServerDashboardWidget,
): { line: ChatLive; key: string; platform: ChatPlatform }[] {
  const all: { line: ChatLive; key: string; platform: ChatPlatform }[] = [];
  for (const { platform, spec } of chatSpecsOf(w)) {
    for (const c of live.get(spec)?.chat ?? []) {
      all.push({ line: c, key: `${platform}:${c.id}`, platform });
    }
  }
  all.sort((a, b) => (b.line.ts ?? 0) - (a.line.ts ?? 0));
  const visible = historyLengthFromConfig(w.config);
  const cut = all.slice(0, Math.max(1, visible));
  if (chatOrderFromConfig(w.config) === "bottom") cut.reverse();
  return cut;
}

/** Per-line platform icon (only shown when the widget merges more than one
 * platform). Rendered as trusted innerHTML. Kick is an inline "K" in Kick's
 * green — the app only serves bundled assets, so a file reference
 * (`assets/kick-logo.ico`) would 404. */
const PLATFORM_ICONS: Record<ChatPlatform, string> = {
  twitch: `<svg viewBox="0 0 256 268" aria-hidden="true"><path fill="#9146ff" d="M17.46 0L0 46.56v185.21h63.14V268h46.87l36.49-36.23h54.91L256 177.68V0H17.46zm23.07 23.07H232.9v143.14l-41.47 41.47h-69.15L85.79 244.2v-36.52H40.53V23.07zm69.15 104.55h23.07V69.26h-23.07v58.36zm63.14 0h23.07V69.26h-23.07v58.36z"/></svg>`,
  youtube: `<svg viewBox="0 0 576 512" aria-hidden="true"><path fill="#ff0000" d="M549.66 124.63a68.28 68.28 0 0 0-48.05-48.28C458.78 64 288 64 288 64S117.22 64 74.39 76.35a68.28 68.28 0 0 0-48.05 48.28C14.48 167.83 14.48 256 14.48 256s0 88.17 11.86 131.37a68.28 68.28 0 0 0 48.05 48.28C117.22 448 288 448 288 448s170.78 0 213.61-12.35a68.28 68.28 0 0 0 48.05-48.28C561.52 344.17 561.52 256 561.52 256s0-88.17-11.86-131.37zM232.15 337.28V174.72L374.86 256l-142.71 81.28z"/></svg>`,
  kick: `<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="#53fc18"><rect x="3.5" y="2" width="5" height="20" rx="1.2"/><polygon points="9,12 21,2.5 21,8.5 11.5,15.5"/><polygon points="9,12 21,21.5 21,15.5 11.5,8.5"/></g></svg>`,
  tiktok: `<svg viewBox="0 0 448 512" aria-hidden="true"><path fill="#eef4ff" d="M448,209.91a210.06,210.06,0,0,1-122.77-39.25V349.38A162.55,162.55,0,1,1,185,188.31V278.2a74.62,74.62,0,1,0,52.23,71.18V0l88,0a121.18,121.18,0,0,0,1.86,22.17h0A122.18,122.18,0,0,0,381,102.39a121.43,121.43,0,0,0,67,20.14Z"/></svg>`,
};

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
  // Badge each line with its platform only when the widget mixes platforms —
  // a single-platform feed needs no per-line source marker.
  const mixed = specs.length > 1;

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
      {lines.map(({ line, key, platform }) => (
        <div class="chat-line" key={key}>
          {mixed && (
            <span class="chat-icon" title={platform}>
              {m.trust(PLATFORM_ICONS[platform])}
            </span>
          )}
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
