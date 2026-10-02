/*
 * Interface detection, bonding selection, source-based routing tables,
 * uplinks file management and the live netlink interface monitor.
 */
import { readFile } from "node:fs/promises";
import { DEBOUNCE_MS, DRY_RUN, UPLINKS_FILE } from "./config";
import { ip, query } from "./exec";
import { detectModems, type ModemInfo, modemNetworkIface } from "./modems";
import { notifyStateChange, saveState, state } from "./state";
import { errorMessage, readLines } from "./util";

const VIRTUAL_PREFIXES = [
	"lo", "docker", "veth", "virbr", "br-", "tun", "tap", "wg", "zt", "tailscale", "utun", "dummy", "bond",
];

const TABLE_BASE = 100;

export interface Iface {
	iface: string;
	ip: string;
	prefix: number;
	cidr: string;
	speed?: number; // link speed in Mb/s, when the driver reports one
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

const isVirtual = (iface: string): boolean => VIRTUAL_PREFIXES.some((p) => iface.startsWith(p));

/** Link speed from sysfs; -1 or EINVAL (no carrier, Wi-Fi, most modems) means unknown. */
async function linkSpeed(iface: string): Promise<number | undefined> {
	const mbps = parseInt(await readFile(`/sys/class/net/${iface}/speed`, "utf8").catch(() => ""), 10);
	return mbps > 0 && mbps < 0xffffffff ? mbps : undefined;
}

// ----------------------------------------------------------------------
// Interface detection (IP-level, enriched with modem info)
// ----------------------------------------------------------------------
/** IPv4 interfaces usable for bonding; pass `modems` when the caller already listed them. */
export async function detectInterfaces(modems?: ModemInfo[]): Promise<Iface[]> {
	const [addrs, modemList] = await Promise.all([
		query("ip", ["-o", "-4", "addr", "show", "up"]),
		modems ?? detectModems(),
	]);
	const modemByIface = new Map<string, ModemInfo>();
	await Promise.all(
		modemList.map(async (m) => {
			const ifName = await modemNetworkIface(m);
			if (ifName) modemByIface.set(ifName, m);
		}),
	);

	const entries: Iface[] = [];
	for (const line of addrs.split("\n")) {
		const [, iface, , cidr] = line.split(/\s+/);
		if (!iface || !cidr || isVirtual(iface)) continue;
		const [addr, prefix] = cidr.split("/");
		entries.push({ iface, ip: addr, prefix: parseInt(prefix, 10), cidr });
	}
	// Enrich in parallel; the array order (and thus the API order) is stable.
	await Promise.all(entries.map(async (entry) => {
		const speed = await linkSpeed(entry.iface);
		if (speed) entry.speed = speed;
		const modem = modemByIface.get(entry.iface);
		if (modem) {
			Object.assign(entry, {
				modemIndex: modem.index,
				modemPath: modem.path,
				signalQuality: modem.signalQuality,
				operatorName: modem.operatorName,
				accessTech: modem.accessTech,
				registered: modem.registrationState?.includes("registered") ?? false,
				connectionState: modem.state,
			});
		}
	}));
	return entries;
}

async function getGateway(iface: string): Promise<string | null> {
	const out = await ip(["route", "show", "default", "dev", iface], true);
	return out.match(/via\s+(\S+)/)?.[1] ?? null;
}

function getNetwork(ipAddr: string, prefix: number): string {
	const ipNum = ipAddr.split(".").reduce((acc, o) => (acc << 8) + parseInt(o, 10), 0) >>> 0;
	const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
	const net = (ipNum & mask) >>> 0;
	return `${[net >>> 24, (net >>> 16) & 0xff, (net >>> 8) & 0xff, net & 0xff].join(".")}/${prefix}`;
}

// ----------------------------------------------------------------------
// Selection
// ----------------------------------------------------------------------
/** The interfaces chosen for bonding: by name, else by IP, else all of them. */
export function resolveSelection(all: Iface[]): Iface[] {
	const { modems, ips } = state.selection;
	if (modems?.length) return all.filter((i) => modems.includes(i.iface));
	if (ips?.length) return all.filter((i) => ips.includes(i.ip));
	return all;
}

export async function setSelection(selection: ModemConfig): Promise<void> {
	state.selection = selection;
	await saveState();
}

// ----------------------------------------------------------------------
// Routing tables
// ----------------------------------------------------------------------
interface RoutePlanEntry {
	iface: string;
	ip: string;
	prefix: number;
	gateway: string | null;
	table: number;
}

async function cleanupTables(count: number): Promise<void> {
	for (let i = 0; i < count; i++) {
		const table = String(TABLE_BASE + i);
		await ip(["rule", "del", "lookup", table], true);
		await ip(["route", "flush", "table", table], true);
	}
}

async function setupSourceRouting({ iface, ip: addr, prefix, gateway, table }: RoutePlanEntry): Promise<void> {
	const tableStr = String(table);
	const network = getNetwork(addr, prefix);
	await ip(["rule", "add", "from", addr, "lookup", tableStr]);
	await ip(["route", "add", network, "dev", iface, "scope", "link", "table", tableStr]);
	await ip(["route", "add", "default", ...(gateway ? ["via", gateway] : []), "dev", iface, "table", tableStr]);
	await ip(["route", "add", network, "dev", iface, "scope", "link"], true);
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
		if (!new RegExp(`from ${p.ip.replace(/\./g, "\\.")} lookup ${p.table}\\b`).test(rules)) return false;
		const routes = await ip(["route", "show", "table", String(p.table)], true);
		if (!/^default\b/m.test(routes)) return false;
	}
	return true;
}

