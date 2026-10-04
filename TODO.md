# Handoff: Module Directory Refactor

**Target repo:** `majklovec/belabox-duo`
**Scope:** Purely structural. Move all six existing modules — `encoder`, `srtla`, `modems`, `obs-controller`, `kick-stats`, `kick-chat` — into a new `modules/<name>/` layout with `backend.ts`, `frontend.ts`, `styles.css`. Introduce a two-registry system. **No new features, no behavior changes.**
**Success criterion:** UI and API responses are byte-for-byte identical to pre-refactor. Only the file tree and import graph change.

This is a mechanical refactor of code that already exists. All six modules are present in the codebase today, scattered across `src/` and `public/ts/device/`. The goal is to consolidate them.

---

## 1. Why This Refactor

Today, module code is scattered:

- Backend logic lives in `src/` (e.g., `src/encoder.ts`, `src/srtla.ts`, `src/obs.ts`, `src/kick-stats.ts`, `src/kick-chat.ts`).
- Frontend cards live in `public/ts/device/` (e.g., `encoder.ts`, `srtla.ts`, `obs.ts`, `kick-stats.ts`, `kick-chat.ts`).
- Styles live in `public/css/` or are inline.

Six modules × three locations = eighteen files to touch whenever the module system evolves. After this refactor, each module is self-contained, and adding or removing one is a two-line registry change.

---

## 2. Target Layout

```
modules/                              # NEW: repo root, single tree
  types.ts                            # shared interfaces
  registry.backend.ts                 # backend module list
  registry.frontend.ts                # frontend module list
  README.md                           # contract + how to add a module
  encoder/
    backend.ts
    frontend.ts
    styles.css
  srtla/
    backend.ts
    frontend.ts
    styles.css
  modems/
    backend.ts
    frontend.ts
    styles.css
  obs-controller/
    backend.ts
    frontend.ts
    styles.css
  kick-stats/
    backend.ts
    frontend.ts
    styles.css
  kick-chat/
    backend.ts
    frontend.ts
    styles.css
```

**Three files per module, always. No exceptions.**

| File          | Runtime | Exports                     | Imports                             |
| ------------- | ------- | --------------------------- | ----------------------------------- |
| `backend.ts`  | Bun     | exactly one `DeviceModule`  | Bun APIs, `../types`, protocol libs |
| `frontend.ts` | Browser | exactly one `BrowserModule` | Mithril, `../types`, `device/store` |
| `styles.css`  | Browser | (side-effect only)          | nothing                             |

**Two registries, not one.** `registry.backend.ts` is imported by `src/methods.ts` and `src/client.ts`. `registry.frontend.ts` is imported by `public/ts/app.ts`. A single registry would drag Mithril into the Bun process or Bun into the browser bundle. Keep them separate.

**`obs-client.ts` sits at the app root, next to `client.ts` and `server.ts`.** It's a low-level obs-websocket protocol library / standalone device proxy (run with `bun obs-client.ts`), not a module. Only `modules/obs-controller/backend.ts` imports it. Moving it into `modules/obs-controller/` would violate the "three files per module" rule; keeping it at the root preserves the boundary.

---

## 3. Shared Types (`modules/types.ts`)

Create this file verbatim. It uses `unknown` for schema and component types on purpose — shared types must not couple to Zod or Mithril, or the wrong runtime ends up importing the wrong library.

