/**
 * Shared per-channel state machine for the chat providers. Each platform
 * provider owns its transport (poll loop, IRC websocket, connector, Pusher)
 * and pushes messages through `deliver`; this base owns the parts all four
 * backends shared: the rolling newest-first history (so reconnections don't
 * re-send), the bounded `seen` id set (dedupe across reconnects), the
 * exponential reconnect backoff, and the connection-state frames
 * (`reconnect` with the rolling buffer, `disconnected`).
 */
import { eventFrame, type ChatLive, type ChatPlatform, type PublishFn } from "../types";

/** Rolling history size per channel (newest first). */
export const HISTORY_CAP = 500;
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;

export abstract class ChatProvider {
	/** Normalized channel name (lowercased, no `@`). */
	readonly channel: string;
	/** The platform this provider serves; the wire event is `<platform>.chat`. */
	protected readonly platform: ChatPlatform;
	protected readonly publish: PublishFn;
	connected = false;
	protected stopped = false;
	protected attempt = 0;
	/** most recent messages, newest first */
	protected history: ChatLive[] = [];
	/** recent message ids, deduped across reconnects */
	protected seen = new Set<string>();
	protected reconnectTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		platform: ChatPlatform,
		channel: string,
		publish: PublishFn,
	) {
		this.platform = platform;
		this.channel = channel;
		this.publish = publish;
	}

	/** The snapshot entry for this channel (`widget.snapshot` feed). */
	snapshot(): { connected: boolean; messages: ChatLive[] } {
		return { connected: this.connected, messages: [...this.history] };
	}

	/** Open the transport (the manager's first start of this channel). */
	start(): void {
		this.connect();
	}

	/** Open the transport (first connect and every backoff retry). */
	protected abstract connect(): void;
	/** Close the transport (stop / shutdown). */
	protected abstract teardown(): void;

	stop(): void {
		this.stopped = true;
		this.clearReconnect();
		this.teardown();
	}

	/** Push one message through dedupe/history and out to subscribers. */
	protected deliver(line: ChatLive): void {
		if (this.stopped) return;
		const key = String(line.id);
		if (this.seen.has(key)) return;
		this.seen.add(key);
		this.history.unshift(line);
		if (this.history.length > HISTORY_CAP) this.history.length = HISTORY_CAP;
		// Shed ids of messages evicted from the buffer (newest first, so the
		// tail is oldest) to keep `seen` bounded.
		while (this.seen.size > HISTORY_CAP * 2) {
			const oldest = this.history.pop();
			if (oldest) this.seen.delete(String(oldest.id));
		}
		const event = `${this.platformName()}.chat`;
		this.publish(eventFrame(event, { channel: this.channel, message: line }));
	}

	/**
	 * Flip the connection state, emitting the matching frame: on connecting
	 * the rolling buffer is re-delivered (a fresh viewer can top up), on
	 * disconnecting subscribers learn the channel went dark.
	 */
	protected setConnected(connected: boolean): void {
		const was = this.connected;
		this.connected = connected;
		const event = `${this.platformName()}.chat`;
		if (connected) {
			this.attempt = 0;
			if (!was) this.publish(eventFrame(event, { channel: this.channel, reconnect: true, messages: this.history }));
			return;
		}
		if (was) this.publish(eventFrame(event, { channel: this.channel, disconnected: true }));
	}

	/** Platform name for the wire event / log prefix. */
	protected platformName(): string {
		return this.platform;
	}

	protected log(tag: string, message: string): void {
		console.warn(`[chat ${this.platformName()} ${this.channel}] ${tag}: ${message}`);
	}

	protected clearReconnect(): void {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
	}

	/** Retry with exponential backoff (1 s base, 30 s cap), capped by `stopped`. */
	protected scheduleReconnect(): void {
		if (this.stopped) return;
		const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.attempt, RECONNECT_MAX_MS);
		this.attempt += 1;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.connect();
		}, delay);
	}
}
