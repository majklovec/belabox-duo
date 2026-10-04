# Handoff: belabox-duo OBS Role + Dashboards + Kick Modules

**Target repo:** `majklovec/belabox-duo`
**Runtime:** Bun (device), Mithril (browser)
**Deliverable:** New `obs` role, module system, dashboard CRUD, `kick-stats` + `kick-chat` modules.

---

## 1. Executive Summary

Extend belabox-duo in three layers:

1. **`obs` role** — device bridges OBS Studio (via obs-websocket v5) to the belabox-duo control server. Browser is never a direct OBS client. obs-websocket payloads (`d` fields of opcodes 5/6/7/8/9) are forwarded **verbatim** inside belabox-duo's existing envelope. No field renaming, no error-code remapping.
2. **Module system** — replace role-based gating with a `modules` config map. A role becomes a _preset_ that expands to a module set on first boot. Modules: `encoder`, `srtla`, `modems`, `obs-controller`, `kick-stats`, `kick-chat`.
3. **Dashboards** — per-device, multiple, ordered-list v1 layout. Users compose enabled modules into named dashboards and pick one active.

**Non-negotiable design rules** (do not re-litigate):

- obs-websocket payloads pass through opaque.
- `requestStatus.code` values are never remapped.
- Layout is ordered list + width class. **No drag-and-drop.**
- Dashboards are **per-device**, not per-viewer.
- `kick-stats` polls at exactly **30 s**. No config knob.
- Credentials are **UI-entered**, never returned to the browser, never logged.
- Existing `encoder` / `relay` behavior must be byte-for-byte identical when no dashboard is configured.

---

## 2. Required Reading (before writing any code)

From `majklovec/belabox-duo`:

| File                                      | Why                                                 |
| ----------------------------------------- | --------------------------------------------------- |
| `src/validate.ts`                         | `ROLES` array, `Role` type — single source of truth |
| `src/methods.ts`                          | `handleRequest()` dispatcher, `409` gating pattern  |
| `src/config.ts`                           | `ROLE` constant                                     |
| `src/state.ts`                            | Device config shape (extend here)                   |
| `src/push.ts` (or equivalent)             | Event fan-out to viewers                            |
| `server.ts`                               | Control server, viewer broadcast                    |
| `client.ts`                               | Role-gated subsystem startup                        |
| `public/ts/app.ts`                        | Mithril root, current `hasEncoder`/`hasRelay` tree  |
| `public/ts/device/store.ts`               | Shared frontend state `st`                          |
| `public/ts/device/encoder.ts`, `srtla.ts` | Card component patterns                             |
| `public/ts/api.ts`                        | `RpcClient`, reconnect + event replay               |
| `obs.html` (repo root)                    | Prototype UI — **visual reference only**            |

External:

- obs-websocket v5 protocol: https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md

---

## 3. Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│                  Browser (belabox-duo frontend)              │
│  app.ts → renderDashboard(activeDashboard)                   │
│    ├── registry.ts        (module → component + handler)     │
│    ├── dashboard.ts       (ordered-list grid renderer)       │
│    ├── dashboard-editor   (Dashboards / Layout / Modules)    │
│    └── device cards: obs-controller, kick-stats, kick-chat   │
└────────────────────────┬─────────────────────────────────────┘
                         │ WebSocket (existing belabox envelope)
┌────────────────────────▼─────────────────────────────────────┐
│                       server.ts (control)                    │
│           broadcasts events to all viewers per device        │
└────────────────────────┬─────────────────────────────────────┘
                         │ device WebSocket
