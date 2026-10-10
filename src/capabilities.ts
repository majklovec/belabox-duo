/**
 * Capability bus — the seam between the device core and the modules for
 * runtime services.
 *
 * A module exposes the services the core needs under capability names in its
 * registration's `services.capabilities` record (see modules/README.md). The
 * backend registry wires those records into this bus at load time, so the
 * core files (stream.ts, routing.ts, ...) reach module behaviour through
 * `requireCapability("stream.encoder")` and never name a module id.
 *
 * Capability names are core vocabulary (dotted namespaces), independent of
 * module ids: removing a module breaks the capabilities that depended on it,
 * everything else keeps working.
 */

const provided = new Map<string, unknown>();

/** Register a capability implementation. Re-registering replaces the old one. */
export function provideCapability<T>(name: string, impl: T): T {
	provided.set(name, impl);
	return impl;
}

/** Look up a capability by name. Throws when no module provides it. */
export function requireCapability<T = unknown>(name: string): T {
	const impl = provided.get(name);
	if (impl === undefined) throw new Error(`capability ${JSON.stringify(name)} is not provided by any module`);
	return impl as T;
}

/** Whether a capability is currently provided. */
export const hasCapability = (name: string): boolean => provided.has(name);

/** Drop all capabilities (registry reload, tests). */
export function clearCapabilities(): void {
	provided.clear();
}

/*
 * Capability service shapes — the core types it reads off the bus by name.
 * They are structural: a module's `services.capabilities` record provides an
 * object matching the shape the core expects for a given capability name.
 * Kept here (core-owned) so the core names the interfaces, never the modules.
 */
import type {
	CeraConfig,
	EncoderConfig,
	EncoderState,
	ModemInfo,
	SrtlaState,
	SwitcherStatus,
} from "../public/types";
import type { SrtlaOptions, SrtlaOptionsResult, SrtlaTarget } from "./state";
import type { SrtlaControlState, SrtlaMode, SrtlaStatsEvent } from "./srtlaControl";
import type { ObsClient } from "../obs-client";

/** `stream.encoder` — the encoder's live process + pipeline/audio source list. */
export interface EncoderServices {
	encoder(): {
		status(): EncoderState;
		start(cfg: EncoderConfig): Promise<void>;
		stop(): Promise<void>;
		validate(cfg: EncoderConfig): void;
	};
	loadEncoder(): unknown;
	listPipelines(): Promise<string[]>;
	listAudioSources(): Promise<string[]>;
	ceracoderConfig(): CeraConfig | null;
	AUDIO_CODECS: readonly ("aac" | "opus")[];
	AUDIO_DEFAULT: string;
	AUDIO_NONE: string;
	isCera(enc: unknown): boolean;
}

/** `stream.srtla` — the srtla_send process, its scheduler, stats and autostart. */
export interface SrtlaServices {
	srtlaStatus(): SrtlaState;
	startSrtla(listenPort: string, remoteHost: string, remotePort: string): Promise<SrtlaState>;
	stopSrtla(): Promise<void>;
	reloadSrtla(): Promise<void>;
	setSrtlaOptions(opts: SrtlaOptions): Promise<SrtlaOptionsResult>;
	latestStats(): SrtlaStatsEvent;
	controlState(): SrtlaControlState;
	modes: readonly SrtlaMode[];
	maybeStartSrtla(argv: string[]): Promise<boolean>;
}

/** `stream.modems` — modem detection + interface enrichment for routing. */
export interface ModemServices {
	detect(): Promise<ModemInfo[]>;
	modemIface(m: ModemInfo): Promise<string>;
	modemForIface?(name: string): ModemInfo | null;
}

/** `stream.obs` — the obs.* method dispatch reaches the module's OBS client. */
export interface ObsServices {
	client(): ObsClient | null;
	subscriptionMask(names: string[]): number;
	configure(config: Record<string, unknown>): void;
}

/** `stream.switcher` — the low-bitrate switcher status (obs sub-component). */
export interface SwitcherServices {
	status(): SwitcherStatus | null;
}

export type { SrtlaTarget };
