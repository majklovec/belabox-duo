# REFACTCOR.md — Module Self-Containment Refactor

**Handoff document for an AI agent**
**Target repo:** `majklovec/belabox-duo`
**Goal:** Every module under `modules/<id>/` must be **fully self-contained**. No shared `types.ts`, no shared registry contracts, no core-owned interface file that modules import. The core knows **nothing** about any module — not even a shared type contract. Modules are discovered, validated at runtime, and driven generically. Adding a module = dropping a folder into `modules/`.

---

## 1. Core principle

> **A module must be importable in isolation, with zero imports outside its own directory.**

That means:

- No `import ... from "../types"`.
- No `import ... from "../widgets"`.
- No `import ... from "../../src/..."`.
- No shared `modules/types.ts`, no shared `modules/widgets.ts` as a dependency of modules.

Modules may only import:

- from their own directory (`./something`),
- from standard runtime globals (Bun APIs, browser APIs, mithril as an external peer),
- from npm packages (zod, mithril, etc.).

The **contract between core and modules is structural**, not nominal. The core defines what shape it expects and validates it at runtime. Modules export plain objects. Neither side imports the other's types.

---

## 2. Current state (what exists today)

### 2.1 Module layout

```
modules/
  types.ts               # ← shared contract; TO BE REMOVED as a module dependency
  registry.backend.ts    # explicit module list
  registry.frontend.ts   # explicit module list
  widgets.ts             # widget contracts; TO BE REMOVED as a module dependency
  encoder/{backend.ts, frontend.ts, styles.css}
  srtla/{backend.ts, frontend.ts, styles.css}
  modems/{backend.ts, frontend.ts, styles.css}
  obs-controller/{backend.ts, frontend.ts, styles.css}
  kick-chat/{backend.ts, frontend.ts, styles.css}
  kick-stats/{backend.ts, frontend.ts, styles.css}
  tiktok-chat/{backend.ts, frontend.ts, styles.css}
  twitch-chat/{backend.ts, frontend.ts, styles.css}
  youtube-chat/{backend.ts, frontend.ts, styles.css}
```

### 2.2 What the core still knows about modules

- `registry.backend.ts` imports each module explicitly and builds `ALL_MODULES`.
- `registry.frontend.ts` imports each frontend module explicitly.
- `src/methods.ts` has a hard-coded `METHOD_OWNER` map.
- `src/stream.ts`, `src/client.ts`, `src/routing.ts` import module-specific services (`encoderServices`, `srtlaServices`, `modemServices`) from the registry.
- Every module imports `DeviceModule`, `ModuleContext`, `BrowserModule`, `ChannelWidgetModule` from `modules/types.ts`.

### 2.3 The problem with the shared `types.ts`

Even if we auto-discover modules, importing `../types` still creates a shared coupling:

- It forces every module to agree on a single interface.
- It creates a dependency edge from every module into a central file.
- It means a module cannot be copy-pasted or extracted without dragging the shared types file along.
- It makes it impossible to add a module whose shape the core doesn't already know about.

We are removing that dependency entirely.

---

## 3. Target state

### 3.1 Contract by convention + runtime validation

The core defines the expected **shape** of a module registration as a runtime validator (zod, or a hand-written `assertRegistration` function). Modules export a plain object. The core validates on load and rejects anything malformed.

No TypeScript type is imported by modules. Modules can define their own local types if they want, but they export a plain object.

### 3.2 Module registration shape (documented, not imported)

This is a **documentation contract**, not a shared type. Each module author reads the README and returns an object matching this shape.

**Backend module** (`modules/<id>/backend.ts`):

```ts
export default {
  kind: "device" | "widget",
  id: string,
  title: string,

  // Config & parameters
  configSchema: object,                       // JSON-schema-like
  secretFields?: string[],
  defaultConfig?: object,

  // State
  initialState?: object,

  // Lifecycle
  start?: (ctx) => Promise<void>,
  stop?: () => Promise<void>,

  // RPC
  methods?: string[],                         // e.g. ["encoder."]
  events?: string[],
  dispatch?: (method, params) => Promise<unknown>,

  // Status
  status?: () => Promise<object>,

  // Services exposed to dependent modules and to the capability bus
  services?: object,

  // Module dependencies (resolved by core before start)
  dependencies?: string[],

  // Widget-only
  hubFactory?: () => unknown,
};
```

