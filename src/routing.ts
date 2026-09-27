/*
 * Interface detection, bonding selection, source-based routing tables,
 * uplinks file management and the live netlink interface monitor.
 */
import {
	CONFIG_FILE,
	DEBOUNCE_MS,
	DRY_RUN,
	MONITOR,
	UPLINKS_FILE,
} from "./config";
import { ip } from "./exec";
import { detectModems, type ModemInfo, modemNetworkIface } from "./modems";
import { notifyStateChange, saveState, state } from "./state";

const VIRTUAL_PREFIXES = [
	"lo",
	"docker",
	"veth",
	"virbr",
	"br-",
	"tun",
	"tap",
	"wg",
	"zt",
	"tailscale",
	"utun",
	"dummy",
	"bond",
];

const TABLE_BASE = 100;

export interface Iface {
	iface: string;
	ip: string;
	prefix: number;
	cidr: string;
	modemIndex?: number;
	modemPath?: string;
	signalQuality?: number;
	operatorName?: string;
	accessTech?: string;
	registered?: boolean;
	connectionState?: string;
}

export interface ModemConfig {
	modems?: string[];
	ips?: string[];
}

export interface ReconfigureResult {
	ok: boolean;
	selected: Iface[];
	uplinksFile: string;
	ips: string[];
	changed: boolean; // true if the uplinks content actually changed
	error?: string;
}

const isVirtual = (iface: string): boolean =>
	VIRTUAL_PREFIXES.some((p) => iface.startsWith(p));

// ----------------------------------------------------------------------
// Interface detection (IP-level, enriched with modem info)
// ----------------------------------------------------------------------
export async function detectInterfaces(): Promise<Iface[]> {
	const res = Bun.spawnSync(["ip", "-o", "-4", "addr", "show", "up"]);
	if (res.exitCode !== 0) {
		throw new Error(`Failed to query interfaces: ${res.stderr.toString()}`);
	}

	const modems = await detectModems();
	const modemByIface = new Map<string, ModemInfo>();
	for (const m of modems) {
		const ifName = await modemNetworkIface(m);
		if (ifName) modemByIface.set(ifName, m);
	}

	const result: Iface[] = [];
	for (const line of res.stdout.toString().split("\n").filter(Boolean)) {
		const parts = line.split(/\s+/);
		const iface = parts[1];
		const cidr = parts[3];
		if (!iface || !cidr) continue;
		const [addr, prefixStr] = cidr.split("/");
		const prefix = parseInt(prefixStr, 10);
		if (iface === "lo" || isVirtual(iface)) continue;

		const entry: Iface = { iface, ip: addr, prefix, cidr };
		const modem = modemByIface.get(iface);
		if (modem) {
			entry.modemIndex = modem.index;
			entry.modemPath = modem.path;
			entry.signalQuality = modem.signalQuality;
			entry.operatorName = modem.operatorName;
			entry.accessTech = modem.accessTech;
			entry.registered =
				modem.registrationState?.includes("registered") ?? false;
			entry.connectionState = modem.state;
		}
		result.push(entry);
	}
	return result;
}

async function getGateway(iface: string): Promise<string | null> {
	const out = await ip(["route", "show", "default", "dev", iface], true);
	if (!out) return null;
	const m = out.match(/via\s+(\S+)/);
	return m ? m[1] : null;
}

function getNetwork(ipAddr: string, prefix: number): string {
	const ipNum =
		ipAddr.split(".").reduce((acc, o) => (acc << 8) + parseInt(o, 10), 0) >>> 0;
	const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
	const netNum = (ipNum & mask) >>> 0;
	return `${[(netNum >>> 24) & 0xff, (netNum >>> 16) & 0xff, (netNum >>> 8) & 0xff, netNum & 0xff].join(".")}/${prefix}`;
}

// ----------------------------------------------------------------------
// Selection
// ----------------------------------------------------------------------
async function loadModemConfigFile(): Promise<ModemConfig | null> {
	const file = Bun.file(CONFIG_FILE);
	if (!(await file.exists())) return null;
	try {
		return (await file.json()) as ModemConfig;
	} catch {
		return null;
	}
}

function filterByConfig(list: Iface[], cfg: ModemConfig): Iface[] {
	if (cfg.modems?.length)
		return list.filter((i) => cfg.modems?.includes(i.iface));
	if (cfg.ips?.length) return list.filter((i) => cfg.ips?.includes(i.ip));
	return list;
}

export async function resolveSelection(all: Iface[]): Promise<Iface[]> {
	const runtime = state.selection;
	const hasRuntime =
		(runtime.modems && runtime.modems.length > 0) ||
		(runtime.ips && runtime.ips.length > 0);
	if (hasRuntime) return filterByConfig(all, runtime);
	const fromFile = await loadModemConfigFile();
	if (fromFile) return filterByConfig(all, fromFile);
	return all;
}

