#!/usr/bin/env bun
/*
 * srtla_relay.ts
 *
 * Detects network interfaces suitable for SRTLA bonding, sets up
 * source-based routing tables, writes the uplinks file required by
 * irlserver/srtla_send, and (optionally) monitors interfaces live —
 * rewriting the uplinks file and signalling srtla_send on change.
 *
 * Modem management mirrors BELABOX/belaUI (ws_nodejs):
 *   - enumeration via ModemManager (mmcli)
 *   - per-modem state, signal quality, operator, AT passthrough
 *   - enable/disable/reset/connect/disconnect
 *   - integration into bonding selection + routing
 *
 * Modules (src/):
 *   config.ts   CLI arguments and derived settings
 *   exec.ts     shell command helper (dry-run aware)
 *   state.ts    persistent state (selection + srtla)
 *   modems.ts   ModemManager integration
 *   routing.ts  interface detection, selection, routing, uplinks, monitor
 *   srtla.ts    srtla_send process management
 *   api.ts      WebSocket API (ws://host:port/ws) + web UI from public/ at /
 *   remote.ts   outbound WebSocket to a remote control server (same protocol);
 *               the server itself lives in server/ (bun server/server.ts)
 *
 * Prefers Bun runtime APIs ($, Bun.file, Bun.serve, Bun.spawn).
 *
 * Usage:
 *   bun srtla_relay.ts [--monitor] [--config modems.json] [--dry-run]
 *   bun srtla_relay.ts --api --port 8085
 *   bun srtla_relay.ts --start-srtla 6000 rec.example.com 5000 --monitor
 *   SRTLA_REMOTE_TOKEN=secret bun srtla_relay.ts --remote wss://ctl.example.com/device [--remote-id cam1] [--api]
 *
 * Reload strategy (default `signal`):
 *   --srtla-reload=signal    send SIGHUP, srtla_send re-reads uplinks file
 *   --srtla-reload=restart   kill and respawn srtla_send (falls back here if
 *                            SIGHUP delivery fails or no pid is known)
 */

import { startApiServer } from "./src/api";
import { API_MODE, MONITOR, REMOTE_URL, argv } from "./src/config";
import { startRemote, stopRemote } from "./src/remote";
import { detectInterfaces, reconfigure, startInterfaceMonitor, stopInterfaceMonitor } from "./src/routing";
import { reloadSrtla, startSrtla, stopSrtla, maybeStartSrtla } from "./src/srtla";



async function main(): Promise<void> {
    console.log("=== SRTLA Bonding Setup (Bun) ===\n");

    const shutdown = async (signal: string) => {
        console.log(`\nReceived ${signal}, shutting down...`);
        stopRemote();
        await stopInterfaceMonitor();
        await stopSrtla();
        process.exit(0);
    };
    process.on("SIGINT",  () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));

    if (API_MODE || REMOTE_URL) {
        // 1. Prime routing + write uplinks file
        const result = await reconfigure();
        if (!result.ok) {
            console.error("Initial reconfigure failed:", result.error);
            process.exit(1);
        }
        console.log(`Initial uplinks: ${result.ips.join(", ")}`);

        // 2. Start srtla_send if requested (uses the file we just wrote)
        await maybeStartSrtla(argv);

        // 3. Start the monitor (will reload srtla_send on changes)
        if (MONITOR) startInterfaceMonitor(reloadSrtla);

        // 4. Start the local API and/or the remote control link
        if (API_MODE) startApiServer();
        if (REMOTE_URL) startRemote();
        return;
    }

    // One-shot CLI
    const all = await detectInterfaces();
    console.log(`Detected ${all.length} non-virtual IPv4 interface(s):`);
    for (const i of all) {
        const tag = i.modemIndex !== undefined
            ? ` [modem ${i.modemIndex}, sig ${i.signalQuality ?? "?"}%, ${i.operatorName ?? "?"}]`
            : "";
        console.log(`  ${i.iface}  ${i.ip}/${i.prefix}${tag}`);
    }

    const result = await reconfigure();
    if (!result.ok) {
        console.error("Reconfigure failed:", result.error);
        process.exit(1);
    }

    console.log(`\nSelected ${result.selected.length} interface(s):`);
    for (const i of result.selected) console.log(`  ${i.iface}  ${i.ip}`);
    console.log(`\nUplinks file: ${result.uplinksFile}`);

    const started = await maybeStartSrtla(argv);

    if (MONITOR) {
        startInterfaceMonitor(reloadSrtla);
        console.log("\nMonitoring interfaces — press Ctrl+C to stop.");
        await new Promise(() => {});
    } else if (!started) {
        console.log("\nDone.");
    }
}

main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
