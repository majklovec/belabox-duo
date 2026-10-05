/**
 * Frontend module registry — the only module entry point public/ts/app.ts
 * (and the device store) may import for module cards and event handling.
 *
 * Modules are listed explicitly (no glob / auto-discovery). Migration status
 * (see TODO.md): each import below is uncommented as its module moves into
 * modules/<id>/.
 */
import m from "mithril";
import type { BrowserModule } from "./types";
import type { Status } from "../public/types";
import { setFrontendEventSink } from "../public/ts/device/store";

import { encoderModule } from "./encoder/frontend";
import { srtlaModule } from "./srtla/frontend";
import { modemsModule } from "./modems/frontend";
import { obsControllerModule } from "./obs-controller/frontend";
import { kickStatsModule } from "./kick-stats/frontend";
import { kickChatModule } from "./kick-chat/frontend";

export const FRONTEND_MODULES: BrowserModule[] = [
	encoderModule,
	srtlaModule,
	modemsModule,
	obsControllerModule,
	kickStatsModule,
	kickChatModule,
];

export const getFrontendModule = (id: string) => FRONTEND_MODULES.find((mod) => mod.id === id);

export const frontendModuleIds = (): string[] => FRONTEND_MODULES.map((mod) => mod.id);

/** Render one module's card for the device page. */
export const moduleCard = (id: string, status: Status): m.Vnode | null => {
	const mod = getFrontendModule(id);
	if (!mod) return null;
	return (mod.component as (status: Status) => m.Vnode)(status);
};

/**
 * Dispatch a pushed event to every frontend module that handles it.
 */
export function dispatchFrontendEvent(event: string, data: unknown): void {
	for (const mod of FRONTEND_MODULES) mod.handleEvent?.(event, data);
}

// Register this dispatcher with the device store. The store is imported from
// module frontends, so it cannot import this registry back (cycle); this is
// the one direction allowed.
setFrontendEventSink(dispatchFrontendEvent);