┌────────────────────────▼─────────────────────────────────────┐
│                     Device (Bun runtime)                     │
│  methods.ts → handleRequest()  (module → handler map)        │
│  modules.ts  → DeviceModule registry                         │
│  modules/                                                    │
│    ├── obs-controller.ts ──► obs-client.ts ──► OBS Studio    │
│    ├── kick-stats.ts     ──► Kick API (30 s poll)            │
│    ├── kick-chat.ts      ──► Kick chat WS                    │
│    ├── encoder.ts, srtla.ts, modems.ts  (existing)           │
│  push.ts → events tagged with `module` field                 │
└──────────────────────────────────────────────────────────────┘
```

### Concepts (do not confuse these)

| Concept       | What                                     | Where            | Example                                   |
| ------------- | ---------------------------------------- | ---------------- | ----------------------------------------- |
| **Module**    | Atomic UI + backing service              | device + browser | `obs-controller`                          |
| **Role**      | Preset that expands to a module set      | device config    | `obs` → `{obs-controller:on, kick-*:off}` |
| **Dashboard** | User-chosen subset + order + active flag | device config    | "Stream day"                              |

---

## 4. Envelope Contract (OBS)

obs-websocket v5 payloads are wrapped as follows. **`d` is opaque.**

| obs-websocket                     | belabox-duo message                                                       |
| --------------------------------- | ------------------------------------------------------------------------- |
| `{op:6, d: Request}`              | `{type:"request", id, method:"obs.request", params: Request}`             |
| `{op:7, d: RequestResponse}`      | `{type:"response", id, result: RequestResponse}`                          |
| `{op:5, d: Event}`                | `{type:"event", event:"obs.event", module:"obs-controller", data: Event}` |
| `{op:8, d: RequestBatch}`         | `{type:"request", id, method:"obs.requestBatch", params: RequestBatch}`   |
| `{op:9, d: RequestBatchResponse}` | `{type:"response", id, result: RequestBatchResponse}`                     |

- Opcodes 0–3 (`Hello`, `Identify`, `Identified`, `Reidentify`) are **device-side only**. The browser never sees them.
- `requestStatus.code` semantics (100/2xx/4xx) are preserved.
- `requestId` is generated browser-side (`crypto.randomUUID()`) and passed through untouched.
- The one non-pass-through method is `obs.setEventSubscriptions`, because event intents are connection-level.
- On OBS disconnect the device emits a synthetic event `{eventType: "ObsDisconnected", eventIntent: 0, eventData: {}}`. This is custom, clearly OBS-prefixed, and documented as non-standard.
- On reconnect the device replays real obs-websocket-shaped events reconstructed from `Get*` responses (see `obs-client.ts` `replayState()`).

---

## 5. Data Model (device config)

Extend `src/state.ts`:

```ts
interface DeviceConfig {
  role: "encoder" | "relay" | "obs" | "custom";

  modules: {
    "encoder":        { enabled: boolean; ...existing };
    "srtla":          { enabled: boolean; ...existing };
    "modems":         { enabled: boolean; ...existing };
    "obs-controller": { enabled: boolean; obsUrl: string; obsPassword: string };
    "kick-stats":     { enabled: boolean; channel: string };
    "kick-chat":      { enabled: boolean; channel: string; token?: string };
  };

  dashboards: Dashboard[];
  activeDashboardId: string | null;
}

interface Dashboard {
  id: string;                // uuid
  name: string;
  items: DashboardItem[];
}