async function applyRouting(plan: RoutePlanEntry[]): Promise<boolean> {
	const signature = JSON.stringify(plan);
	if (signature === lastAppliedPlan && (await routingIntact(plan))) return false;

	await cleanupTables(Math.max(managedTableCount, plan.length));
	managedTableCount = Math.max(managedTableCount, plan.length);
	for (const p of plan) await setupSourceRouting(p);
	lastAppliedPlan = signature;
	return true;
}

// ----------------------------------------------------------------------
// Reconfigure (routing + uplinks file)
// ----------------------------------------------------------------------
let lastUplinksContent: string | null = null;

const failure = (error: string): ReconfigureResult =>
	({ ok: false, selected: [], uplinksFile: UPLINKS_FILE, ips: [], changed: false, error });

export async function reconfigure(): Promise<ReconfigureResult> {
	try {
		const selected = resolveSelection(await detectInterfaces());
		if (selected.length === 0) return failure("No interfaces selected for bonding.");

		const plan = await Promise.all(selected.map(async ({ iface, ip: addr, prefix }, idx) => ({
			iface,
			ip: addr,
			prefix,
			gateway: await getGateway(iface),
			table: TABLE_BASE + idx,
		})));
		// Only touch routing when needed: rewriting tables emits netlink
		// events that would otherwise re-trigger the monitor forever.
		await applyRouting(plan);

		const ips = selected.map((i) => i.ip);
		console.log(`Detected IPs: ${ips.join(", ")}`);
		const content = `${ips.join("\n")}\n`;
		const previous = lastUplinksContent ?? (await Bun.file(UPLINKS_FILE).text().catch(() => null));
		const changed = previous !== content;
		if (changed && !DRY_RUN) {
			await Bun.write(UPLINKS_FILE, content);
			lastUplinksContent = content;
			console.log(`Uplinks file updated: ${ips.join(", ")}`);
		}

		// Interfaces / modem details may have changed even if the uplinks did not
		notifyStateChange();
		return { ok: true, selected, uplinksFile: UPLINKS_FILE, ips, changed };
	} catch (err: unknown) {
		return failure(errorMessage(err));
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
let monitorWanted = false;

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
		console.error("[monitor] error:", errorMessage(err));
	} finally {
		monitorBusy = false;
		if (monitorPending) {
			monitorPending = false;
			scheduleReconcile("queued follow-up");
		}
	}
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
	monitorWanted = true;
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
			for await (const line of readLines(proc.stdout)) {
				if (RELEVANT_EVENT.test(line) && !isSelfGeneratedEvent(line)) {
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
			for await (const line of readLines(proc.stderr)) {
				console.warn(`[monitor:stderr] ${line}`);
			}
		} catch {}
	})();

	proc.exited.then((code) => {
		if (monitorProc !== proc) return;
		monitorProc = null;
		if (!monitorWanted) return;
		console.warn(`[monitor] ip monitor exited (code ${code}); restarting in 2s`);
		setTimeout(() => monitorWanted && startInterfaceMonitor(), 2000);
	});
}

export async function stopInterfaceMonitor(): Promise<void> {
	monitorWanted = false;
	const proc = monitorProc;
	monitorProc = null;
	if (proc && proc.exitCode === null) {
		proc.kill("SIGTERM");
		await proc.exited.catch(() => {});
	}
	if (monitorDebounceTimer) {
		clearTimeout(monitorDebounceTimer);
		monitorDebounceTimer = null;
	}
}
