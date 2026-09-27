import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { arg, argFail, argv, enumArg, flag, intArg } from "./args";

export { argv };

const TMP = tmpdir();
export const CONFIG_FILE     = arg("--config", "modems.json");
export const STATE_FILE      = arg("--state", join(TMP, "srtla_state.json"));
export const UPLINKS_FILE    = arg("--uplinks", join(TMP, "srtla_ips.txt"));
export const DRY_RUN         = flag("--dry-run");
export const API_MODE        = flag("--api");
export const API_PORT        = intArg("--port", 8085, 1, 65535);
export const API_HOST        = arg("--host", "127.0.0.1");
// Extra browser origins allowed to open the WebSocket (comma-separated, `*` = any)
export const ALLOWED_ORIGINS = arg("--allow-origin", "").split(",").map((o) => o.trim()).filter(Boolean);
// Outbound control connection: status is pushed to and requests accepted from this server.
// Token/URL may come from env to keep secrets out of the process list.
export const REMOTE_URL      = arg("--remote", process.env.SRTLA_REMOTE_URL ?? "");
export const REMOTE_TOKEN    = arg("--remote-token", process.env.SRTLA_REMOTE_TOKEN ?? "");
export const REMOTE_ID       = arg("--remote-id", process.env.SRTLA_REMOTE_ID ?? hostname());
export const REMOTE_INTERVAL = intArg("--remote-interval", 30);   // periodic status push, seconds (0 = off)
if (REMOTE_URL && !/^wss?:\/\//.test(REMOTE_URL)) argFail("--remote", REMOTE_URL, "ws:// or wss:// URL");

// relay: receives SRT and bonds it out via srtla_send
// encoder: belacoder → SRT to a relay (no bonding, routing or modems)
// combined: belacoder → local srtla_send → bonded uplinks
export const ROLES           = ["relay", "encoder", "combined"] as const;
export type Role             = (typeof ROLES)[number];
export const ROLE: Role      = enumArg("--role", ROLES, (process.env.SRTLA_ROLE as Role | undefined) ?? "relay");
if (!(ROLES as readonly string[]).includes(ROLE)) argFail("SRTLA_ROLE", ROLE, ROLES.join(" | "));
export const HAS_RELAY       = ROLE !== "encoder";
export const HAS_ENCODER     = ROLE !== "relay";

export const BELACODER_BIN   = arg("--belacoder", process.env.BELACODER_BIN ?? "belacoder");
export const PIPELINES_DIR   = arg("--pipelines", process.env.BELACODER_PIPELINES ?? "/usr/share/belacoder/pipelines");
export const BITRATE_FILE    = arg("--bitrate-file", join(TMP, "belacoder_br"));

// Daemon modes imply monitor; encoder-only devices do no bonding so have nothing to watch
export const MONITOR         = HAS_RELAY && (flag("--monitor") || API_MODE || !!REMOTE_URL);
export const RELOAD_MODE     = enumArg("--srtla-reload", ["signal", "restart"] as const, "signal");
export const DEBOUNCE_MS     = intArg("--debounce-ms", 1500);
