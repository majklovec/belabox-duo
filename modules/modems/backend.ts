/*
 * Modems module (backend): ModemManager (mmcli) integration — enumeration,
 * per-modem details, network interface lookup and control actions.
 *
 * Self-contained: the only dependency edge into the core is the bag handed in
 * at `start` (run comes from there, never imported).
 */
import { z } from "zod";
import type { Mctx, ModemInfo, ModemsCore } from "./types";

/** Core bag, filled at start (a module may not import the core directly). */
let core: ModemsCore;

const mmcli = (...args: string[]) => core.run("mmcli", args, true);

/** `mmcli -m <n>` labels of the plain-text fields we keep. */
const DETAIL_FIELDS = {
	state: "state",
	powerState: "power state",
	model: "model",
	manufacturer: "manufacturer",
	imei: "imei",
	primaryPort: "primary port",
	deviceId: "device id",
	simPath: "sim",
	operatorName: "operator name",
	registrationState: "registration",
	accessTech: "access tech",
} as const satisfies Record<string, string>;

async function detectModems(): Promise<ModemInfo[]> {
	const list = [...(await mmcli("-L")).matchAll(/Modem\/(\d+)\s+(.*)$/gm)];
	// Query the details of all modems in parallel; list order is preserved.
	return Promise.all(list.map(([, index, label]) => modemDetails(Number(index), label.trim())));
}

async function modemDetails(index: number, label: string): Promise<ModemInfo> {
	const detail = await mmcli("-m", String(index));
	const grab = (name: string) => detail.match(new RegExp(`^\\s*${name}:\\s*(.+)$`, "m"))?.[1].trim();
	const info: ModemInfo = { index, path: `/org/freedesktop/ModemManager1/Modem/${index}`, state: "unknown", powerState: "unknown" };
	for (const [key, name] of Object.entries(DETAIL_FIELDS)) {
		const value = grab(name);
		if (value !== undefined) (info as unknown as Record<string, string>)[key] = value;
	}
	info.model ??= label;
	const signal = grab("signal quality")?.match(/(\d+)/);
	if (signal) info.signalQuality = Number(signal[1]);
	return info;
}

async function modemNetworkIface(modem: ModemInfo): Promise<string | null> {
	for (const [, bearer] of (await mmcli("-m", String(modem.index), "-b")).matchAll(/Bearer\/(\d+)/g)) {
		const iface = (await mmcli("-b", bearer)).match(/interface:\s*(\S+)/);
		if (iface) return iface[1];
	}
	const wwan = (await core.run("ip", ["-o", "-4", "addr", "show"], true)).match(/wwan\d+/g);
	if (!wwan) return null;
	return wwan.find((n) => n === `wwan${modem.index}`) ?? wwan[0];
}

async function setModemEnabled(idx: number, enabled: boolean): Promise<boolean> {
	await mmcli("-m", String(idx), enabled ? "-e" : "-d");
	return true;
}

async function resetModem(idx: number): Promise<boolean> {
	if (await mmcli("-m", String(idx), "--reset")) return true;
	await setModemEnabled(idx, false);
	await Bun.sleep(2000);
	await setModemEnabled(idx, true);
	return true;
}

const connectModem = async (idx: number) => (await mmcli("-m", String(idx), "--simple-connect=apn=internet")).length > 0;
const disconnectModem = async (idx: number) => (await mmcli("-m", String(idx), "--simple-disconnect")).length > 0;

const methods = ["modems.enable", "modems.disable", "modems.reset", "modems.connect", "modems.disconnect"] as const;

export default {
	kind: "device",
	id: "modems",
	title: "Modems",
	configSchema: z.object({}).passthrough(),
	secretFields: [] as string[],
	async start(ctx: Mctx) {
		core = ctx.core;
	},
	async stop() {},
	methods,
	events: [] as string[],
	async dispatch(method: string, params: Record<string, unknown>) {
		const index = Number(params["index"]);
		switch (method) {
			case "modems.enable":
				return setModemEnabled(index, true);
			case "modems.disable":
				return setModemEnabled(index, false);
			case "modems.reset":
				return resetModem(index);
			case "modems.connect":
				return connectModem(index);
			case "modems.disconnect":
				return disconnectModem(index);
		}
		throw new Error(`unknown method ${method}`);
	},
	async status() {
		return { modems: await detectModems() };
	},
	services: {
		capabilities: {
			"stream.modems": {
				detect: detectModems,
				modemIface: modemNetworkIface,
			},
		},
	},
};
