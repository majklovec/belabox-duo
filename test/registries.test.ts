import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { allModules } from "../src/registry";
import { defaultModules, state } from "../src/state";
import { modulesForRole } from "../src/validate";
import { safeModules } from "../src/modules";

/**
 * Registry order of the device modules: the result of the registry's topological
 * sort over declared `dependencies` (id-sorted within equal ranks). The
 * low-bitrate switcher no longer has its own module — it rides on the
 * obs-controller module — so it no longer appears here. A new start dependency
 * shifts the positions accordingly and this expectation must be revisited.
 */
const DEVICE_ORDER = ["encoder", "modems", "obs-controller", "srtla"];
/** The channel widget modules (device-independent dashboard widgets). */
const WIDGET_IDS = ["kick-stats", "chat"];

/**
 * The frontend registry cannot be imported outside the browser graph (it
 * mounts the device store at module init), so its discovery is checked from
 * the files: every modules/<id>/frontend.tsx must default-export at least one
 * registration whose `id` matches its directory, and whose `kind` splits the
 * set into device cards (matching the backend registry) and widgets. A module
 * can register several (e.g. a device-card plus a dashboard widget) by
 * default-exporting an array of them — the registry flattens it.
 */
const modulesDir = join(import.meta.dir, "..", "modules");

/** The id/kind of the object a `const` declares (empty when it is not one). */
function regOf(src: string, name: string): { id?: string; kind?: string } {
	const decl = src.match(new RegExp(`const ${name}[\\s\\S]*?=\\s*`));
	if (!decl) return {};
	const body = src.slice((decl.index ?? 0) + decl[0].length);
	const id = body.match(/\bid:\s*"([^"]+)"/)?.[1];
	const kind = body.match(/\bkind:\s*"([^"]+)"/)?.[1];
	return id && kind ? { id, kind } : {};
}

function scanFrontends(): {
dir: string;
registrations: { id: string; kind: string }[];
}[] {
const out: { dir: string; registrations: { id: string; kind: string }[] }[] = [];
for (const dir of readdirSync(modulesDir, { withFileTypes: true })) {
	if (!dir.isDirectory()) continue;
	const file = join(modulesDir, dir.name, "frontend.tsx");
	let src: string;
	try {
		src = readFileSync(file, "utf8");
	} catch {
		continue; // module without a frontend (backend-only) — fine
		}
	expect(src, `${dir}/frontend.tsx has no default export` as string).toContain("export default");
	// The exported id/kind are read from the object(s) the file
	// default-exports, not the whole file (helper literals like
	// `kind: "text"` must not win). Handle `export default <obj>` and
	// `export default [<obj>, <obj>, …]` (a module registering several).
	const arr = src.match(/export default\s*\[([^\]]*)\]/);
	const single = src.match(/export default\s*(\w+)/);
	const names = (arr ? arr[1] : single?.[1] ?? "")
		.split(",")
		.map((n) => n.trim())
		.filter(Boolean);
	const registrations: { id: string; kind: string }[] = [];
	for (const name of names) {
		const reg = regOf(src, name);
		if (reg.id && reg.kind) registrations.push({ id: reg.id, kind: reg.kind });
	}
	expect(registrations.length, `${dir}/frontend.tsx default-exports no registration` as string).toBeGreaterThan(0);
	out.push({ dir: dir.name, registrations });
}
return out;
}

const ids = (): string[] => allModules().map((mod) => mod.id);