interface DashboardItem {
  moduleId: string;
  visible: boolean;
  width: "full" | "half" | "third";
  order: number;
}
```

**Migration:** on first boot with no `dashboards` field, auto-generate one named `"Default"` from the role preset. No config write unless the user edits. Existing devices see zero change.

**Secret redaction:** `obsPassword` and `kick-chat.token` are accepted as input via `modules.configure`, stored on disk, and returned to the browser only as booleans (`configured: true`). Never appear in `status`, `modules.list`, logs, or network tabs.

---

## 6. File-by-File Change Plan

### Backend

| File                            | Action        | Notes                                                                                                       |
| ------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------- |
| `src/validate.ts`               | Modify        | Add `"obs"` and `"custom"` to `ROLES`.                                                                      |
| `src/obs-client.ts`             | **Create**    | Full file in §7. Only component speaking obs-websocket protocol.                                            |
| `src/modules.ts`                | Create        | `DeviceModule` registry: `id`, `title`, `configSchema`, `secretFields`, `start/stop`, `methods`, `events`.  |
| `src/modules/obs-controller.ts` | Create        | Wraps `ObsClient`. Forwards events via `push.ts`.                                                           |
| `src/modules/kick-stats.ts`     | Create        | 30 s `setInterval` poller. Immediate fetch on start. Emits `kick.stats`.                                    |
| `src/modules/kick-chat.ts`      | Create        | WS listener. Emits `kick.chat`. Backoff reconnect.                                                          |
| `src/methods.ts`                | Modify        | Add `modules.*` and `dashboards.*` methods (§8). Gate `obs.*` on `modules["obs-controller"].enabled`.       |
| `src/push.ts`                   | Modify        | Add `module` field to event envelope.                                                                       |
| `src/state.ts`                  | Modify        | Extend config shape (§5). Add migration.                                                                    |
| `src/client.ts`                 | Modify        | Start/stop modules based on `state.modules`. Guard `srtla_send` / `belacoder` on `modules.encoder.enabled`. |
| `server.ts`                     | **No change** | Verify new events fan out automatically.                                                                    |

### Frontend

| File                                   | Action      | Notes                                                                           |
| -------------------------------------- | ----------- | ------------------------------------------------------------------------------- |
| `public/ts/device/registry.ts`         | Create      | Mirror backend registry.                                                        |
| `public/ts/device/dashboard.ts`        | Create      | Ordered-list renderer. 12-col grid.                                             |
| `public/ts/device/dashboard-editor.ts` | Create      | Three tabs: Dashboards / Layout / Modules.                                      |
| `public/ts/device/obs.ts`              | Create      | `obsRequest()`, `obsBatch()`, `obsCard`.                                        |
| `public/ts/device/kick-stats.ts`       | Create      | Stats card.                                                                     |
| `public/ts/device/kick-chat.ts`        | Create      | Chat card.                                                                      |
| `public/ts/device/store.ts`            | Modify      | Add `st.modules`, `st.dashboards`, `st.activeDashboardId`, `st.obs`, `st.kick`. |
| `public/ts/app.ts`                     | Modify      | Replace role tree with dashboard render + role fallback.                        |
| `public/ts/api.ts`                     | Verify only | Existing replay logic must still work.                                          |

---

## 7. `src/obs-client.ts` (full file — copy verbatim)

```ts
/**
 * src/obs-client.ts
 *
 * Low-level obs-websocket v5 client for the belabox-duo `obs` role.
 *
 * Responsibilities:
 *   - Maintain a single WebSocket connection to OBS Studio.
 *   - Perform Hello -> Identify -> Identified handshake (opcodes 0/1/2).
 *   - Forward `Request` (op 6) and `RequestBatch` (op 8) verbatim.
 *   - Resolve `RequestResponse` (op 7) / `RequestBatchResponse` (op 9) by requestId.
 *   - Emit `Event` (op 5) payloads to subscribers, unmodified.
 *   - Auto-reconnect with exponential backoff.
 *   - Emit a synthetic `ObsDisconnected` event on drop (non-standard, clearly marked).
 *   - On reconnect, replay a state snapshot as real-shaped obs-websocket events.
 *
 * Design rule: payloads of op 5/6/7/8/9 are opaque. This file does not rename,
 * reshape, or interpret fields inside `d`.
 *
 * Runtime: Bun (global WebSocket + WebCrypto). No Node shims.
 */

export enum ObsOpCode {
  Hello = 0,
  Identify = 1,
  Identified = 2,
  Reidentify = 3,
  Event = 5,
  Request = 6,
  RequestResponse = 7,
  RequestBatch = 8,
  RequestBatchResponse = 9,
}

export const EventSubscription = {
  None: 0,
  General: 1 << 0,
  Config: 1 << 1,
  Scenes: 1 << 2,
  Inputs: 1 << 3,
  Transitions: 1 << 4,
  Filters: 1 << 5,
  Outputs: 1 << 6,
  SceneItems: 1 << 7,
  MediaInputs: 1 << 8,
  Vendors: 1 << 9,
  Ui: 1 << 10,
  InputVolumeMeters: 1 << 16,
  InputActiveStateChanged: 1 << 17,
  InputShowStateChanged: 1 << 18,
  SceneItemTransformChanged: 1 << 19,
} as const;

export const DEFAULT_EVENT_SUBSCRIPTIONS =
  EventSubscription.General |
  EventSubscription.Config |
  EventSubscription.Scenes |
  EventSubscription.Inputs |
  EventSubscription.Transitions |
  EventSubscription.Filters |
  EventSubscription.Outputs |
  EventSubscription.SceneItems |
  EventSubscription.MediaInputs;

export interface ObsRequest {
  requestType: string;
  requestId: string;
  requestData?: Record<string, unknown>;
}