```ts
/**
 * modules/types.ts
 *
 * Shared module interfaces. Imported by both backend.ts (Bun) and
 * frontend.ts (browser). MUST NOT import zod, mithril, or any runtime-specific
 * library — that would leak one runtime's deps into the other.
 */

// ---------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------

export interface DeviceModule {
  /** Stable id. Same string as the frontend module. Convention: kebab-case. */
  id: string;
  /** Human-readable title shown in the dashboard editor. */
  title: string;
  /**
   * Zod schema validating the `config` object passed to modules.configure.
   * Typed as `unknown` here so this file does not import zod.
   * The module's own backend.ts casts it to ZodSchema.
   */
  configSchema: unknown;
  /** Field names in configSchema that must be redacted from every outbound payload. */
  secretFields: string[];
  /** Called when the module is enabled or the device boots. Must be idempotent. */
  start(ctx: ModuleContext): Promise<void>;
  /** Called on disable, config change, or shutdown. Must be idempotent. */
  stop(): Promise<void>;
  /** Method names this module owns. Used for gating and dispatch. */
  methods: string[];
  /** Event names this module emits. Used by push.ts for validation. */
  events: string[];
  /** Route a request method to the module. Called only if enabled. */
  dispatch(method: string, params: unknown): Promise<unknown>;
}

export interface ModuleContext {
  /** Current config slice for this module (validated). */
  config: Record<string, unknown>;
  /** Emit a belabox-duo event, tagged with this module's id. */
  emit(event: string, data: unknown): void;
  /** Scoped logger. Never pass secrets to it. */
  log(msg: string, ...rest: unknown[]): void;
}

// ---------------------------------------------------------------------------
// Frontend
// ---------------------------------------------------------------------------

export interface BrowserModule {
  /** Must equal the backend DeviceModule.id. */
  id: string;
  title: string;
  icon?: string;
  /**
   * Mithril Component. Typed as `unknown` here so this file does not import
   * mithril. The module's own frontend.ts casts it to m.Component.
   */
  component: unknown;
  /** Default width when added to a dashboard. */
  defaultWidth: "full" | "half" | "third";
  /** Route a pushed event into st.*. Called for every event whose `module` matches. */
  handleEvent?(event: string, data: unknown): void;
}
```

---

## 4. Registries

### `modules/registry.backend.ts`

```ts
import type { DeviceModule } from "./types";
import { encoderModule } from "./encoder/backend";
import { srtlaModule } from "./srtla/backend";
import { modemsModule } from "./modems/backend";
import { obsControllerModule } from "./obs-controller/backend";
import { kickStatsModule } from "./kick-stats/backend";
import { kickChatModule } from "./kick-chat/backend";

export const ALL_MODULES: DeviceModule[] = [
  encoderModule,
  srtlaModule,
  modemsModule,
  obsControllerModule,
  kickStatsModule,
  kickChatModule,
];

const BY_ID = new Map(ALL_MODULES.map((m) => [m.id, m]));

export function getModule(id: string): DeviceModule | undefined {
  return BY_ID.get(id);
}

export function moduleIds(): string[] {
  return ALL_MODULES.map((m) => m.id);
}
```

### `modules/registry.frontend.ts`

```ts
import type { BrowserModule } from "./types";
import { encoderModule } from "./encoder/frontend";
import { srtlaModule } from "./srtla/frontend";
import { modemsModule } from "./modems/frontend";
import { obsControllerModule } from "./obs-controller/frontend";
import { kickStatsModule } from "./kick-stats/frontend";
import { kickChatModule } from "./kick-chat/frontend";

export const ALL_MODULES: BrowserModule[] = [
  encoderModule,
  srtlaModule,
  modemsModule,
  obsControllerModule,
  kickStatsModule,
  kickChatModule,
];

const BY_ID = new Map(ALL_MODULES.map((m) => [m.id, m]));

export function getModule(id: string): BrowserModule | undefined {
  return BY_ID.get(id);
}
```

**Explicit imports, no auto-discovery.** No glob, no `import.meta.glob`, no filesystem scan. Six modules is trivial to maintain manually, and explicit imports give IDEs working "find references" and fail loudly at compile time when a module is missing.

---

## 5. Module File Contracts

### `modules/<id>/backend.ts`

```ts
import { z } from "zod";
import type { DeviceModule, ModuleContext } from "../types";

const schema = z.object({
  // module-specific config fields
});

let state: SomeRuntimeState | null = null;

export const <id>Module: DeviceModule = {
  id: "<id>",
  title: "<Title>",
  configSchema: schema,
  secretFields: [],
  methods: ["<method.namespace>"],  // may be empty if no RPC methods
  events: ["<event.name>"],         // may be empty if no push events

  async start(ctx: ModuleContext) {
    const cfg = schema.parse(ctx.config);
    // initialize state, subscribe to underlying service, emit via ctx.emit
  },

  async stop() {
    // tear down state, must be safe to call twice
    state = null;
  },

  async dispatch(method, params) {
    switch (method) {
      // case "<method.namespace>": return doThing(params);
      default:
        throw new Error(`unknown method: ${method}`);
    }
  },
};
```

**Rules:**

- Exactly one export. The `DeviceModule` object. No helper exports.
- `start` / `stop` must be idempotent. Calling `start` twice is a no-op the second time; calling `stop` on a stopped module is a no-op.
- All events go through `ctx.emit`, never through a direct import of `src/push.ts`. This keeps the module decoupled from the transport.
- All logging goes through `ctx.log`, never `console.log`. Secrets must never be passed to it.
- `configSchema.parse()` is called once at `start`; the module trusts the shape afterwards.