**Frontend module** (`modules/<id>/frontend.ts`):

```ts
export default {
  kind: "device-card" | "widget",
  id: string,
  title: string,
  icon?: string,
  component: (status) => unknown,             // mithril vnode
  defaultSize: { w: number, h: number },
  minSize: { w: number, h: number },
  maxSize?: { w: number, h: number },
  handleEvent?: (event, data) => void,

  // Widget-only
  configFields?: string[],
  channelOf?: (w) => string,
  body?: (w, live) => unknown,
  badge?: (w, live) => unknown,
};
```

The `ctx` passed to `start` is also a documented shape (not imported):

```ts
interface ModuleContext {
  config: object; // this module's config slice
  emit: (event: string, data: unknown) => void;
  log: (section: string, message: string) => void;
  deps: Record<string, unknown>; // services from dependencies
}
```

### 3.3 Structural typing in practice

Because modules are loaded via dynamic `import()` (backend) or a generated static-import manifest (frontend), TypeScript doesn't type-check the boundary anyway. The core enforces shape at runtime. Modules keep their own internal types local to their directory.

If a module wants compile-time help, it can define its own local type inside `modules/<id>/types.ts` — but that file is private to the module and is never imported by the core or other modules.

---

## 4. Discovery

### 4.1 Frontend discovery — Option A (build-time generated manifest)

**The browser bundle never uses `Bun.Glob`.** Instead, a small Bun script scans `modules/*/frontend.ts` at build time and emits a static-import manifest. The frontend registry imports that manifest. The manifest contains **only paths**, never module internals, and is **never hand-edited**.

#### The generator

New file: `scripts/gen-modules.ts` (runs in Bun, not in the browser).

```ts
// scripts/gen-modules.ts
import { Glob } from "bun";
import { writeFile } from "node:fs/promises";
import { relative } from "node:path";

const OUT = "modules/.generated.frontend.ts";
const glob = new Glob("modules/*/frontend.ts");

async function main() {
  const paths: string[] = [];
  for await (const p of glob.scan(".")) paths.push(p);
  paths.sort(); // deterministic output

  const lines = [
    "// AUTO-GENERATED by scripts/gen-modules.ts — DO NOT EDIT.",
    "// Regenerated on dev/build. See REFACTCOR.md §4.1.",
    "",
  ];

  if (paths.length === 0) {
    lines.push("export default [] as unknown[];", "");
  } else {
    paths.forEach((p, i) => {
      // Strip leading "modules/" so the manifest sits at modules/.generated...
      // and can import "./encoder/frontend".
      const rel = "./" + relative("modules", p).replace(/\.ts$/, "");
      lines.push(`import m${i} from ${JSON.stringify(rel)};`);
    });
    lines.push("");
    lines.push(
      `export default [${paths.map((_, i) => `m${i}`).join(", ")}] as unknown[];`,
      "",
    );
  }

  const next = lines.join("\n");
  // Avoid touching the file (and triggering watchers) if unchanged.
  try {
    const prev = await Bun.file(OUT).text();
    if (prev === next) return;
  } catch {
    /* file missing */
  }
  await writeFile(OUT, next);
  console.log(
    `[gen-modules] wrote ${OUT} (${paths.length} frontend module(s))`,
  );
}

await main();
```

Notes:

- The generator **does not import** the modules — it only lists paths. A broken module therefore never breaks the generator.
- Output is sorted for deterministic rebuilds.
- The write is skipped when content is unchanged, so `--watch` loops don't churn.

#### The generated file

Example output of `modules/.generated.frontend.ts`:

```ts
// AUTO-GENERATED by scripts/gen-modules.ts — DO NOT EDIT.
// Regenerated on dev/build. See REFACTCOR.md §4.1.

import m0 from "./encoder/frontend";
import m1 from "./kick-chat/frontend";
import m2 from "./kick-stats/frontend";
import m3 from "./modems/frontend";
import m4 from "./obs-controller/frontend";
import m5 from "./srtla/frontend";
import m6 from "./tiktok-chat/frontend";
import m7 from "./twitch-chat/frontend";
import m8 from "./youtube-chat/frontend";

export default [m0, m1, m2, m3, m4, m5, m6, m7, m8] as unknown[];
```

