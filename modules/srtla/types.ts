/* Local types for the srtla module (never imported by the core or other modules). */

export type SrtlaMode = "classic" | "enhanced";

export const SRTLA_MODES: readonly SrtlaMode[] = ["classic", "enhanced"];

/** Live srtla_send process state (the status `srtla` slice). */
export interface SrtlaState {
	running: boolean;
	listenPort?: string;
	remoteHost?: string;
	remotePort?: string;
	startedAt?: number;
	reloadCount?: number;
	lastReloadAt?: number;
}

export interface SrtlaLinkStats {
	name?: string;
	peer_ip?: string;
	status?: string;
	connected?: boolean;
	latency_ms?: number;
	rtt_ms?: number;
	pkt_seq_recv?: number;
	pkt_seq_sent?: number;
	retrans_recv?: number;
	retrans_sent?: number;
	lost_recv?: number;
	feeder_buffer_free_space?: number;
	bind_file_desc?: number;
	pkt_buffer_free_space?: number;
	bitrate_bytes_per_sec?: number;
}

export interface SrtlaStats {
	mode: string;
	quality: boolean;
	links: SrtlaLinkStats[];
}

export interface SrtlaStatsEvent {
	at: number;
	stats: SrtlaStats | null;
}

export interface SrtlaControlState {
	supported: boolean;
	connected: boolean;
}

export interface SrtlaCapabilities {
	controlSocket: boolean;
	mode: boolean;
	quality: boolean;
}

/** srtla_send scheduler settings (`srtla.options`). */
export interface SrtlaOptions {
	mode?: SrtlaMode;
	quality?: boolean;
}

export interface SrtlaOptionsResult {
	options: SrtlaOptions;
	applied: boolean;
}

/** The slice of the core bag this module uses. */
export interface SrtlaCore {
	config: {
		DRY_RUN: boolean;
		RELOAD_MODE: "signal" | "restart";
		SRTLA_SOCKET: string;
		UPLINKS_FILE: string;
	};
	state: {
		srtla: SrtlaState;
		srtlaTarget?: { listenPort: string; remoteHost: string; remotePort: string };
		srtlaOptions?: SrtlaOptions;
	};
	saveState(): Promise<void>;
	logEvent(level: "info" | "warn" | "error", section: string, message: string): void;
	t(key: string, ...args: unknown[]): string;
	Supervisor: new (name: string, delayMs: number, onExit: (code: number | null) => void) => {
		running: boolean;
		pid?: number;
		wanted: boolean;
		start(starter: () => Bun.Subprocess | Promise<Bun.Subprocess>): Promise<void>;
		stop(escalateAfterMs?: number): Promise<void>;
		scheduleRestart(): void;
	};
	errorMessage(err: unknown): string;
	srtlaControl: {
		srtlaCapabilities(bin: string): Promise<SrtlaCapabilities>;
		prepareSrtlaControl(path: string, isSupported: boolean): void;
		startSrtlaControl(path: string): void;
		stopSrtlaControl(): void;
		srtlaControlState(): SrtlaControlState;
		latestSrtlaStats(): SrtlaStatsEvent;
		rpc<T>(method: string, params?: Record<string, unknown>): Promise<T>;
	};
}

/** The context the registry passes to `start`. */
export interface Mctx {
	config: Record<string, unknown>;
	emit(event: string, data: unknown): void;
	log(section: string, message: string): void;
	core: SrtlaCore;
}

/** A browser-side module registration (frontend). Local copy so a module never
 * imports across boundaries; the frontend registry narrows it. */
export interface BridgedModule {
	id: string;
	title: string;
	icon?: string;
	kind: "device-card";
	component: unknown;
	/** Dashboard-widget card body (the widget variant of `component`). */
	cardBody?(host: unknown, status: unknown): unknown;
	defaultSize: { w: number; h: number };
	minSize: { w: number; h: number };
	maxSize?: { w: number; h: number };
	handleEvent?(event: string, data: unknown): void;
}
