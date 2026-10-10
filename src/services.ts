/**
 * Core service accessors — the resolved capability implementations the core
 * files call.
 *
 * Each service is a thin proxy that resolves the capability by name on first
 * property access and re-dispatches through the real implementation, so every
 * method runs with the provider's `this`. Resolving on access (not at import)
 * keeps the core independent of module load order: the backends are discovered
 * and their capabilities provided by the time the first call lands, and a
 * missing provider surfaces at the call site with the capability name. This is
 * the single door through which the core reaches module behaviour by name —
 * never by module id.
 */
import "./registry"; // side effect: discover module backends + provide capabilities
import {
	requireCapability,
	type EncoderServices,
	type ModemServices,
	type ObsServices,
	type SrtlaServices,
} from "./capabilities";

function lazyCapability<T>(name: string): T {
	return new Proxy({} as Record<PropertyKey, unknown>, {
		get(_target, prop) {
			const impl = requireCapability<Record<PropertyKey, unknown>>(name);
			const value = impl[prop];
			return typeof value === "function" ? value.bind(impl) : value;
		},
	}) as T;
}

export const encoderServices: EncoderServices = lazyCapability<EncoderServices>("stream.encoder");
export const srtlaServices: SrtlaServices = lazyCapability<SrtlaServices>("stream.srtla");
export const modemServices: ModemServices = lazyCapability<ModemServices>("stream.modems");
export const obsServices: ObsServices = lazyCapability<ObsServices>("stream.obs");