- It is `.ts`, so the bundler statically resolves each import. No dynamic `import()` needed at runtime.
- It is checked into `.gitignore` (regenerated on every dev/build run), **or** committed if the maintainer prefers IDE friendliness — either works, but if committed it must be regenerated in CI to catch drift.

Recommendation: **gitignore it**, regenerate on `dev` and `build`.

#### The rewritten registry

`registry.frontend.ts` becomes:

```ts
import MANIFEST from "./.generated.frontend";

function isFrontendRegistration(x: unknown): x is {
  kind: "device-card" | "widget";
  id: string;
  title: string;
  component: (status: unknown) => unknown;
  defaultSize: { w: number; h: number };
  minSize: { w: number; h: number };
  maxSize?: { w: number; h: number };
  icon?: string;
  handleEvent?: (event: string, data: unknown) => void;
  configFields?: string[];
  channelOf?: (w: unknown) => string;
  body?: (w: unknown, live: unknown) => unknown;
  badge?: (w: unknown, live: unknown) => unknown;
} {
  if (!x || typeof x !== "object") return false;
  const r = x as Record<string, unknown>;
  return (
    (r.kind === "device-card" || r.kind === "widget") &&
    typeof r.id === "string" &&
    typeof r.title === "string" &&
    typeof r.component === "function"
  );
}

const registrations = MANIFEST.filter(isFrontendRegistration);

export const FRONTEND_MODULES = registrations.filter(
  (r) => r.kind === "device-card",
);
export const WIDGET_MODULES = registrations.filter((r) => r.kind === "widget");
```

- No module names.
- No `Glob`.
- No top-level `await`.
- Works in the browser bundle because `MANIFEST` statically imports every module at build time.

#### Build pipeline wiring

In `package.json`:

```json
{
  "scripts": {
    "gen:modules": "bun scripts/gen-modules.ts",
    "predev": "bun run gen:modules",
    "prebuild": "bun run gen:modules",
    "dev": "bun --watch src/index.ts",
    "build": "bun build src/index.ts public/ts/app.ts --outdir dist"
  }
}
```

Dev-time regeneration on module changes: run the generator in watch mode alongside the dev server, or use a file watcher:

```json
"dev": "bun run gen:modules && (bun --watch scripts/gen-modules.ts &) && bun --watch src/index.ts"
```

Simplest robust setup:

```json
"dev": "bun run scripts/dev.ts"
```

with `scripts/dev.ts` doing:

```ts
// scripts/dev.ts
import { watch } from "node:fs";
import { spawn } from "bun";

async function gen() {
  await Bun.$`bun scripts/gen-modules.ts`.quiet();
}

await gen();

watch("modules", { recursive: true }, async (_evt, file) => {
  if (!file || !file.endsWith("frontend.ts")) return;
  await gen();
});

const server = spawn(["bun", "--watch", "src/index.ts"], {
  stdout: "inherit",
  stderr: "inherit",
});

await server.exited;
```

If the maintainer prefers to keep `package.json` scripts minimal, add the watcher to the existing dev entry point instead. Either way: **the generator must run before the bundler sees `registry.frontend.ts`.**

#### CI

Add a CI step that regenerates the manifest and fails on drift:

```bash
bun run gen:modules
git diff --exit-code modules/.generated.frontend.ts || \
  (echo "Run 'bun run gen:modules' and commit the result"; exit 1)
```

Skip this if the manifest is gitignored; in that case just ensure `gen:modules` runs before any typecheck or build.

#### Why not the alternatives

- **Option B (`Bun.build` resolves a glob import):** couples the source to a specific bundler, harder to typecheck, harder to reason about in editors, and doesn't help when the frontend is run un-bundled.
- **Option C (JSON manifest of paths):** still needs a runtime dynamic `import()` per path, which defeats static tree-shaking and forces a runtime loading model the rest of the codebase doesn't use.

