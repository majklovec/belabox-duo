import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { arg, argFail, argv, enumArg, flag, intArg } from "./args";

export { argv };

const TMP = tmpdir();
export const CONFIG_FILE = arg("--config", "modems.json");
// The uuid is auto-assigned once and lives in the state file (see state.ts); load it
// and the saved startup settings from there instead of taking a command-line override.
export const STATE_FILE = arg("--state", join(TMP, "srtla_state.json"));
interface PersistedStartup {
    settings?: { uuid?: string; hostname?: string; role?: string; remoteUrl?: string; remoteToken?: string };
}
const persistedStartup = await Bun.file(STATE_FILE).json().catch(() => ({} as PersistedStartup)) as PersistedStartup;
// Event log shown in the web UI; next to the state file so it persists wherever state does
export const LOG_FILE     = arg("--log-file", join(dirname(STATE_FILE), "srtla_log.json"));
export const UPLINKS_FILE = arg("--uplinks", join(TMP, "srtla_ips.txt"));
export const DRY_RUN         = flag("--dry-run");
export const API_PORT        = intArg("--port", 8085, 1, 65535);
export const API_HOST        = arg("--host", "127.0.0.1");
// Extra browser origins allowed to open the WebSocket (comma-separated, `*` = any)
export const ALLOWED_ORIGINS = arg("--allow-origin", "").split(",").map((o) => o.trim()).filter(Boolean);
// Outbound control connection: status is pushed to and requests accepted from this server.
// Token/URL may come from env to keep secrets out of the process list.
export const REMOTE_URL      = arg("--remote", process.env.SRTLA_REMOTE_URL ?? persistedStartup.settings?.remoteUrl ?? "");
export const REMOTE_TOKEN    = arg("--remote-token", process.env.SRTLA_REMOTE_TOKEN ?? persistedStartup.settings?.remoteToken ?? "");
export const REMOTE_INTERVAL = intArg("--remote-interval", 30);   // periodic status push, seconds (0 = off)
export const REMOTE_STATS_INTERVAL = intArg("--remote-stats-interval", 2);   // srtla_send link stats push, seconds (0 = off)
if (REMOTE_URL && !/^wss?:\/\//.test(REMOTE_URL)) argFail("--remote", REMOTE_URL, "ws:// or wss:// URL");

// relay: receives SRT and bonds it out via srtla_send
// encoder: belacoder → SRT to a relay (no bonding, routing or modems)
// combined: belacoder → local srtla_send → bonded uplinks
export const ROLES           = ["relay", "encoder", "combined"] as const;
export type Role             = (typeof ROLES)[number];
export const ROLE: Role      = enumArg(
    "--role",
    ROLES,
    (process.env.ROLE as Role | undefined) ?? (persistedStartup.settings?.role as Role | undefined) ?? "relay",
);
if (!(ROLES as readonly string[]).includes(ROLE)) argFail("SRTLA_ROLE", ROLE, ROLES.join(" | "));
export const HAS_RELAY       = ROLE === "relay" || ROLE === "combined";
export const HAS_ENCODER     = ROLE === "encoder" || ROLE === "combined";

export const BELACODER_BIN   = arg("--belacoder", process.env.BELACODER_BIN ?? "belacoder");
export const PIPELINES_DIR   = arg("--pipelines", process.env.BELACODER_PIPELINES ?? "/usr/share/belacoder/pipelines");
export const BITRATE_FILE    = arg("--bitrate-file", join(TMP, "belacoder_br"));

// Encoder-only devices do no bonding so have nothing to watch
export const MONITOR         = HAS_RELAY;
export const RELOAD_MODE     = enumArg("--srtla-reload", ["signal", "restart"] as const, "signal");
// srtla_send JSON-RPC control socket (link stats, mode / quality switching); "" disables it
export const SRTLA_SOCKET    = arg("--srtla-socket", process.env.SRTLA_CONTROL_SOCKET ?? join(TMP, "srtla_send.sock"));
export const DEBOUNCE_MS     = intArg("--debounce-ms", 1500);
