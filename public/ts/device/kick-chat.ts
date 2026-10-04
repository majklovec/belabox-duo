/* kick-chat module UI: a live feed of Kick chat messages (capped at 500, deduped by message id,
 * reconnect redelivers history). The feed autoscrolls to the newest line and pauses on hover. */
import m from "mithril";
import { badge, Card } from "../components/ui";
import type { KickChatMessage } from "../../types";
import { t } from "../i18n";
import { st } from "./store";

const BADGE_LABELS: Record<string, string> = {
	mod: "MOD",
	vip: "VIP",
	partner: "PARTNER",
	follow: "FOLLOWER",
	sub: "SUB",
};

const feed = { hovering: false };

export function kickChatCard(): m.Vnode {
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
