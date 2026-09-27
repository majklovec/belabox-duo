/*
 * HTTP API (Bun.serve) exposing interfaces, modem control, bonding
 * selection and srtla_send management.
 */
import { API_HOST, API_PORT, RELOAD_MODE, UPLINKS_FILE } from "./config";
import {
	connectModem,
	detectModems,
	disconnectModem,
	resetModem,
	sendAtCommand,
	setModemEnabled,
} from "./modems";
import {
	detectInterfaces,
	isMonitorRunning,
	type ModemConfig,
	reconfigure,
	resolveSelection,
	setSelection,
} from "./routing";
import { reloadSrtla, srtlaStatus, startSrtla, stopSrtla } from "./srtla";
import { state } from "./state";

type Handler = (req: Request, params: string[]) => Promise<Response> | Response;
interface Route {
	method: string;
	pattern: RegExp;
	handler: Handler;
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data, null, 2), {
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
	});
}

const errorMessage = (err: unknown): string =>
	err instanceof Error ? err.message : String(err);

const readBody = async <T>(req: Request): Promise<Partial<T>> =>
	(await req.json().catch(() => ({}))) as Partial<T>;

/** Reconfigure routing/uplinks and reload srtla_send if the uplinks changed. */
async function reconfigureAndReload() {
	const result = await reconfigure();
	if (result.ok && result.changed) await reloadSrtla();
	return result;
}

async function applySelection(selection: ModemConfig): Promise<Response> {
	await setSelection(selection);
	const result = await reconfigureAndReload();
	return json(
		{
			ok: result.ok,
			selection: state.selection,
			selected: result.selected,
			ips: result.ips,
			uplinksFile: result.uplinksFile,
			changed: result.changed,
			error: result.error,
		},
		result.ok ? 200 : 500,
	);
}