export async function setSelection(selection: ModemConfig): Promise<void> {
	state.selection = selection;
	await saveState();
}

// ----------------------------------------------------------------------
// Routing tables
// ----------------------------------------------------------------------
async function cleanupTables(count: number): Promise<void> {
	for (let i = 0; i < count; i++) {
		const table = (TABLE_BASE + i).toString();
		await ip(["rule", "del", "lookup", table], true);
		await ip(["route", "flush", "table", table], true);
	}
}

async function setupSourceRouting(
	iface: string,
	ipAddr: string,
	prefix: number,
	gateway: string | null,
	tableId: number,
): Promise<void> {
	const tableStr = tableId.toString();
	const network = getNetwork(ipAddr, prefix);
	await ip(["rule", "add", "from", ipAddr, "lookup", tableStr]);
	await ip([
		"route",
		"add",
		network,
		"dev",
		iface,
		"scope",
		"link",
		"table",
		tableStr,
	]);
	if (gateway) {
		await ip([
			"route",
			"add",
			"default",
			"via",
			gateway,
			"dev",
			iface,
			"table",
			tableStr,
		]);
	} else {
		await ip(["route", "add", "default", "dev", iface, "table", tableStr]);
	}
	await ip(["route", "add", network, "dev", iface, "scope", "link"], true);
}

interface RoutePlanEntry {
	iface: string;
	ip: string;
	prefix: number;
	gateway: string | null;
	table: number;
}

// Highest number of tables we have ever populated, so shrinking selections
// get their stale tables cleaned and monitor events for them are recognised.
let managedTableCount = 0;
let lastAppliedPlan: string | null = null;

const isManagedTable = (table: number): boolean =>
	table >= TABLE_BASE && table < TABLE_BASE + Math.max(managedTableCount, 1);

async function routingIntact(plan: RoutePlanEntry[]): Promise<boolean> {
	const rules = await ip(["rule", "show"], true);
	for (const p of plan) {
		if (
			!new RegExp(
				`from ${p.ip.replace(/\./g, "\\.")} lookup ${p.table}\\b`,
			).test(rules)
		)
			return false;
		const routes = await ip(
			["route", "show", "table", p.table.toString()],
			true,
		);
		if (!/^default\b/m.test(routes)) return false;
	}
	return true;
}

async function applyRouting(plan: RoutePlanEntry[]): Promise<boolean> {
	const signature = JSON.stringify(plan);
	if (signature === lastAppliedPlan && (await routingIntact(plan)))
		return false;

	await cleanupTables(Math.max(managedTableCount, plan.length));
	managedTableCount = Math.max(managedTableCount, plan.length);
	for (const p of plan) {
		await setupSourceRouting(p.iface, p.ip, p.prefix, p.gateway, p.table);
	}
	lastAppliedPlan = signature;
	return true;
}

// ----------------------------------------------------------------------
// Reconfigure (routing + uplinks file)
// ----------------------------------------------------------------------
let lastUplinksContent: string | null = null;

async function readUplinksFile(): Promise<string | null> {
	const f = Bun.file(UPLINKS_FILE);
	if (!(await f.exists())) return null;
	return await f.text();
}

