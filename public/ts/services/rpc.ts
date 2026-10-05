/* WebSocket RPC client shared by all pages: request/response calls plus server-pushed
 * events, with automatic reconnection. Views just render state and mutate it in the
 * handlers; Mithril redraws. */

export type Params = Record<string, unknown>;
export type EventHandler = (data?: unknown) => void;

const DEFAULT_TIMEOUT_MS = 30_000;
const RECONNECT_MS = 2_000;

export class RpcError extends Error {
	/** Set when the device already recorded the failure in its event log. */
	logged?: boolean;
}

export class RpcClient {
	private ws: WebSocket | null = null;
	private nextId = 1;
	private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	private events = new Map<string, Set<EventHandler>>();
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private destroyed = false;

		constructor(private readonly makeUrl: () => string, autoConnect = true) {
		if (autoConnect) this.connect();
	}

	get open(): boolean {
		return !!this.ws && this.ws.readyState === WebSocket.OPEN;
	}

	/** Subscribe to a server event ("status", "srtla.stats", …); returns an unsubscribe fn. */
	on(type: string, handler: EventHandler): () => void {
		let set = this.events.get(type);
		if (!set) {
			set = new Set();
			this.events.set(type, set);
		}
		set.add(handler);
		return () => set.delete(handler);
	}

	/** One request/response call; rejects on timeout, close, or a `logged` device error. */
	call<T = unknown>(method: string, params?: Params, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
		return new Promise((resolve, reject) => {
			if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
				reject(new RpcError("not connected"));
				return;
			}
			const id = this.nextId++;
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new RpcError(`${method} timed out`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (v) => {
					clearTimeout(timer);
					resolve(v as T);
				},
				reject: (e) => {
					clearTimeout(timer);
					reject(e);
				},
			});
			this.ws.send(JSON.stringify({ id, method, params }));
		});
	}

	destroy(): void {
		this.destroyed = true;
		clearTimeout(this.reconnectTimer);
		this.ws?.close();
	}

	/** Drop the socket; the auto-reconnect fires and "open" handlers re-fetch state. */
	reconnect(): void {
		this.ws?.close();
	}

	/** Connect if not already (for clients built with autoConnect: false). */
	ensureConnected(): void {
		if (!this.ws) this.connect();
	}

	private connect = (): void => {
		const url = this.makeUrl();
		const ws = new WebSocket(url);
		this.ws = ws;

		// "open"/"close" are registered as their own event channels, so server pushes
		// (status, device, …) are never confused with connection lifecycle notifications
		ws.onopen = () => this.emit("open");

		ws.onmessage = (e) => {
			const msg = JSON.parse(String(e.data));
			if (msg.type === "event") this.emit(msg.event, msg.data);
			else if (msg.type === "response") {
				const p = this.pending.get(msg.id);
				if (!p) return;
				this.pending.delete(msg.id);
				if (msg.ok) p.resolve(msg.result);
				else {
					// `logged`: the device already recorded the failure in its event log
					p.reject(Object.assign(new RpcError(msg.error), { logged: !!msg.logged }));
				}
			}
		};

		ws.onclose = () => {
			this.ws = null;
			for (const p of this.pending.values()) p.reject(new RpcError("connection closed"));
			this.pending.clear();
			if (this.destroyed) return;
			this.emit("close");
			this.reconnectTimer = setTimeout(this.connect, RECONNECT_MS);
		};
	};

	private emit(type: string, data?: unknown): void {
		for (const h of this.events.get(type) ?? []) h(data);
	}
}

/** Convenience: build a ws(s):// URL for this page, with an optional path relative to the page. */
export const socketUrl = (path = "ws") => {
	const url = new URL(path, location.href);
	url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
	return url.toString();
};