Option A keeps the source idiomatic (static `import` statements in a TS file), works with any bundler, and gives editors full type info on the imported module objects.

### 4.2 Backend discovery — runtime `Bun.Glob`

The backend runs in Bun and can use `Bun.Glob` at runtime. **Only the frontend needs the generated manifest.**

If, for some reason, the backend entry point cannot use top-level `await`, the same generator pattern applies — emit `modules/.generated.backend.ts` and import it synchronously from `registry.backend.ts`.

`registry.backend.ts` becomes:

```ts
import { Glob } from "bun";

// Runtime shape check — no shared types imported.
function isBackendRegistration(x: unknown): x is {
  kind: string;
  id: string;
  title: string;
  configSchema: object;
  start?: Function;
  stop?: Function;
  methods?: string[];
  events?: string[];
  dispatch?: Function;
  status?: Function;
  services?: object;
  dependencies?: string[];
  hubFactory?: Function;
  secretFields?: string[];
  defaultConfig?: object;
  initialState?: object;
} {
  if (!x || typeof x !== "object") return false;
  const r = x as Record<string, unknown>;
  return (
    (r.kind === "device" || r.kind === "widget") &&
    typeof r.id === "string" &&
    typeof r.title === "string" &&
    typeof r.configSchema === "object" &&
    r.configSchema !== null
  );
}

const backendGlob = new Glob("modules/*/backend.ts");

export async function loadBackendModules() {
  const out: any[] = [];
  for await (const path of backendGlob.scan(".")) {
    const mod = await import(`../${path}`);
    const reg = mod.default ?? mod.registration;
    if (!isBackendRegistration(reg)) {
      throw new Error(`invalid backend module at ${path}`);
    }
    out.push(reg);
  }
  return out;
}

export function resolveOrder(mods: any[]) {
  const byId = new Map(mods.map((m) => [m.id, m]));
  const seen = new Set<string>();
  const order: any[] = [];
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    const m = byId.get(id);
    if (!m) throw new Error(`unknown dependency: ${id}`);
    for (const d of m.dependencies ?? []) visit(d);
    order.push(m);
  };
  for (const m of mods) visit(m.id);
  return order;
}

export function buildMethodOwner(mods: any[]) {
  const owner = new Map<string, string>();
  for (const m of mods) for (const ns of m.methods ?? []) owner.set(ns, m.id);
  return owner;
}
```

**Nothing in the registry names a module.** The set of module IDs is data, not code.

---

## 5. Core consumers adapt to opaque modules

