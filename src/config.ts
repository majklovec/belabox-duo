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

export const MONITOR         = flag("--monitor") || API_MODE || !!REMOTE_URL;   // daemon modes imply monitor
export const RELOAD_MODE     = enumArg("--srtla-reload", ["signal", "restart"] as const, "signal");
export const DEBOUNCE_MS     = intArg("--debounce-ms", 1500);