**Migration note for `obs-controller`:** the module wraps the existing `ObsClient` from `obs-client.ts` (app root). The client instance is created in `start`, disconnected in `stop`, and forwarded in `dispatch`. No changes to `obs-client.ts` itself.

### `modules/<id>/frontend.ts`

```ts
import m from "mithril";
import { st } from "../../public/ts/device/store";
import type { BrowserModule } from "../types";
import "./styles.css";

export const <id>Module: BrowserModule = {
  id: "<id>",
  title: "<Title>",
  icon: "...",
  defaultWidth: "third",

  component: {
    view() {
      // read from st, return vnodes
      return m("div.mod-<id>", /* ... */);
    },
  },

  handleEvent(event, data) {
    // route into st.<module> slice
  },
};
```

**Rules:**

- Exactly one export. The `BrowserModule` object.
- `view()` reads from `st` and is pure. No fetches, no side-effects, no `await`.
- `handleEvent` writes into the module's own slice of `st` (`st.obs`, `st.kick.stats`, `st.kick.chat`, etc.). Cross-module reads happen at render time from `st`, never via direct imports between module files.
- The outer wrapper element always carries `class="mod-<id>"` so styles can be scoped.

### `modules/<id>/styles.css`

```css
/* modules/<id>/styles.css */
.mod-<id > {
  /* ... */
}
.mod-<id > .child-selector {
  /* ... */
}
```

**Rules:**

- Every selector must be prefixed with `.mod-<id>`. Enforceable with a grep in CI (see §9).
- No `:root`, no global element selectors (`div { ... }`), no `@import`.
- Reference theme variables (`var(--color-fg)`) if the repo has them, but do not define them here.

### `modules/README.md`

Document the contract in plain language, plus "how to add a module in 5 steps":

```md
# Modules

Each module lives in `modules/<id>/` and consists of exactly three files:

- `backend.ts` — exports a `DeviceModule` (runs under Bun)
- `frontend.ts` — exports a `BrowserModule` (runs in the browser)
- `styles.css` — scoped under `.mod-<id>`

## Existing modules

| id               | Title      | Backend service     | Frontend card           |
| ---------------- | ---------- | ------------------- | ----------------------- |
| `encoder`        | Encoder    | belacoder control   | Encoder status card     |
| `srtla`          | SRTLA      | srtla_send control  | SRTLA status card       |
| `modems`         | Modems     | modem status poller | Modem status card       |
| `obs-controller` | OBS        | `ObsClient` bridge  | Scene / stream controls |
| `kick-stats`     | Kick Stats | 30 s poller         | Viewers / followers     |
| `kick-chat`      | Kick Chat  | Kick chat WS        | Chat message list       |

## Adding a module

1. `mkdir modules/<id>/`
2. Write `backend.ts` exporting `<id>Module: DeviceModule`.
3. Write `frontend.ts` exporting `<id>Module: BrowserModule`.
4. Write `styles.css` scoped under `.mod-<id>`.
5. Add one import + one array entry in `registry.backend.ts` and one in `registry.frontend.ts`.

Two registry edits, three files, done.

## Rules

- No file inside a module other than the three above.
- No cross-module imports (except through `types.ts` and `device/store`).
- `backend.ts` must not import Mithril. `frontend.ts` must not import Bun APIs.
- Every CSS selector must start with `.mod-<id>`.
```

---

## 6. Migration Steps (do in this exact order)

### Step 1 — Skeleton

Create at repo root:

- `modules/types.ts` (copy §3 verbatim)
- `modules/registry.backend.ts` (copy §4, but with all six imports commented out)
- `modules/registry.frontend.ts` (same)
- `modules/README.md`

Commit. Nothing else changes; the codebase still builds.

### Step 2 — Migrate the three simple modules (`encoder`, `srtla`, `modems`)

Do these first because they have no external protocol dependencies. For each:

1. Create `modules/<id>/backend.ts`. Move logic from the current backend file. Wrap in the `DeviceModule` shape. Export `<id>Module`.
2. Create `modules/<id>/frontend.ts`. Move the card component and its event handlers. Wrap in the `BrowserModule` shape. Export `<id>Module`.
3. Create `modules/<id>/styles.css`. Move styles. Prefix every selector with `.mod-<id>`.
4. Uncomment the corresponding imports and array entries in both registries.
5. Update `src/methods.ts` and `src/client.ts` to import from the registry instead of the old path.
6. Update `public/ts/app.ts` to import from `registry.frontend`.
7. Delete the old files.
8. **Build. Render. Confirm identical.**

