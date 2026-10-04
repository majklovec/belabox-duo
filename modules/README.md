# Modules

Device modules are the building blocks of a belabox-duo device. Each module owns
one cohesive slice of behavior — a subprocess, a poller, a websocket — plus the
RPC methods it answers, the events it pushes, its device-page card and its CSS.

## Layout

Exactly three files per module, no exceptions:

```
modules/
  types.ts             # shared contract (dependency-free)
  registry.backend.ts  # ALL_MODULES for the device runtime
  registry.frontend.ts # FRONTEND_MODULES for the device page
  README.md
  encoder/      backend.ts · frontend.ts · styles.css
  srtla/        backend.ts · frontend.ts · styles.css
  modems/       backend.ts · frontend.ts · styles.css
  obs-controller/
  kick-stats/
  kick-chat/
```

## Contract

`modules/types.ts` defines `DeviceModule` (backend) and `BrowserModule`
(frontend). The backend shape is implemented in `backend.ts`; the front-end
component and event handlers live in `frontend.ts`; module CSS lives in
`styles.css` with every selector scoped under `.mod-<id>`.

## Rules

- The core files `src/methods.ts`, `src/client.ts` and `public/ts/app.ts`
  import **only** from `registry.backend.ts` / `registry.frontend.ts`, never
  from a concrete module.
- No cross-module imports except through `types.ts` (and the shared device
  store in the browser): modules never import each other.
- `backend.ts` runs in Bun on the host — no mithril/DOM. `frontend.ts` runs in
  the browser — no `../../src` imports.
- Module method and event names are frozen: renaming one is a breaking API
  change.
- `obs-client.ts` stays at the repo root; it is imported only by
  `modules/obs-controller/backend.ts`.

### Deviations from the base contract

- `DeviceModule.status?()` (optional, registered in `registry.backend.ts`):
  `buildStatus()` in `src/methods.ts` asks each running module for its status
  fragment (modem list, srtla state, …) instead of importing the module.
- The registries also host the module runtime helpers the core needs
  (`startModules`, `stopModules`, `configureModule`, …) — the old
  `src/modules/index.ts` moved here.

## Adding a module

1. `mkdir modules/<id>` and create `backend.ts`, `frontend.ts`, `styles.css`.
2. Register the module in `registry.backend.ts` (and `registry.frontend.ts` if
   it has a card). No other core file needs changes beyond the METHOD_OWNER
   map in `src/methods.ts` for new `*.` method namespaces.