export interface ObsRequestStatus {
  result: boolean;
  /** 100 = success, 2xx = protocol error, 4xx = request error. Do NOT remap. */
  code: number;
  comment?: string;
}

export interface ObsRequestResponse {
  requestType: string;
  requestId: string;
  requestStatus: ObsRequestStatus;
  responseData?: Record<string, unknown>;
}

export interface ObsRequestBatch {
  requestId: string;
  requests: ObsRequest[];
  haltOnFailure?: boolean;
  /** 0 = SerialRealtime, 1 = SerialFrame, 2 = Parallel */
  executionType?: 0 | 1 | 2;
}

export interface ObsRequestBatchResponse {
  requestId: string;
  results: ObsRequestResponse[];
}

export interface ObsEvent {
  eventType: string;
  eventIntent: number;
  eventData?: Record<string, unknown>;
}

/** Synthetic event type emitted by this client only. Not part of obs-websocket. */
export const OBS_DISCONNECTED_EVENT = "ObsDisconnected";

export interface ObsClientOptions {
  url: string;
  password?: string;
  eventSubscriptions?: number;
  autoConnect?: boolean;
  disableReconnect?: boolean;
  log?: (msg: string, ...rest: unknown[]) => void;
}

type EventHandler = (data: Record<string, unknown>, event: ObsEvent) => void;

interface PendingRequest<T> {
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const RPC_VERSION = 1;
const REQUEST_TIMEOUT_MS = 10_000;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 15_000;

export class ObsClient {
  private readonly opts: ObsClientOptions & {
    autoConnect: boolean;
    disableReconnect: boolean;
    log: (msg: string, ...rest: unknown[]) => void;
  };

  private ws: WebSocket | null = null;
  private _identified = false;
  private connectPromise: Promise<void> | null = null;
  private closedByUser = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private eventSubscriptions: number;

  private readonly pending = new Map<
    string,
    PendingRequest<ObsRequestResponse>
  >();
  private readonly pendingBatch = new Map<
    string,
    PendingRequest<ObsRequestBatchResponse>
  >();
  private readonly listeners = new Map<string, Set<EventHandler>>();