| Core file                      | Change                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/methods.ts`               | Delete the hard-coded `METHOD_OWNER`. Import `getMethodOwner()` from the registry (built from discovered modules). `buildStatus()` iterates all discovered device modules.                                                                                                                                                                                                                |
| `src/stream.ts`                | Replace `import { encoderServices }` with `getModuleService("encoder", "startStream")`. Note: the string `"encoder"` here is a **dependency the core declares** — this is the one legitimate place module IDs may appear. If even that is unacceptable, invert the flow: modules push their services into a `ServiceBus` on start, and the core subscribes by capability name (see §5.1). |
| `src/client.ts`                | Use `startModules()` / `stopModules()` from the registry. No module names.                                                                                                                                                                                                                                                                                                                |
| `src/routing.ts`               | Fetch modem enrichment via a capability, not a module ID. See §5.1.                                                                                                                                                                                                                                                                                                                       |
| `public/ts/app.ts`             | Import `FRONTEND_MODULES` and `WIDGET_MODULES` from the frontend registry. No module names.                                                                                                                                                                                                                                                                                               |
| `modules/types.ts`             | **Deleted.**                                                                                                                                                                                                                                                                                                                                                                              |
| `modules/widgets.ts`           | Either deleted, or reduced to a doc-only file that nothing imports. Widget-specific types move into each widget module's directory.                                                                                                                                                                                                                                                       |
| `modules/registry.backend.ts`  | Rewritten as discovery + validation.                                                                                                                                                                                                                                                                                                                                                      |
| `modules/registry.frontend.ts` | Rewritten as discovery + validation (via generated manifest).                                                                                                                                                                                                                                                                                                                             |

### 5.1 Capability bus (removes the last module-ID references)

To avoid the core naming `"encoder"` or `"modems"`, introduce a small capability bus:

```ts
// src/capabilities.ts  (core-owned, generic)
const providers = new Map<string, unknown>();
export function provide(capability: string, impl: unknown) {
  providers.set(capability, impl);
}
export function require<T>(capability: string): T | undefined {
  return providers.get(capability) as T;
}
```

A module declares what it provides inside its `services` object, e.g.:

```ts
// modules/encoder/backend.ts
export default {
  id: "encoder",
  // ...
  services: {
    capabilities: {
      "stream.encoder": { startStream, stopStream, status },
    },
    // module-private services for dependents:
    encoderServices: { ... },
  },
};
```

The registry, during start, calls `provide(name, impl)` for each capability a module declares. The core then calls `require("stream.encoder")` — it names a **capability**, not a module.

This is the cleanest end state: **the core never mentions a module ID, filename, or type.** It only knows capability names it needs.

---

## 6. Refactoring tasks (ordered)

### Task 1: Delete `modules/types.ts`

- Move any shared type definitions into the registry as internal, non-exported shapes.
- Move widget-related types either into each widget module or delete them.
- Grep the repo for `from "./types"` and `from "../types"` under `modules/` and remove every hit.

### Task 2: Convert every backend module to a default-exported plain object

For `encoder`, `srtla`, `modems`, `obs-controller`:

1. Remove `import type { DeviceModule, ModuleContext } from "../types"`.
2. Replace `export const encoderModule: DeviceModule = { ... }` with `export default { ... }`.
3. Move the module's services under `services` (with `capabilities` if using §5.1).
4. Add `dependencies: [...]` where needed (e.g., `obs-controller` may depend on `modems`).
5. Define any local types inside the module directory only if desired; do not export them for the core.

### Task 3: Convert every frontend module to a default-exported plain object

Same treatment for `frontend.ts` files. Default export only. No shared types imported.

### Task 4: Convert widget modules

For `kick-stats`, `kick-chat`, `tiktok-chat`, `twitch-chat`, `youtube-chat`:

- Backend: default export with `kind: "widget"`, plus a `hubFactory` function. No `widgets.ts` import.
- Frontend: default export with `kind: "widget"`.

### Task 5: Rewrite `registry.backend.ts`

- Glob discovery of `modules/*/backend.ts`.
- Runtime `isBackendRegistration` guard.
- Topological sort on `dependencies`.
- `buildMethodOwner`.
- `startModules` / `stopModules` / `makeCtx` operate on discovered registrations.
- `getModuleService(id, name)` and (if using §5.1) capability registration.
- No explicit module imports, no service re-exports.

### Task 6: Rewrite `registry.frontend.ts`

- Import `./.generated.frontend` (produced by `scripts/gen-modules.ts`, §4.1).
- Runtime guard on shape.
- Export `FRONTEND_MODULES` and `WIDGET_MODULES`, filtered by `kind`.

### Task 7: Update `src/methods.ts`

- Delete `METHOD_OWNER`.
- Import `getMethodOwner()` from the registry.
- `buildStatus()` iterates discovered device modules only.

### Task 8: Update `src/stream.ts`, `src/client.ts`, `src/routing.ts`

- Replace direct module imports with capability lookups (`require("stream.encoder")`, `require("modems.detect")`, etc.).
- No module ID strings remain in these files.

### Task 9: Update `public/ts/app.ts`

- Consume `FRONTEND_MODULES` / `WIDGET_MODULES`.
- No module names.

### Task 10: Update `modules/README.md`

- Document the **documentation contract** (the shape above) as text, not as a shared file.
- Document the "no shared types" rule explicitly.
- Document the capability bus.
- Document dependency declaration and topological ordering.
- Document how to add a module: create a directory, add `backend.ts` and/or `frontend.ts` with a default export matching the documented shape. For frontend modules, regeneration happens automatically — no core edits.

### Task 11: Add CI drift check

- Add a CI step that runs `bun run gen:modules` and diffs the generated manifest (if the manifest is committed), or simply runs the generator before typecheck/build (if gitignored).

### Task 12: Fixture test

- Create `modules/example-module/{backend.ts,frontend.ts,styles.css}`.
- Confirm it is discovered, validated, started, rendered, and removable without touching the core.
- Confirm `grep -R "example-module" src/ public/ modules/registry.*` returns nothing.

---

## 7. Constraints and gotchas

- **No shared types file.** If you find yourself wanting a shared type, use a runtime validator plus a README paragraph instead. Structural typing at dynamic-import boundaries is unenforced anyway.
- **Modules may not import from `../`.** Add a lint rule if possible: `no-restricted-imports` with pattern `../*` scoped to `modules/**/*.ts`, allowing `./*` and package imports only. The single exception: the module may import its own files.
- **No core file names a module ID.** Enforce with a grep in CI. Capability names (`stream.encoder`, `modems.detect`) are allowed; module IDs are not.
- **Runtime validation is mandatory.** Since TS can't check the boundary, the registry must validate. If using zod, the module may use zod too (npm dependency, not a shared file).
- **Dependency cycles:** throw at load. Strict.
- **Method namespaces:** unchanged. Namespaces are declared in the module's `methods` array and turned into the owner map by the registry.
- **Config validation:** move each module's validation into the module itself, exposed via a `validate(config)` hook on the registration. Core calls it generically.
- **Frontend discovery:** build-time generated manifest (§4.1). Do not attempt `Glob` in the browser.
- **Backend discovery:** runtime `Bun.Glob` (§4.2). Use the generated-manifest fallback only if top-level `await` is off-limits.

---

## 8. File-by-file change map

| File                                         | Action                                                                                                               |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `modules/types.ts`                           | **Delete.**                                                                                                          |
| `modules/widgets.ts`                         | **Delete** (or reduce to doc-only, imported by nobody).                                                              |
| `modules/.generated.frontend.ts`             | **Generated.** Static imports of every frontend module; default-exports an array. Gitignored. Never edited by hand.  |
| `scripts/gen-modules.ts`                     | **New.** Scans `modules/*/frontend.ts`, emits `modules/.generated.frontend.ts`.                                      |
| `scripts/dev.ts`                             | **New (optional).** Watches `modules/**/frontend.ts`, regenerates, then spawns the dev server.                       |
| `modules/registry.backend.ts`                | Rewrite: glob discovery, runtime guard, topo sort, method-owner builder, capability bus wiring. No explicit imports. |
| `modules/registry.frontend.ts`               | Rewrite: imports `./.generated.frontend`, applies runtime guard, filters by kind. No `Glob`, no module names.        |
| `modules/encoder/backend.ts`                 | Default export plain object. Remove `../types` import. Move services into `services`.                                |
| `modules/encoder/frontend.ts`                | Default export plain object. Remove `../types` import.                                                               |
| `modules/srtla/backend.ts`                   | Same.                                                                                                                |
| `modules/srtla/frontend.ts`                  | Same.                                                                                                                |
| `modules/modems/backend.ts`                  | Same.                                                                                                                |
| `modules/modems/frontend.ts`                 | Same.                                                                                                                |
| `modules/obs-controller/backend.ts`          | Same; declare `dependencies: ["modems"]` if applicable.                                                              |
| `modules/obs-controller/frontend.ts`         | Same.                                                                                                                |
| `modules/kick-stats/{backend,frontend}.ts`   | Default export with `kind: "widget"`; `hubFactory` in backend. No shared type import.                                |
| `modules/kick-chat/{backend,frontend}.ts`    | Same.                                                                                                                |
| `modules/tiktok-chat/{backend,frontend}.ts`  | Same.                                                                                                                |
| `modules/twitch-chat/{backend,frontend}.ts`  | Same.                                                                                                                |
| `modules/youtube-chat/{backend,frontend}.ts` | Same.                                                                                                                |
| `src/capabilities.ts`                        | **New**, core-owned, generic. Optional but recommended.                                                              |
| `src/methods.ts`                             | Remove `METHOD_OWNER`; use registry-built owner map. No module names.                                                |
| `src/stream.ts`                              | Use capability lookups; no module imports.                                                                           |
| `src/client.ts`                              | Use registry lifecycle helpers; no module names.                                                                     |
| `src/routing.ts`                             | Use capability lookup; no module names.                                                                              |
| `public/ts/app.ts`                           | Use frontend registry exports; no module names.                                                                      |
| `modules/README.md`                          | Rewrite: documented contract, no-types rule, capability bus, dependency mechanism, how to add a module.              |
| `package.json`                               | Add `gen:modules`, `predev`, `prebuild`. Optionally replace `dev` with `scripts/dev.ts`.                             |
| `.gitignore`                                 | Add `modules/.generated.frontend.ts`.                                                                                |
| `.github/workflows/*.yml` (or equivalent CI) | Add a drift check that regenerates and diffs (or simply runs the generator before typecheck/build).                  |

---

## 9. Verification checklist

- [ ] `grep -R "modules/types" .` returns nothing.
- [ ] `grep -R "from \"../types\"" modules/` returns nothing.
- [ ] `grep -R "from \"../widgets\"" modules/` returns nothing.
- [ ] `grep -R "from \"../../src" modules/` returns nothing.
- [ ] No file under `src/`, `public/`, or `modules/registry.*` contains a module ID string (`encoder`, `srtla`, `modems`, `obs-controller`, `kick-*`, `tiktok-*`, `twitch-*`, `youtube-*`).
- [ ] Adding `modules/test-module/backend.ts` + `frontend.ts` with default exports works with zero core edits.
- [ ] Removing `modules/encoder/` and its `dependencies` from other modules breaks nothing except capabilities that depended on it (as expected).
- [ ] Runtime validation rejects a malformed module with a clear error.
- [ ] Dependency cycle throws at load.
- [ ] `METHOD_OWNER` is built dynamically from `methods` arrays.
- [ ] `buildStatus()` includes fragments from all running device modules.
- [ ] Frontend bundle builds with the generated manifest.
- [ ] Existing tests pass; manual smoke test passes.

Option A–specific:

- [ ] `bun run gen:modules` produces `modules/.generated.frontend.ts` with one import per `modules/*/frontend.ts`.
- [ ] Deleting a frontend module directory and re-running the generator removes its import.
- [ ] Adding `modules/newthing/frontend.ts` and re-running the generator adds it — with no edits to `registry.frontend.ts` or anywhere in `src/` or `public/`.
- [ ] `registry.frontend.ts` contains no `Glob`, no module ID strings, no top-level `await`.
- [ ] The frontend bundle builds and runs with the generated manifest.
- [ ] `.gitignore` contains `modules/.generated.frontend.ts`.
- [ ] CI regenerates the manifest before typecheck/build (and diffs it if committed).

---

## 10. Suggested implementation order

1. Add `src/capabilities.ts` (new, additive).
2. Add `scripts/gen-modules.ts` and run it — confirm it produces `modules/.generated.frontend.ts` with the current module list.
3. Wire `predev` / `prebuild` in `package.json` and add `modules/.generated.frontend.ts` to `.gitignore`.
4. Convert one device module (`encoder`) end-to-end: remove `../types` import, default export, register capability, update the registry to accept both old and new shapes.
5. Convert remaining device modules.
6. Convert widget modules.
7. Rewrite `registry.backend.ts` (runtime `Glob`) and `registry.frontend.ts` (imports `.generated.frontend`).
8. Update core consumers (`src/*`, `public/ts/app.ts`).
9. Delete `modules/types.ts` and `modules/widgets.ts`.
10. Update `modules/README.md`.
11. Add CI drift check for the generated manifest.
12. Add the fixture module test and CI greps.
13. Run the verification checklist.

---

## 11. Open questions for the maintainer

Resolved:

- Runtime validator: zod
- Capability bus vs. module-ID lookups - capability bus so the core names capabilities, not module ID
- Frontend discovery: **Option A** (build-time generated manifest).
- Backend discovery: **runtime `Bun.Glob`** (with a generated fallback only if top-level `await` is off-limits).
- `modules/types.ts` and `modules/widgets.ts` as module dependencies: **removed**.
- Manifest committed or gitignored: **gitignored**, regenerated on dev/build, with an optional CI drift check.