Commit per module (three commits).

### Step 3 — Migrate `obs-controller`

Same eight sub-steps, with one difference: `modules/obs-controller/backend.ts` imports `ObsClient` from `obs-client.ts` (app root). Do **not** move or modify `obs-client.ts`. The module wraps it.

Commit.

### Step 4 — Migrate `kick-stats`

Same eight sub-steps. The 30 s polling interval and any Kick API libraries stay as-is. This is a mechanical move, not a rewrite.

Commit.

### Step 5 — Migrate `kick-chat`

Same eight sub-steps. The chat WebSocket listener stays as-is.

Commit.

### Step 6 — Regression gate

- Boot the device with each role that exercises a subset of modules (`encoder`, `relay`, `obs`).
- Open the UI. Every card renders as before.
- Trigger one action per module: start a stream, toggle SRTLA, switch an OBS scene, view Kick stats, see a chat message arrive.
- Check the browser console: zero errors.
- Check the device log: no "unknown module" or "unregistered method" warnings.
- Screenshot-diff or manual side-by-side against a pre-refactor build.

**Do not proceed past this step until the regression gate passes.** If it doesn't, revert and diagnose — do not fix forward.

### Step 7 — Cleanup

- `grep -rn` for old import paths. Remove dead files.
- Update `tsconfig.json` / bundler config with path alias `@modules/*` → `./modules/*` if the repo already uses aliases. Skip if not.
- Commit.

---

## 7. Wiring Changes

Only three files outside `modules/` should change:

### `src/methods.ts`

Replace per-module imports with a single registry import and an owner map:

```ts
import { ALL_MODULES, getModule } from "../modules/registry.backend";

const METHOD_OWNER = new Map<string, DeviceModule>();
for (const mod of ALL_MODULES) {
  for (const m of mod.methods) METHOD_OWNER.set(m, mod);
}

// In handleRequest(method, params):
const owner = METHOD_OWNER.get(method);
if (owner) {
  if (!state.modules[owner.id]?.enabled) return reject(409);
  return owner.dispatch(method, params);
}
// else: existing unknown-method path
```

The exact integration depends on how the current dispatcher is structured. The **contract** is: `methods.ts` never imports a specific module, only the registry.

### `src/client.ts`

```ts
import { ALL_MODULES, getModule } from "../modules/registry.backend";

// During boot:
for (const mod of ALL_MODULES) {
  if (state.modules[mod.id]?.enabled) {
    await mod.start({
      config: state.modules[mod.id],
      emit: (event, data) => pushEvent(event, { module: mod.id, data }),
      log: (msg, ...rest) => logger.info(`[${mod.id}] ${msg}`, ...rest),
    });
  }
}

// During shutdown:
for (const mod of ALL_MODULES) {
  if (state.modules[mod.id]?.enabled) await mod.stop();
}
```

If the current config doesn't have a `state.modules` shape yet, use the existing role-based config as a shim: `enabled = rolePresetIncludes(mod.id, ROLE)`. The full `state.modules` shape is out of scope for this refactor.

### `public/ts/app.ts`

```ts
import { ALL_MODULES, getModule } from "../../modules/registry.frontend";

// Once at boot:
for (const mod of ALL_MODULES) {
  if (mod.handleEvent) registerEventHandler(mod.id, mod.handleEvent);
}

// Render: unchanged for now. The role tree still exists, but each leaf
// renders `getModule("<id>").component` instead of a directly imported card.
```

The `renderRoleFallback` tree stays intact. Whatever the current role-based dispatch looks like, keep it — just swap the leaf components to come from the registry.

---

## 8. What NOT to Change

- **No behavior changes.** Same events, same methods, same shapes, same UI.
- **No new module IDs.** Only `encoder`, `srtla`, `modems`, `obs-controller`, `kick-stats`, `kick-chat`.
- **No config schema changes.** No `state.modules` shape introduced. Use the role-preset shim if needed.
- **No new dependencies.** If a module currently uses a library, keep it.
- **No changes to `obs-client.ts`.** Move nothing; edit nothing.
- **No `server.ts` changes.** Protocol is untouched.
- **No dashboard work.** That comes later.