describe("module registries", () => {
	// The device modules are discovered from modules/*/backend.ts, the 4 of
	// them in the canonical dependency order (the registry's start order).
	test("backend registry enumerates the device modules in order", () => {
		const deviceIds = ids().filter((id) => DEVICE_ORDER.includes(id));
		expect(deviceIds).toEqual(DEVICE_ORDER);
	});

	test("backend registry discovers every widget module", () => {
		const all = ids();
		for (const id of WIDGET_IDS) expect(all, `missing widget ${id}` as string).toContain(id);
	});

	test("no duplicate module ids", () => {
		const all = ids();
		expect(new Set(all).size).toBe(all.length);
	});

	test("frontend discovery: directory name matches a registration id", () => {
		for (const fe of scanFrontends()) {
			// The module's own id (its directory) must be one of the ids it registers.
			expect(fe.registrations.map((r) => r.id), `${fe.dir}/frontend.tsx doesn't register ${fe.dir}`).toContain(fe.dir);
		}
	});

	test("device-card frontends match backend device-module ids exactly", () => {
		const cardIds = scanFrontends().flatMap((fe) => fe.registrations).filter((r) => r.kind === "device-card").map((r) => r.id);
		expect([...cardIds].sort()).toEqual([...DEVICE_ORDER].sort());
	});

	test("widget frontends are separate from device modules", () => {
		const f = scanFrontends();
		const backendDeviceIds = new Set(DEVICE_ORDER);
		const widgetIds = f.flatMap((fe) => fe.registrations).filter((r) => r.kind === "widget").map((r) => r.id);
		expect(widgetIds.length).toBeGreaterThanOrEqual(2);
		expect(widgetIds.filter((id) => backendDeviceIds.has(id)).length).toBe(0);
	});

	test("frontend registry discovers via the generated manifest (no per-module imports, no Glob)", () => {
		const src = readFileSync(join(import.meta.dir, "..", "src", "registry.frontend.ts"), "utf8");
		expect(src).not.toMatch(/from "\.\.\/modules\/[\w-]+\/frontend/);
		expect(src).not.toMatch(/import\.meta\.glob|Bun\.Glob|from "bun\/glob"|modules\/\*\/frontend/);
		expect(src).toMatch(/from "\.\.\/modules\/\.generated\.frontend\*?";/);
		const manifest = join(modulesDir, ".generated.frontend.ts");
		expect(statSync(manifest).size).toBeGreaterThan(0);
		expect(readFileSync(manifest, "utf8")).toMatch(/AUTO-GENERATED/i);
	});

	test("backend registry discovers by directory scan + compiled-binary manifest, no per-module imports", () => {
		const src = readFileSync(join(import.meta.dir, "..", "src", "registry.ts"), "utf8");
		expect(src).not.toMatch(/from "\.\.\/modules\/[\w-]+\/backend/);
		expect(src).toMatch(/readdirSync\(MODULES_DIR\)/);
		// Compiled binaries (bun build --compile) cannot run the scan — they
		// fall back to the generated manifest, like the frontend registry.
		expect(src).toMatch(/"\.\.\/modules\/\.generated\.backend"/);
		const manifest = join(modulesDir, ".generated.backend.ts");
		expect(statSync(manifest).size).toBeGreaterThan(0);
		expect(readFileSync(manifest, "utf8")).toMatch(/AUTO-GENERATED/i);
	});

	/**
	 * REFACTOR-modules.md §7 — the core never names a module by id. Core files
	 * (src/ + public/ts/) may only reach modules through the sanctioned doors:
	 * the dynamic scan in registry.ts (no static import) and the generated
	 * manifest in registry.frontend.ts (`.generated.frontend`, which lists paths
	 * the core's own code does not mention). Per-device widget cards go through
	 * `deviceCardBody(id, …)` (manifest), not a direct import.
	 *
	 * One documented seam remains: `dashboard.ts` imports `modules/obs-controller/frontend`
	 * for the stateful obs panel and the switcher card it carries (the
	 * low-bitrate switcher no longer has its own frontend entry point). Its
	 * through a generic `Panel` signature without the core re-declaring module types
	 * (§6 forbids shared types) — so they are allow-listed here, not ban-able. Any
	 * other `modules/<id>/…` import is an offence.
	 *
	 * The test itself sits at the project root, so it is not in scope and its
	 * own expectations never trip the scan.
	 */
	test("core (src/ + public/ts/) names no module by id", () => {
		const moduleIds = new Set<string>();
		for (const dir of readdirSync(modulesDir, { withFileTypes: true })) if (dir.isDirectory()) moduleIds.add(dir.name);
		/** The sanctioned core→module seams (path suffixes). */
		const allow = new Set<string>([".generated", "modules/obs-controller/frontend"]);
		const walk = (dir: string): string[] =>
			readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
		const filesOf = (root: string): string[] => walk(root).filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"));
		const offenders: string[] = [];
		for (const root of [join(import.meta.dir, "..", "src"), join(import.meta.dir, "..", "public", "ts")]) {
			for (const file of filesOf(root)) {
				readFileSync(file, "utf8").split("\n").forEach((line, i) => {
					const m = line.match(/(?:from\s+|require\()\s*["']([^"']+)["']/);
					if (!m) return;
					const spec = m[1];
					const at = spec.indexOf("modules/");
					if (at < 0) return;
					const tail = "/" + spec.slice(at); // e.g. "/modules/encoder/frontend"
					const seg = spec.slice(at + "modules/".length).split("/")[0];
					if ([...allow].some((a) => tail.endsWith(a) || seg.startsWith("."))) return; // sanctioned doors
					if (moduleIds.has(seg)) offenders.push(`${file}:${i + 1} → ${spec}`);
				});
			}
		}
		expect(offenders, `core names module ids:\n${offenders.join("\n")}`).toEqual([]);
	});
});

// modems feeds routing's detectInterfaces, so it must be enabled wherever
// the relay half runs; encoder-only never boots it (regression: boot crashed
// on the unbound modems core after the self-contained-modules refactor).
describe("modems role presets", () => {
	test("relay and combined roles enable the modems module", () => {
		expect(modulesForRole("relay")).toEqual(["relay", "modems"]);
		expect(modulesForRole("combined")).toEqual(["relay", "encoder", "modems"]);
		expect(modulesForRole("encoder")).toEqual(["encoder"]);
	});

	test("default modules mirror the role presets", () => {
		expect(defaultModules("relay").modems.enabled).toBe(true);
		expect(defaultModules("combined").modems.enabled).toBe(true);
		expect(defaultModules("encoder").modems.enabled).toBe(false);
	});

	test("status view exposes the modems module flag", () => {
		const saved = state.settings.modules;
		try {
			state.settings.modules = defaultModules("relay");
			const view = safeModules() as { modems?: { enabled: boolean } };
			expect(view.modems).toEqual({ enabled: true });
		} finally {
			state.settings.modules = saved;
		}
	});
});
