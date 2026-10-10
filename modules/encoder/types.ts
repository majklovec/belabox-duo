/* Local types for the encoder module (never imported by the core or other modules). */

/** One GStreamer pipeline file found under the pipelines dir. */
export interface Pipeline {
	id: string;
	group: string;
	name: string;
	asrc: boolean;
	acodec: boolean;
	overlay: boolean;
}

/** One ALSA capture card (or the "default" / "none" pseudo sources). */
export interface AudioSource {
	id: string;
	name: string;
}

/** Persisted encoder settings (`encoder.start` params, the `encoder` status slice). */
export interface EncoderConfig {
	pipeline: string;
	host: string;
	port: string;
	delay: number;
	latency: number;
	streamid?: string;
	minBitrate?: number;
	maxBitrate?: number;
	audioSource?: string;
	audioCodec?: string;
	bitrateOverlay?: boolean;
}

/** Live encoder process state (the status `encoder` slice). */
export interface EncoderState {
	running: boolean;
	config?: EncoderConfig;
	startedAt?: number;
	pid?: number;
	restarts?: number;
	lastError?: string;
}

export type CeraBalancer = "adaptive" | "fixed" | "aimd";

export interface AdaptiveTuning {
	incrStep: number;
	decrStep: number;
	incrInterval: number;
	decrInterval: number;
}

export interface AimdTuning {
	incrStep: number;
	decrMult: number;
	incrInterval: number;
	decrInterval: number;
}

/** ceracoder bitrate-control settings (the persisted `ceracoder` section). */
export interface CeraConfig {
	balancer: CeraBalancer;
	minBitrate: number;
	adaptive: AdaptiveTuning;
	aimd: AimdTuning;
}

export const BITRATE_KBPS = { min: 300, max: 30_000 } as const;

/** The slice of the core bag this module uses. */
export interface EncoderCore {
	config: {
		BITRATE_FILE: string;
		CERACODER_CONF: string;
		DRY_RUN: boolean;
		ENCODER_BIN: string;
		IS_CERA: boolean;
		PIPELINES_DIR: string;
	};
	state: {
		encoder: EncoderState;
		ceracoder?: CeraConfig;
	};
	saveState(): Promise<void>;
	notifyStateChange(): void;
	logEvent(level: "info" | "warn" | "error", section: string, message: string): void;
	t(key: string, ...args: unknown[]): string;
	writeFileAtomic(path: string, data: string): Promise<void>;
	Supervisor: new (name: string, delayMs: number, onExit: (code: number | null) => void) => {
		running: boolean;
		pid?: number;
		wanted: boolean;
		markWanted(): void;
		start(starter: () => Bun.Subprocess | Promise<Bun.Subprocess>): Promise<void>;
	 stop(escalateAfterMs?: number): Promise<void>;
		scheduleRestart(): void;
	};
	errorMessage(err: unknown): string;
	readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string>;
}

/** The context the registry passes to `start`. */
export interface Mctx {
	config: Record<string, unknown>;
	emit(event: string, data: unknown): void;
	log(section: string, message: string): void;
	core: EncoderCore;
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