The refactor is **purely mechanical**. Anything that feels like a design decision belongs in a follow-up handoff.

---

## 9. Verification Checklist

**Structural**

- [ ] `find modules -maxdepth 2 -type f` shows only `backend.ts`, `frontend.ts`, `styles.css` per module, plus the four root files.
- [ ] All six module directories exist and each contains exactly three files.
- [ ] No file named `card.ts`, `handlers.ts`, `config.ts`, `index.ts` inside any module.
- [ ] `grep -rn "mithril" modules/*/backend.ts` returns nothing.
- [ ] `grep -rn "from \"../../src" modules/*/frontend.ts` returns nothing.
- [ ] `grep -rn "obs-client" modules/ src/` shows exactly one import site: `modules/obs-controller/backend.ts` (plus the protocol imports in `src/methods.ts`).

**CSS**

- [ ] `grep -E "^\s*\.[a-z]" modules/*/styles.css` returns only selectors starting with `.mod-<id>`.
- [ ] No `:root` in any module stylesheet.
- [ ] No element-only selectors (`div`, `span`) at the top level of any module stylesheet.

**Build & runtime**

- [ ] `bun run build` (or the repo's build command) succeeds.
- [ ] Bun does not report a Mithril import in the backend bundle.
- [ ] Browser bundle does not include Bun APIs.

**Regression**

- [ ] `ROLE=encoder` device boots; UI renders identically; stream controls work.
- [ ] `ROLE=relay` device boots; UI renders identically; SRTLA/modem controls work.
- [ ] `ROLE=obs` device boots; UI renders identically; OBS scene switch works.
- [ ] `kick-stats` card updates at its existing interval.
- [ ] `kick-chat` card receives messages.
- [ ] No new console errors in the browser.
- [ ] No new warnings in the device log.
- [ ] Existing RPC methods (`status`, `settings.*`, `srtla.*`, `encoder.*`, `obs.*`) behave identically.
- [ ] Existing events (`status`, `srtla.*`, `obs.event`, `kick.stats`, `kick.chat`) reach the browser identically.
- [ ] Screenshot diff (or manual comparison) against a pre-refactor build is clean.

**Extensibility**

- [ ] Adding a stub module touches exactly two registry files and compiles. Test this manually with a throwaway module before declaring done.
- [ ] `ALL_MODULES.length === 6` in both registries.
- [ ] IDs match element-wise between the two registries. Add a test asserting this.

---

## 10. Anti-Patterns (merge blockers)

- **Do not** split a module across `src/` and `public/ts/`. Everything for one module lives in `modules/<id>/`.
- **Do not** add any file inside a module beyond `backend.ts`, `frontend.ts`, `styles.css`. If a module grows past three files, split it into two modules.
- **Do not** move `obs-client.ts` into `modules/obs-controller/`. It's a protocol library / standalone device proxy; it stays at the app root, next to `client.ts` and `server.ts`.
- **Do not** import `frontend.ts` from backend code or vice versa.
- **Do not** auto-discover modules via glob, `import.meta.glob`, or filesystem scan.
- **Do not** import `types.ts` in a way that pulls Mithril or Zod into the wrong runtime. Keep it dependency-free.
- **Do not** write CSS without the `.mod-<id>` prefix.
- **Do not** share mutable state between modules. Each module owns its slice of `st`.
- **Do not** rewrite module logic while moving it. Move first, then refactor in a separate commit if needed.
- **Do not** change any method or event name. Behavior is frozen during the refactor.
- **Do not** skip the Step 6 regression gate. If the UI differs at all, stop and diagnose.
- **Do not** bundle dashboard work into this refactor. It's a separate handoff.

---

## 11. Definition of Done

1. All six modules (`encoder`, `srtla`, `modems`, `obs-controller`, `kick-stats`, `kick-chat`) live in `modules/<id>/` with exactly three files each.
2. `registry.backend.ts` and `registry.frontend.ts` are the only places modules are enumerated.
3. `src/methods.ts`, `src/client.ts`, and `public/ts/app.ts` import from the registries, not from individual module paths.
4. `obs-client.ts` is unchanged and imported only by `modules/obs-controller/backend.ts`.
5. Build succeeds.
6. Regression gate passes: `encoder`, `relay`, and `obs` roles render and behave identically; Kick cards function as before.
7. Verification checklist (§9) fully checked.
8. Commit message names the refactor explicitly, e.g. `refactor: consolidate modules into modules/<id>/{backend,frontend,styles}`.
