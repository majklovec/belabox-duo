/*
 * Local HTTP / WebSocket server: the web UI from public/ at `/` (the setup wizard
 * while the device has no config file), `/settings/`, `/setup/`, and the
 * WebSocket API at ws://<host>:<port>/ws (protocol and methods: methods.ts).
 *
 * The same protocol is spoken over the outbound remote connection (see remote.ts).
 */
import type { BunRequest, Server } from "bun";
import index from "../public/index.html";
import settings from "../public/settings.html";
import setup from "../public/setup.html";
import { ALLOWED_ORIGINS, API_HOST, API_PORT } from "./config";
import { imageResponse, notFound, originAllowed, text, upgradeRequired } from "./http";
import { handleRequest } from "./methods";
import { addStatusSink, logHistoryEvent, statsEvent, statusEvent } from "./push";
import { latestSrtlaStats } from "./srtlaControl";
import { onStateChange, setupRequired } from "./state";
import { errorMessage } from "./util";

const WS_PATH = "/ws";
const STATUS_TOPIC = "status";

// Web UI from public/ — Bun bundles the HTML's scripts and styles on the fly
const routes = () => ({ "/": setupRequired ? setup : index, "/settings/": settings, "/setup/": setup });

async function fetch(req: Request | BunRequest, srv: Server<undefined>): Promise<Response | undefined> {
	const path = new URL(req.url).pathname;
	if (path === "/settings" || path === "/setup") return Response.redirect(`${path}/`, 308);
	const image = await imageResponse(path);
	if (image) return image;
	if (path !== WS_PATH) return notFound();
	if (!originAllowed(req, ALLOWED_ORIGINS)) return text("Origin not allowed", 403);
	if (srv.upgrade(req)) return undefined;
	return upgradeRequired();
}

const websocket: Bun.WebSocketHandler<undefined> = {
	async open(ws) {
		ws.subscribe(STATUS_TOPIC);
		try {
			ws.send(logHistoryEvent());
			ws.send(await statusEvent());
			if (latestSrtlaStats().stats) ws.send(statsEvent());
		} catch (err: unknown) {
			console.error("Initial status failed:", errorMessage(err));
		}
	},
	async message(ws, raw) {
		ws.send(await handleRequest(raw));
	},
};

export function startApiServer(): void {
	const server = Bun.serve({ hostname: API_HOST, port: API_PORT, routes: routes(), fetch, websocket });

	// "/" serves the setup wizard until setup completes; then swap in the device UI
	let servedSetup = setupRequired;
	onStateChange(() => {
		if (servedSetup === setupRequired) return;
		servedSetup = setupRequired;
		server.reload({ routes: routes(), fetch, websocket });
	});

	addStatusSink({
		active: () => server.subscriberCount(STATUS_TOPIC) > 0,
		send: (msg) => server.publish(STATUS_TOPIC, msg),
	});

	const url = `ws://${API_HOST}:${server.port}${WS_PATH}`;
	console.log(`SRTLA web UI on http://${API_HOST}:${server.port}/`);
	console.log(`SRTLA bonding WebSocket API listening on ${url}`);
	console.log(`Try:  bunx wscat -c ${url}  then send {"id":1,"method":"status"}`);
}