export async function reconfigure(): Promise<ReconfigureResult> {
	try {
		const all = await detectInterfaces();
		const selected = await resolveSelection(all);

		if (selected.length === 0) {
			return {
				ok: false,
				selected: [],
				uplinksFile: UPLINKS_FILE,
				ips: [],
				changed: false,
				error: "No interfaces selected for bonding.",
			};
		}

		const plan: RoutePlanEntry[] = [];
		for (let idx = 0; idx < selected.length; idx++) {
			const { iface, ip: addr, prefix } = selected[idx];
			plan.push({
				iface,
				ip: addr,
				prefix,
				gateway: await getGateway(iface),
				table: TABLE_BASE + idx,
			});
		}
		// Only touch routing when needed: rewriting tables emits netlink
		// events that would otherwise re-trigger the monitor forever.
		await applyRouting(plan);

		const ips = selected.map((i) => i.ip);
		const content = `${ips.join("\n")}\n`;

		const previous = lastUplinksContent ?? (await readUplinksFile());
		const changed = previous !== content;

		if (changed && !DRY_RUN) {
			await Bun.write(UPLINKS_FILE, content);
			lastUplinksContent = content;
			console.log(`Uplinks file updated: ${ips.join(", ")}`);
		}

		// Interfaces / modem details may have changed even if the uplinks did not
		notifyStateChange();

		return {
			ok: true,
			selected,
			uplinksFile: UPLINKS_FILE,
			ips,
			changed,
		};
	} catch (err: unknown) {
		return {
			ok: false,
			selected: [],
			uplinksFile: UPLINKS_FILE,
			ips: [],
			changed: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

// ----------------------------------------------------------------------
// Live interface monitor (netlink via `ip monitor`)
// ----------------------------------------------------------------------
type UplinksChangedHandler = () => Promise<void>;

let monitorProc: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
let monitorDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let monitorBusy = false;
let monitorPending = false;
let onUplinksChanged: UplinksChangedHandler = async () => {};

export const isMonitorRunning = (): boolean => monitorProc !== null;

/**
 * Schedule a reconfigure after a short debounce.
 * Multiple events within DEBOUNCE_MS collapse into one run.
 */
function scheduleReconcile(reason: string): void {
	if (monitorDebounceTimer) clearTimeout(monitorDebounceTimer);
	monitorDebounceTimer = setTimeout(() => {
		monitorDebounceTimer = null;
		void runReconcile(reason);
	}, DEBOUNCE_MS);
}

async function runReconcile(reason: string): Promise<void> {
	if (monitorBusy) {
		monitorPending = true;
		return;
	}
	monitorBusy = true;
	try {
		console.log(`\n[monitor] ${reason} — reconciling...`);
		const result = await reconfigure();
		if (!result.ok) {
			console.warn(`[monitor] reconfigure failed: ${result.error}`);
			return;
		}
		console.log(`[monitor] active uplinks: ${result.ips.join(", ")}`);

		if (result.changed) {
			await onUplinksChanged();
		} else {
			console.log("[monitor] no change to uplinks file — skipping reload");
		}
	} catch (err: unknown) {
		console.error(
			"[monitor] error:",
			err instanceof Error ? err.message : String(err),
		);
	} finally {
		monitorBusy = false;
		if (monitorPending) {
			monitorPending = false;
			scheduleReconcile("queued follow-up");
		}
	}
}

async function* readLines(
	stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
	const decoder = new TextDecoder();
	let buffer = "";
	for await (const chunk of stream) {
		buffer += decoder.decode(chunk, { stream: true });
		let nl: number;
		// biome-ignore lint/suspicious/noAssignInExpressions: Just bcs I am lazy
		while ((nl = buffer.indexOf("\n")) !== -1) {
			yield buffer.slice(0, nl);
			buffer = buffer.slice(nl + 1);
		}
	}
	if (buffer) yield buffer;
}

// IPv4 address changes, link up/down, route changes
const RELEVANT_EVENT = /inet\s|^\d+:\s+\S+:\s+<.*>|^(Deleted|Added|default)/;

// Route changes inside our own source-routing tables are self-inflicted.
function isSelfGeneratedEvent(line: string): boolean {
	const m = line.match(/\btable (\d+)\b/);
	return m !== null && isManagedTable(parseInt(m[1], 10));
}

/**
 * Start watching netlink events for address / link / route changes.
 * Any relevant event triggers a debounced reconfigure; `onChange` runs
 * whenever the uplinks file content actually changed.
 */
export function startInterfaceMonitor(onChange?: UplinksChangedHandler): void {
	if (onChange) onUplinksChanged = onChange;
	if (monitorProc) return;

	console.log("Starting interface monitor (ip monitor address link route)...");
	const proc = Bun.spawn(["ip", "monitor", "address", "link", "route"], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	monitorProc = proc;

	(async () => {
		try {
			for await (const raw of readLines(proc.stdout)) {
				const line = raw.trim();
				if (line && RELEVANT_EVENT.test(line) && !isSelfGeneratedEvent(line)) {
					scheduleReconcile(line.slice(0, 120));
				}
			}
		} catch (err: unknown) {
			if (err instanceof Error && err.name !== "AbortError") {
				console.error("[monitor] reader error:", err.message);
			}
		}
	})();

	// Log stderr as warnings (netlink permission issues etc.)
	(async () => {
		try {
			for await (const raw of readLines(proc.stderr)) {
				const text = raw.trim();
				if (text) console.warn(`[monitor:stderr] ${text}`);
			}
		} catch {}
	})();

	proc.exited.then((code) => {
		console.warn(
			`[monitor] ip monitor exited (code ${code}); restarting in 2s`,
		);
		monitorProc = null;
		if (MONITOR) setTimeout(startInterfaceMonitor, 2000);
	});
}

export async function stopInterfaceMonitor(): Promise<void> {
	if (monitorProc && monitorProc.exitCode === null) {
		monitorProc.kill("SIGTERM");
		try {
			await monitorProc.exited;
		} catch {}
	}
	monitorProc = null;
	if (monitorDebounceTimer) {
		clearTimeout(monitorDebounceTimer);
		monitorDebounceTimer = null;
	}
}