  constructor(opts: ObsClientOptions) {
    this.opts = {
      autoConnect: true,
      disableReconnect: false,
      log: () => {},
      ...opts,
    };
    this.eventSubscriptions =
      opts.eventSubscriptions ?? DEFAULT_EVENT_SUBSCRIPTIONS;
    if (this.opts.autoConnect) {
      this.connect().catch((err) =>
        this.opts.log("initial connect failed", err),
      );
    }
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get identified(): boolean {
    return this._identified;
  }

  get subscriptions(): number {
    return this.eventSubscriptions;
  }

  connect(): Promise<void> {
    if (this._identified) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.doConnect().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  disconnect(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this._identified = false;
  }

  sendRequest(req: ObsRequest): Promise<ObsRequestResponse> {
    if (
      !this._identified ||
      !this.ws ||
      this.ws.readyState !== WebSocket.OPEN
    ) {
      return Promise.reject(new Error("obs_disconnected"));
    }
    return new Promise<ObsRequestResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(req.requestId);
        reject(new Error(`obs request timeout: ${req.requestType}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(req.requestId, { resolve, reject, timer });
      this.ws!.send(JSON.stringify({ op: ObsOpCode.Request, d: req }));
    });
  }

  sendBatch(batch: ObsRequestBatch): Promise<ObsRequestBatchResponse> {
    if (
      !this._identified ||
      !this.ws ||
      this.ws.readyState !== WebSocket.OPEN
    ) {
      return Promise.reject(new Error("obs_disconnected"));
    }
    return new Promise<ObsRequestBatchResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingBatch.delete(batch.requestId);
        reject(new Error(`obs batch timeout: ${batch.requestId}`));
      }, REQUEST_TIMEOUT_MS);
      this.pendingBatch.set(batch.requestId, { resolve, reject, timer });
      this.ws!.send(JSON.stringify({ op: ObsOpCode.RequestBatch, d: batch }));
    });
  }

  setEventSubscriptions(intents: number): void {
    this.eventSubscriptions = intents;
    if (!this._identified || !this.ws || this.ws.readyState !== WebSocket.OPEN)
      return;
    this.ws.send(
      JSON.stringify({
        op: ObsOpCode.Reidentify,
        d: { eventSubscriptions: intents },
      }),
    );
  }

  on(eventType: string, handler: EventHandler): void {
    let set = this.listeners.get(eventType);
    if (!set) {
      set = new Set();
      this.listeners.set(eventType, set);
    }
    set.add(handler);
  }

  off(eventType: string, handler: EventHandler): void {
    this.listeners.get(eventType)?.delete(handler);
  }

  private doConnect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.closedByUser = false;
      let settled = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve();
      };

      const ws = new WebSocket(this.opts.url);
      this.ws = ws;

      ws.addEventListener("message", (ev: MessageEvent) => {
        let msg: { op: number; d: any };
        try {
          const raw = typeof ev.data === "string" ? ev.data : String(ev.data);
          msg = JSON.parse(raw);
        } catch (err) {
          this.opts.log("failed to parse obs message", err);
          return;
        }

        if (msg.op === ObsOpCode.Hello) {
          this.handleHello(msg.d, ws).catch((err) => {
            this.opts.log("identify failed", err);
            finish(err instanceof Error ? err : new Error(String(err)));
            ws.close();
          });
          return;
        }

        if (msg.op === ObsOpCode.Identified) {
          this._identified = true;
          this.reconnectAttempt = 0;
          this.opts.log("obs identified");
          finish();
          this.replayState().catch((err) =>
            this.opts.log("state replay failed", err),
          );
          return;
        }

        this.dispatch(msg);
      });

      ws.addEventListener("error", (ev: Event) =>
        this.opts.log("obs ws error", ev),
      );

      ws.addEventListener("close", () => {
        const wasIdentified = this._identified;
        this._identified = false;
        this.ws = null;

        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(new Error("obs_disconnected"));
        }
        this.pending.clear();
        for (const p of this.pendingBatch.values()) {
          clearTimeout(p.timer);
          p.reject(new Error("obs_disconnected"));
        }
        this.pendingBatch.clear();

        if (wasIdentified) this.emit(OBS_DISCONNECTED_EVENT, {});

        finish(new Error("obs connection closed before identified"));

        if (!this.closedByUser && !this.opts.disableReconnect)
          this.scheduleReconnect();
      });
    });
  }

  private async handleHello(hello: any, ws: WebSocket): Promise<void> {
    const auth = hello?.authentication as
      | { challenge: string; salt: string }
      | undefined;
    let authentication: string | undefined;
    if (auth) {
      if (!this.opts.password)
        throw new Error(
          "OBS requires authentication but no password was configured",
        );
      authentication = await computeAuth(
        this.opts.password,
        auth.salt,
        auth.challenge,
      );
    }
    ws.send(
      JSON.stringify({
        op: ObsOpCode.Identify,
        d: {
          rpcVersion: RPC_VERSION,
          authentication,
          eventSubscriptions: this.eventSubscriptions,
        },
      }),
    );
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempt),
    );
    this.reconnectAttempt++;
    this.opts.log(
      `obs reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((err) => this.opts.log("reconnect failed", err));
    }, delay);
  }

  private dispatch(msg: { op: number; d: any }): void {
    switch (msg.op) {
      case ObsOpCode.Event: {
        const ev = msg.d as ObsEvent;
        if (!ev || typeof ev.eventType !== "string") return;
        this.emit(ev.eventType, ev.eventData ?? {});
        return;
      }
      case ObsOpCode.RequestResponse: {
        const res = msg.d as ObsRequestResponse;
        const p = this.pending.get(res.requestId);
        if (!p) {
          this.opts.log("orphan requestResponse", res.requestId);
          return;
        }
        clearTimeout(p.timer);
        this.pending.delete(res.requestId);
        p.resolve(res);
        return;
      }
      case ObsOpCode.RequestBatchResponse: {
        const res = msg.d as ObsRequestBatchResponse;
        const p = this.pendingBatch.get(res.requestId);
        if (!p) {
          this.opts.log("orphan batchResponse", res.requestId);
          return;
        }
        clearTimeout(p.timer);
        this.pendingBatch.delete(res.requestId);
        p.resolve(res);
        return;
      }
      default:
        this.opts.log("unhandled obs opcode", msg.op);
    }
  }

  private emit(eventType: string, eventData: Record<string, unknown>): void {
    const set = this.listeners.get(eventType);
    if (!set || set.size === 0) return;
    const event: ObsEvent = { eventType, eventIntent: 0, eventData };
    for (const handler of set) {
      try {
        handler(eventData, event);
      } catch (err) {
        this.opts.log(`event handler for ${eventType} threw`, err);
      }
    }
  }

  private async replayState(): Promise<void> {
    const batch: ObsRequestBatch = {
      requestId: crypto.randomUUID(),
      requests: [
        { requestType: "GetSceneList", requestId: crypto.randomUUID() },
        {
          requestType: "GetCurrentProgramScene",
          requestId: crypto.randomUUID(),
        },
        {
          requestType: "GetCurrentPreviewScene",
          requestId: crypto.randomUUID(),
        },
        { requestType: "GetStreamStatus", requestId: crypto.randomUUID() },
        { requestType: "GetRecordStatus", requestId: crypto.randomUUID() },
      ],
      haltOnFailure: false,
      executionType: 0,
    };

    const res = await this.sendBatch(batch);
    for (const r of res.results) {
      if (!r.requestStatus.result) {
        this.opts.log(`state replay: ${r.requestType} failed`, r.requestStatus);
        continue;
      }
      const ev = mapResponseToEvent(r);
      if (ev) this.emit(ev.eventType, ev.eventData ?? {});
    }
  }
}

async function computeAuth(
  password: string,
  salt: string,
  challenge: string,
): Promise<string> {
  const enc = new TextEncoder();
  const sha256 = async (data: BufferSource): Promise<Uint8Array> =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  const b64 = (bytes: Uint8Array): string => {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  };
  const secretBytes = await sha256(enc.encode(password + salt));
  const secret = b64(secretBytes);
  const authBytes = await sha256(enc.encode(secret + challenge));
  return b64(authBytes);
}

function mapResponseToEvent(r: ObsRequestResponse): ObsEvent | null {
  const d = (r.responseData ?? {}) as Record<string, any>;
  switch (r.requestType) {
    case "GetCurrentProgramScene":
      return {
        eventType: "CurrentProgramSceneChanged",
        eventIntent: EventSubscription.Scenes,
        eventData: { sceneName: d.currentProgramSceneName },
      };
    case "GetCurrentPreviewScene":
      return {
        eventType: "CurrentPreviewSceneChanged",
        eventIntent: EventSubscription.Scenes,
        eventData: { sceneName: d.currentPreviewSceneName },
      };
    case "GetStreamStatus":
      return {
        eventType: "StreamStateChanged",
        eventIntent: EventSubscription.Outputs,
        eventData: { outputActive: d.outputActive, outputState: d.outputState },
      };
    case "GetRecordStatus":
      return {
        eventType: "RecordStateChanged",
        eventIntent: EventSubscription.Outputs,
        eventData: { outputActive: d.outputActive, outputPath: d.outputPath },
      };
    case "GetSceneList":
      return {
        eventType: "SceneListChanged",
        eventIntent: EventSubscription.Scenes,
        eventData: { scenes: d.scenes },
      };
    default:
      return null;
  }
}
```

---

## 8. New WebSocket Methods

All gated on the current device config. Non-applicable methods return `409` per existing convention.

| Method                      | Params                  | Returns                              | Notes                                        |
| --------------------------- | ----------------------- | ------------------------------------ | -------------------------------------------- |
| `modules.list`              | —                       | `[{id, title, enabled, configured}]` | `configured` is a bool. **No secrets.**      |
| `modules.enable`            | `{id}`                  | `{ok}`                               | Start the module service.                    |
| `modules.disable`           | `{id}`                  | `{ok}`                               | Stop the module service.                     |
| `modules.configure`         | `{id, config}`          | `{ok}`                               | Schema-validated. Secrets accepted as input. |
| `dashboards.list`           | —                       | `Dashboard[]`                        | Full objects.                                |
| `dashboards.get`            | `{id}`                  | `Dashboard`                          |                                              |
| `dashboards.create`         | `{name}`                | `Dashboard`                          | Empty items.                                 |
| `dashboards.update`         | `{id, name?, items?}`   | `Dashboard`                          |                                              |
| `dashboards.delete`         | `{id}`                  | `{ok}`                               | Falls back to next / role default if active. |
| `dashboards.setActive`      | `{id}`                  | `{ok}`                               |                                              |
| `obs.request`               | `ObsRequest` (verbatim) | `ObsRequestResponse` (verbatim)      | Gated on `obs-controller.enabled`.           |
| `obs.requestBatch`          | `ObsRequestBatch`       | `ObsRequestBatchResponse`            | Same.                                        |
| `obs.setEventSubscriptions` | `{intents: number}`     | `{ok}`                               | Same.                                        |
| `kick.stats.get`            | —                       | `{viewers, followers, isLive}`       | On-demand refresh.                           |

---

## 9. Frontend Snippets

**`public/ts/device/obs.ts`:**

```ts
export function obsRequest<T = any>(
  requestType: string,
  requestData: Record<string, any> = {},
) {
  return rpc.call("obs.request", {
    requestType,
    requestId: crypto.randomUUID(),
    requestData,
  }) as Promise<{
    requestStatus: { result: boolean; code: number; comment?: string };
    responseData: T;
  }>;
}

export function obsBatch(
  requests: Array<{ requestType: string; requestData?: Record<string, any> }>,
  opts?: { haltOnFailure?: boolean; executionType?: 0 | 1 | 2 },
) {
  return rpc.call("obs.requestBatch", {
    requestId: crypto.randomUUID(),
    requests: requests.map((r) => ({ ...r, requestId: crypto.randomUUID() })),
    haltOnFailure: opts?.haltOnFailure ?? false,
    executionType: opts?.executionType ?? 0,
  });
}
```

**`public/ts/device/store.ts` — event routing:**

```ts
st.obs.on("CurrentProgramSceneChanged", (d) => {
  st.obs.scene = d.sceneName;
});
st.obs.on("StreamStateChanged", (d) => {
  st.obs.streaming = d.outputActive;
});
st.obs.on("ObsDisconnected", () => {
  st.obs.connected = false;
});
```

**`public/ts/device/dashboard.ts` — renderer sketch:**

```ts
export function renderDashboard(dash: Dashboard) {
  const items = dash.items
    .filter((i) => i.visible && st.modules[i.moduleId]?.enabled)
    .sort((a, b) => a.order - b.order);

  return m(
    "div.dashboard-grid",
    items.map((i) => {
      const mod = registry.get(i.moduleId);
      return m(
        "div.dashboard-item",
        {
          class: `width-${i.width}`,
          style: `grid-column: span ${i.width === "full" ? 12 : i.width === "half" ? 6 : 4}`,
        },
        m(mod.component),
      );
    }),
  );
}
```

**`public/ts/app.ts` — dispatch:**

```ts
const dash = activeDashboard(st);
return dash ? renderDashboard(dash) : renderRoleFallback(st.role);
```

`renderRoleFallback` is the **existing** `hasEncoder`/`hasRelay` tree, unchanged. Never delete it.

---

## 10. `kick-stats` and `kick-chat`

### `kick-stats`

- **Backend:** 30 s `setInterval`. Immediate fetch on start. Emits `{type:"event", event:"kick.stats", module:"kick-stats", data:{viewers, followers, isLive, title, startedAt}}`.
- **Libs:** `unified-creator-metrics` (`createKickClient()`) or `kapi-kit` (`getLivestreamStats()`).
- **Frontend card:** current viewers (large), 20-sample sparkline (client-side ring), follower count, live badge. Default width `third`.

### `kick-chat`

- **Backend:** WS listener. Emits `{type:"event", event:"kick.chat", module:"kick-chat", data:{id, user, body, ts}}`. Reconnect with backoff. Dedupe by Kick message ID.
- **Libs:** `@retconned/kick-js` (read-only mode) or `kick-wss`.
- **Frontend card:** virtualized or capped-at-500 list. Autoscroll with pause-on-hover. Default width `third`.

Both modules are **enablable on any device**, regardless of primary role. A `relay` device can also run `kick-chat`.

---

## 11. Verification Checklist

**Backwards compatibility**

- [ ] Device with no `dashboards` renders byte-for-byte identical to pre-change for `encoder` and `relay`.
- [ ] Existing `status` / `srtla.*` events still reach the frontend.

**OBS protocol**

- [ ] Non-`obs-controller` device returns `409` for `obs.request`.
- [ ] `obs.request` → device → OBS → response with **unmodified** `requestStatus.code`.
- [ ] Batch round-trips end-to-end.
- [ ] OBS scene switched externally → `CurrentProgramSceneChanged` reaches browser within one round-trip.
- [ ] OBS killed → browser receives `ObsDisconnected`.
- [ ] OBS restarted → browser receives replay of real-shaped events; UI rebuilds.
- [ ] `setEventSubscriptions` triggers Reidentify and new intents take effect.

**Modules & credentials**

- [ ] `modules.configure` with `obsPassword: "x"` → `modules.list` shows `configured: true`, never the value.
- [ ] Secret absent from `status`, `modules.list`, logs, and browser network tab.
- [ ] Disabling `obs-controller` stops the client and returns `409` for `obs.request`.
- [ ] Enabling `kick-chat` on a `relay` device starts the listener and pushes events.

**Dashboards**

- [ ] Create three dashboards; switching active changes the render.
- [ ] Delete active → falls back to next, then role default.
- [ ] `visible: false` hides without losing `order` / `width`.
- [ ] Layout persists across device reboot.
- [ ] Layout identical for every viewer of the device (scope check — no localStorage overrides).

**Kick**

- [ ] `kick.stats` polls at exactly 30 s; no burst on reconnect.
- [ ] `kick.chat` reconnects automatically; no duplicates after resume.

**Runtime**

- [ ] Every chosen npm lib runs under Bun — no Node shims.
- [ ] No secret leaks via `grep -ri` in logs before merge.

---

## 12. Anti-Patterns (merge blockers)

- **Do not** invent a parallel OBS API (`obs.scene.switch`). The envelope mapping in §4 is the contract.
- **Do not** remap obs-websocket error codes.
- **Do not** make the browser a direct obs-websocket client. All viewers share the device's single connection.
- **Do not** treat `kick-stats` / `kick-chat` as exclusive roles. They are modules, enablable anywhere.
- **Do not** add per-viewer layout overrides (no localStorage, no cookies). Device-scoped is locked.
- **Do not** add drag-and-drop. v1 is ordered list + width class.
- **Do not** add a config knob for the `kick-stats` interval. Hard-coded 30 s.
- **Do not** fork the method dispatcher per module. One `handleRequest()` with a module → handler map.
- **Do not** refactor `obs.html` in place. Migrate its UI into a Mithril card.
- **Do not** delete `renderRoleFallback` in `app.ts`. Un-configured devices depend on it.
- **Do not** log secrets. Redaction is a merge blocker.
- **Do not** change `server.ts` protocol. New events must fan out through existing paths.

---

## 13. Implementation Order

1. **`src/obs-client.ts`** — copy verbatim from §7. Unit-test against a local OBS before touching anything else.
2. **`src/modules.ts`** + `src/modules/obs-controller.ts` — wire the client into a module.
3. **`src/methods.ts`** — add `obs.request`, `obs.requestBatch`, `obs.setEventSubscriptions`, `modules.*`.
4. **`src/state.ts`** — extend config + migration.
5. **`src/push.ts`** — add `module` field; verify fan-out.
6. **Frontend registry + dashboard renderer + `app.ts` fallback.**
7. **`obs-controller` frontend card.**
8. **Dashboard editor (three tabs).**
9. **`kick-stats`** — backend + card.
10. **`kick-chat`** — backend + card.
11. **`dashboards.*` methods.**
12. **Full verification checklist (§11).**

Ship in that order. Do not skip step 1's manual test — protocol bugs surface late and are expensive.

---

## 14. Open Items for the Maintainer

Resolve before coding begins:

1. **Frontend framework lock.** Confirm Mithril is a hard constraint (the repo uses it). If React is permitted anywhere, say so before writing `dashboard.ts` — it changes the grid choice.
2. **Kick write operations.** Is `kick-chat` read-only for v1? Confirm before adding a `token` field, since it implies moderation actions later.
3. **`modules.configure` transport.** Are secrets sent over the existing WebSocket in the clear, or does the device use WSS/TLS? Match whatever the repo already does for other secrets.

Everything else is locked.
