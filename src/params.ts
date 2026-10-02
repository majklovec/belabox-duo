/*
 * Request parameter validation for the WebSocket API. Every helper throws an
 * ApiError (HTTP-like `code`, 400 by default) with a message naming the parameter.
 */
import { COLOR_RE, HOSTNAME_RE, REMOTE_URL_RE } from "./validate";

export type Params = Record<string, unknown>;

export class ApiError extends Error {
	constructor(message: string, readonly code = 400) {
		super(message);
	}
}

export function requireString(p: Params, key: string): string {
	const v = p[key];
	if (typeof v === "number") return String(v);
	if (typeof v === "string" && v) return v;
	throw new ApiError(`${key} is required`);
}

export function optionalStringList(p: Params, key: string): string[] | undefined {
	const v = p[key];
	if (v === undefined) return undefined;
	if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
		throw new ApiError(`${key} must be an array of strings`);
	}
	return v;
}

export function optionalInt(p: Params, key: string, fallback: number, min: number, max: number): number {
	const v = p[key];
	if (v === undefined || v === null || v === "") return fallback;
	const n = Number(v);
	if (!Number.isInteger(n) || n < min || n > max) {
		throw new ApiError(`${key} must be an integer between ${min} and ${max}`);
	}
	return n;
}

export function requirePort(p: Params, key: string): string {
	if (p[key] === undefined || p[key] === "") throw new ApiError(`${key} is required`);
	return String(optionalInt(p, key, 0, 1, 65535));
}

/** Hostnames / IPs only — anything else could be mistaken for a CLI flag by the child process. */
export function requireHost(p: Params, key: string): string {
	const v = requireString(p, key);
	if (!/^[A-Za-z0-9[][A-Za-z0-9.:_[\]-]*$/.test(v)) throw new ApiError(`${key} is not a valid host`);
	return v;
}

export function requireBoolean(p: Params, key: string): boolean {
	if (typeof p[key] !== "boolean") throw new ApiError(`${key} must be a boolean`);
	return p[key];
}

/** `value` if it is one of `allowed`, else an error naming `key`. */
export function oneOf<T extends string>(value: unknown, key: string, allowed: readonly T[]): T {
	if (!(allowed as readonly unknown[]).includes(value)) {
		throw new ApiError(`${key} must be one of ${allowed.join(", ")}`);
	}
	return value as T;
}

/** A trimmed string setting: `current` when absent, undefined when blank. */
export function optionalSettingString(p: Params, key: string, current: string | undefined): string | undefined {
	const value = p[key];
	if (value === undefined) return current;
	if (typeof value !== "string") throw new ApiError(`${key} must be a string`);
	return value.trim() || undefined;
}

export function requireModemIndex(p: Params): number {
	const n = Number(p.index);
	if (p.index === undefined || !Number.isInteger(n) || n < 0) {
		throw new ApiError("index must be a non-negative integer");
	}
	return n;
}

// ----------------------------------------------------------------------
// Device settings (setup wizard and settings page); undefined = not set
// ----------------------------------------------------------------------
function format(value: string | undefined, re: RegExp, message: string): string | undefined {
	if (value !== undefined && !re.test(value)) throw new ApiError(message);
	return value;
}

export const checkHostname = (v: string | undefined) =>
	format(v, HOSTNAME_RE, "hostname must contain only letters, numbers, dots and hyphens");
export const checkColor = (v: string | undefined) => format(v, COLOR_RE, "color must be a six-digit hexadecimal color");
export const checkRemoteUrl = (v: string | undefined) =>
	format(v, REMOTE_URL_RE, "remoteUrl must be a ws:// or wss:// URL");
