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