const routes: Route[] = [
	{
		method: "GET",
		pattern: /^\/api\/status$/,
		handler: async () => {
			const all = await detectInterfaces();
			return json({
				ok: true,
				state: { selection: state.selection, srtla: srtlaStatus() },
				interfaces: all,
				selected: await resolveSelection(all),
				modems: await detectModems(),
				uplinksFile: UPLINKS_FILE,
				monitor: { running: isMonitorRunning(), reloadMode: RELOAD_MODE },
				apiMode: true,
			});
		},
	},
	{
		method: "GET",
		pattern: /^\/api\/interfaces$/,
		handler: async () =>
			json({ ok: true, interfaces: await detectInterfaces() }),
	},
	{
		method: "GET",
		pattern: /^\/api\/modems$/,
		handler: async () => {
			const all = await detectInterfaces();
			return json({
				ok: true,
				selection: state.selection,
				selected: await resolveSelection(all),
				modems: await detectModems(),
			});
		},
	},
	{
		method: "PUT",
		pattern: /^\/api\/modems$/,
		handler: async (req) => {
			const body = await readBody<ModemConfig>(req);
			const all = await detectInterfaces();
			const validIfaces = new Set(all.map((i) => i.iface));
			const validIps = new Set(all.map((i) => i.ip));

			const badIfaces = body.modems?.filter((m) => !validIfaces.has(m)) ?? [];
			if (badIfaces.length)
				return json(
					{ ok: false, error: `Unknown interfaces: ${badIfaces.join(", ")}` },
					400,
				);
			const badIps = body.ips?.filter((i) => !validIps.has(i)) ?? [];
			if (badIps.length)
				return json(
					{ ok: false, error: `Unknown IPs: ${badIps.join(", ")}` },
					400,
				);

			const selection: ModemConfig = body.modems?.length
				? { modems: body.modems }
				: body.ips?.length
					? { ips: body.ips }
					: {};
			return applySelection(selection);
		},
	},
	{
		method: "POST",
		pattern: /^\/api\/modems\/([^/]+)\/toggle$/,
		handler: async (_req, [rawName]) => {
			const name = decodeURIComponent(rawName);
			const all = await detectInterfaces();
			if (!all.some((i) => i.iface === name)) {
				return json({ ok: false, error: `Unknown interface: ${name}` }, 404);
			}
			const names = new Set((await resolveSelection(all)).map((i) => i.iface));
			if (!names.delete(name)) names.add(name);
			return applySelection({ modems: [...names] });
		},
	},
	{
		method: "POST",
		pattern: /^\/api\/modems\/(\d+)\/(enable|disable)$/,
		handler: async (_req, [idx, action]) => {
			const enabled = action === "enable";
			await setModemEnabled(Number(idx), enabled);
			// Monitor will pick up the resulting netlink events
			return json({ ok: true, modemIndex: Number(idx), enabled });
		},
	},
	{
		method: "POST",
		pattern: /^\/api\/modems\/(\d+)\/reset$/,
		handler: async (_req, [idx]) => {
			await resetModem(Number(idx));
			return json({ ok: true, modemIndex: Number(idx), reset: true });
		},
	},
	{
		method: "POST",
		pattern: /^\/api\/modems\/(\d+)\/(connect|disconnect)$/,
		handler: async (_req, [idx, action]) => {
			const ok =
				action === "connect"
					? await connectModem(Number(idx))
					: await disconnectModem(Number(idx));
			return json({ ok, modemIndex: Number(idx), action });
		},
	},
	{
		method: "POST",
		pattern: /^\/api\/modems\/(\d+)\/at$/,
		handler: async (req, [idx]) => {
			const { command } = await readBody<{ command: string }>(req);
			if (!command)
				return json({ ok: false, error: "command is required" }, 400);
			const output = await sendAtCommand(Number(idx), command);
			return json({ ok: true, modemIndex: Number(idx), command, output });
		},
	},
	{
		method: "POST",
		pattern: /^\/api\/reconfigure$/,
		handler: async () => {
			const result = await reconfigureAndReload();
			return json(result, result.ok ? 200 : 500);
		},
	},
	{
		method: "POST",
		pattern: /^\/api\/srtla\/reload$/,
		handler: async () => {
			await reloadSrtla();
			return json({ ok: true, srtla: srtlaStatus() });
		},
	},
	{
		method: "GET",
		pattern: /^\/api\/srtla\/status$/,
		handler: () => json({ ok: true, srtla: srtlaStatus() }),
	},
	{
		method: "POST",
		pattern: /^\/api\/srtla\/start$/,
		handler: async (req) => {
			const { listenPort, remoteHost, remotePort } = await readBody<{
				listenPort: string;
				remoteHost: string;
				remotePort: string;
			}>(req);
			if (!listenPort || !remoteHost || !remotePort) {
				return json(
					{ ok: false, error: "listenPort, remoteHost, remotePort required" },
					400,
				);
			}
			try {
				const s = await startSrtla(String(listenPort),String(remoteHost),String(remotePort));
				return json({ ok: true, srtla: s });
			} catch (e: unknown) {
				return json({ ok: false, error: errorMessage(e) }, 409);
			}
		},
	},
	{
		method: "POST",
		pattern: /^\/api\/srtla\/stop$/,
		handler: async () => {
			await stopSrtla();
			return json({ ok: true, srtla: { running: false } });
		},
	},
];

export function startApiServer(): void {
	const server = Bun.serve({
		hostname: API_HOST,
		port: API_PORT,
		async fetch(req) {
			const { pathname } = new URL(req.url);
			const method = req.method.toUpperCase();
			try {
				for (const route of routes) {
					if (route.method !== method) continue;
					const m = route.pattern.exec(pathname);
					if (m) return await route.handler(req, m.slice(1));
				}
				return json({ ok: false, error: "Not found" }, 404);
			} catch (err: unknown) {
				console.error("API error:", err);
				return json({ ok: false, error: errorMessage(err) }, 500);
			}
		},
	});

	console.log(
		`SRTLA bonding API listening on http://${API_HOST}:${server.port}`,
	);
	console.log(`Try:  curl http://${API_HOST}:${server.port}/api/status`);
}
