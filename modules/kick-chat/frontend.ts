/* kick-chat module UI: a live feed of Kick chat messages (capped at 500, deduped
 * by message id, reconnect redelivers history). The feed autoscrolls to the
 * newest line and pauses on hover. */
import m from "mithril";
import { badge, Card } from "../../public/ts/components/ui";
import type { KickChatMessage } from "../../public/types";
import { t } from "../../public/ts/i18n";
import { st } from "../../public/ts/device/store";
import type { BrowserModule } from "../types";

const BADGE_LABELS: Record<string, string> = {
	mod: "MOD",
	vip: "VIP",
	partner: "PARTNER",
	follow: "FOLLOWER",
	sub: "SUB",
};

const CAP = 500;

const feed = { hovering: false };

function feedEl(messages: KickChatMessage[]): m.Children {
	if (!messages.length) return m("p.muted", t("kickchat.empty"));
	// Newest last; render a bounded window so the DOM stays small
	return messages.slice(-100).map((msg) => {
		const parts: m.Children = [];
		if (msg.username) {
			if (msg.badge?.id) parts.push(m("span.chat-badge", BADGE_LABELS[msg.badge.id] ?? msg.badge.id));
			parts.push(m("span.chat-user", msg.username));
		}
		parts.push(m("span.chat-text", msg.text ?? ""));
		return m("div.kick-chat-line", { key: String(msg.id) }, parts);
	});
}

function kickChatCard(): m.Vnode {
	const enabled = st.modules["kick-chat"]?.enabled;
	const messages = st.kick.chat;
	const scrollHook: m.Component<{ onmouseenter?: () => void; onmouseleave?: () => void }> = {
		onupdate(vnode) {
			const el = vnode.dom as HTMLElement;
			if (!feed.hovering && el.scrollHeight > 0) el.scrollTop = el.scrollHeight;
		},
		view() {
			return m("div.kick-chat-feed", feedEl(messages));
		},
	};
	return m(
		Card,
		{ title: t("kickchat.card") },
		!enabled ? m("p.muted", t("kickchat.disabled")) : [
			m("div.badge-row", badge(st.kick.connected ? t("kickchat.connected") : t("kickchat.disconnected"), st.kick.connected ? "on" : "warn")),
			m(scrollHook, {
				onmouseenter: () => (feed.hovering = true),
				onmouseleave: () => (feed.hovering = false),
			}),
		],
	);
}

function handleEvent(event: string, data: unknown): void {
	if (event !== "kick.chat") return;
	const ev = data as {
		message?: KickChatMessage;
		reconnect?: boolean;
		messages?: KickChatMessage[];
		disconnected?: boolean;
	};
	if (ev.disconnected) st.kick.connected = false;
	if (ev.reconnect) {
		st.kick.connected = true;
		st.kick.chat = (ev.messages ?? []).slice(-CAP);
	} else if (ev.message) {
		st.kick.connected = true;
		const chat = st.kick.chat;
		if (!chat.some((x) => String(x.id) === String(ev.message!.id))) chat.push(ev.message);
		if (chat.length > CAP) chat.splice(0, chat.length - CAP);
	}
	m.redraw();
}

export const kickChatModule: BrowserModule = {
	id: "kick-chat",
	title: "Kick chat",
	component: () => kickChatCard(),
	defaultWidth: "full",
	handleEvent,
};
