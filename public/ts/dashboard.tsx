/* Shared dashboard parts: the live widget preview is used both by the dashboards
 * management page and by the read-only dashboard view page. The device list is
 * pushed live over the shared feed websocket, and live widget data flows over the
 * control server's per-device viewer websockets (d/<id>/ws). */
import m from "mithril";
import type {
  DeviceInfo,
  DeviceSummary,
  ServerDashboard,
  ServerDashboardWidget,
  GridSize,
  Role,
  Status,
  SrtlaStatsEvent,
  SwitcherStatus,
  WidgetType,
} from "../types";
import { badge, button, widgetTable, type Child } from "./components/ui";
import { configFieldName } from "../types";
import { createCardHost, type DeviceCard } from "./device/store";
/* REFACTOR-modules.md §7: the core names no module by id. Per-device cards
 * (encoder / srtla) are reached through the generated manifest
 * (`deviceCardBody`). The obs panel is the one documented exception: its
 * transport types are module-owned and irreducible to a generic `Panel`
 * signature without the core re-declaring them (§6 "no shared types"). */
import {
  createObsPanel,
  type ObsEvent,
  type ObsPanel,
  type ObsRequestResult,
} from "../../modules/obs-controller/frontend";
import { switcherCard } from "../../modules/low-bitrate-switcher/frontend";
import {
  deviceCardBody,
  dispatchWidgetFrame,
  getFrontendModule,
  widgetModuleForType,
  widgetModuleTypes,
  type WidgetContext,
} from "../../src/registry.frontend";
import { t } from "./i18n";
import { roleTag } from "./icons";
import { RpcClient, socketUrl } from "./services/rpc";
import { serverLive } from "./services/serverws";
import { formatBitrate, uuid } from "./util";

/** Device-independent widget types: their data (the widget's channel, fetched
 * by the control server) is not tied to any device connection. The widget
 * modules declare their own types; the core routes through the registry. */
const INDEPENDENT: ReadonlySet<WidgetType> = new Set<WidgetType>(
  widgetModuleTypes() as WidgetType[],
);
export const isIndependent = (type: WidgetType): boolean =>
  INDEPENDENT.has(type);

/** The parts of an srtla stats push the core's status widget summarizes (the
 * full table is rendered by the srtla module itself). */
interface SrtlaSummary {
  active_links?: number;
  total_links?: number;
  links?: { bitrate_bytes_per_sec?: number }[];
}

/** Live data for one device, accumulated from its viewer websocket (or a 409). */
interface DeviceLive {
  device?: DeviceInfo;
  status?: Status;
  srtla?: SrtlaSummary;
  /** The low-bitrate switcher's live state (pushed as `lowBitrateSwitcher.state`). */
  switcher?: SwitcherStatus | null;
  obsConnected: boolean;
  obsScene?: string;
  obsStreaming: boolean;
  obsRecording: boolean;
}
interface Connection {
  rpc: RpcClient;
  live: DeviceLive;
  /** The module card host: feeds the encoder / relay / combined widgets,
   * which run the same interactive card as the device page. */
  card: DeviceCard;
}

let rpcConn: RpcClient | null = null;

/** One server websocket for the dashboard pages: the live device list,
 * cross-client dashboard sync, and the channel widgets' frames — every frame
 * the core does not own itself is forwarded to the widget modules, which fold
 * the ones they care about into their own per-channel live state. */
function ensureDashboardsConn(): void {
  if (rpcConn) return;
  rpcConn = serverLive.rpc;
  rpcConn.onAny((event, data) => {
    // Cross-client sync: the control server broadcasts `dashboards.changed`
    // here whenever any client saves a dashboard; the owning page rebases.
    if (event === "dashboards.changed") return onDashboardsChanged(data);
    // Live device list: feeds widget titles / badges without HTTP polling.
    if (event === "devices.snapshot" || event === "devices.changed") {
      applyDeviceList(data as DeviceSummary[]);
      return;
    }
    dispatchWidgetFrame(event, data);
    m.redraw();
  });
}

/** Open the dashboards websocket so the page can listen for
 * `dashboards.changed` broadcasts, even when it has no channel widget. */
export function ensureDashboardsWs(): void {
  ensureDashboardsConn();
}

/** A channel widget's normalized channel key ("" when not configured) — the
 * module owns which config parameter carries the channel name. */
export const widgetChannel = (w: ServerDashboardWidget): string =>
  widgetModuleForType(w.type)?.channelOf(w) ?? "";

/** The render context the core hands a widget module: its device's live bag
 * (null for device-independent widgets) plus the device info — the module
 * reads what it composes structurally. */
export const widgetCtx = (w: ServerDashboardWidget): WidgetContext => ({
  deviceLive:
    (connectionFor(effectiveDeviceId(w))?.live ?? null) as Record<
      string,
      unknown
    > | null,
  device: (deviceById(effectiveDeviceId(w)) ??
    null) as Record<string, unknown> | null,
});

// ---------------------------------------------------------------------- devices

export const devices: { list: DeviceSummary[] | null } = { list: null };

// One fetch per navigation; afterwards the feed's devices.changed pushes
// keep the list (and the widgets' titles / badges) live.
export async function refreshDevices(): Promise<void> {
  try {
    const res = await fetch("/api/devices", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    applyDeviceList((await res.json()) as DeviceSummary[]);
  } catch {
    // keep the last known list; connectivity is also visible in the live widgets
  }
}

/** Apply a devices.snapshot / devices.changed push to the shared list. */
function applyDeviceList(list: DeviceSummary[]): void {
  devices.list = list;
  m.redraw();
}

export const deviceById = (deviceId: string): DeviceSummary | undefined =>
  devices.list?.find((d) => d.id === deviceId);

export const deviceLabel = (d: DeviceSummary): string => d.hostname || d.id;

export const typeLabel = (type: WidgetType): string =>
  t(`wtype.${type.replace("-", "_")}`);

/** Widget types a role may place on a dashboard. */
const ROLE_WIDGET_TYPES: Record<Role, WidgetType[]> = {
  relay: ["stats", "relay"],
  encoder: ["encoder"],
  combined: ["combined"],
  obs: ["obs"],
  custom: ["status", "stats", "relay", "encoder", "combined", "obs"],
};

/** Widget types a specific device offers, from its role + enabled modules. */
export function widgetTypesFor(d: DeviceSummary): WidgetType[] {
  const types =
    ROLE_WIDGET_TYPES[d.role ?? "custom"] ?? ROLE_WIDGET_TYPES.custom;
  return types.filter(
    (type) => type !== "obs" || d.modules?.["obs-controller"]?.enabled,
  );
}

/** Widget types that are not tied to a device: always offered; their data
 * (the channel name in the widget config) is fetched by the server. */
export function independentTypes(): WidgetType[] {
  return widgetModuleTypes() as WidgetType[];
}

/** The device a widget's data comes from — its own for device-bound widgets;
 * channel widgets are device-independent and don't open a device connection. */
export function effectiveDeviceId(w: ServerDashboardWidget): string {
  return isIndependent(w.type) ? "" : w.deviceId;
}

// ------------------------------------------------------------------- connections

const connections = new Map<string, Connection>();

/** One viewer websocket per device referenced by the dashboard's widgets. */
export function syncConnectionsFor(dash: ServerDashboard | undefined): void {
  const wanted = new Set(
    (dash?.widgets ?? []).map((w) => effectiveDeviceId(w)),
  );
  for (const [id, conn] of connections) {
    if (!wanted.has(id) || !id) {
      conn.rpc.destroy();
      connections.delete(id);
    }
  }
  for (const id of wanted) {
    if (!id || connections.has(id)) continue;
    const live: DeviceLive = {
      obsConnected: false,
      obsStreaming: false,
      obsRecording: false,
    };
    const rpc = new RpcClient(() =>
      socketUrl(`/d/${encodeURIComponent(id)}/ws`),
    );
    const conn: Connection = { rpc, live, card: createCardHost({ rpc }) };
    connections.set(id, conn);
    rpc.on("device", (data) => {
      const info = data as DeviceInfo;
      if (live.device?.online === false && info.online) conn.card.onReconnect();
      live.device = info;
    });
    rpc.on("status", (data) => {
      live.status = data as Status;
      conn.card.applyStatus(live.status!);
    });
    rpc.on("srtla.stats", (data) => {
      const e = data as SrtlaStatsEvent;
      live.srtla = e.stats ?? undefined;
      conn.card.handleStats(e);
    });
    rpc.on("lowBitrateSwitcher.state", (data) => {
      live.switcher = (data as SwitcherStatus | null) ?? null;
      m.redraw();
    });
    rpc.on("obs.event", (data) => {
      const e = data as {
        eventType: string;
        eventData?: Record<string, unknown>;
      };
      if (e.eventType === "CurrentProgramSceneChanged") {
        live.obsConnected = true;
        live.obsScene = String(
          e.eventData?.outputName ?? e.eventData?.sceneName ?? "",
        );
      } else if (e.eventType === "StreamStateChanged") {
        live.obsConnected = true;
        live.obsStreaming = Boolean(e.eventData?.outputActive);
      } else if (e.eventType === "RecordStateChanged") {
        live.obsConnected = true;
        live.obsRecording = Boolean(e.eventData?.outputActive);
      } else if (e.eventType === "ObsDisconnected") {
        live.obsConnected = false;
        live.obsStreaming = false;
        live.obsRecording = false;
      }
      m.redraw();
    });
    // Warm start: pull last snapshots once the socket is open (a 409 means the
    // module is not enabled there). `call` rejects before the socket is OPEN, so
    // this must run from the "open" event — initial connect and every reconnect.
    rpc.on("open", () => {
      conn.card.onReconnect();
      const kinds = (dash?.widgets ?? []).map((w) => w.type);
      if (kinds.includes("obs")) {
        rpc
          .call("obs.request", { requestType: "GetVersion" })
          .then(() => {
            live.obsConnected = true;
            m.redraw();
          })
          .catch(() => undefined);
      }
      void rpc.call("status").catch(() => undefined);
    });
  }
  if ((dash?.widgets ?? []).some((w) => isIndependent(w.type)))
    ensureDashboardsConn();
}

const connectionFor = (deviceId: string): Connection | undefined =>
  connections.get(deviceId);

// ---------------------------------------------------------------------- widgets

function statusWidget(
  deviceId: string,
  conn: Connection | undefined,
): m.Children {
  const d = deviceById(deviceId);
  if (!d) return <p class={"muted"}>{t("dash.widget_missing")}</p>;
  const rows: [string, Child][] = [
    [t("mgmt.th.role"), d.role ? roleTag(d.role) : "—"],
    [
      t("mgmt.th.status"),
      d.online
        ? badge(t("dev.badge.online"), "on")
        : badge(t("dev.badge.offline"), "off"),
    ],
  ];
  if (d.role !== "encoder" && conn?.live.srtla) {
    const s = conn.live.srtla;
    rows.push([
      t("mgmt.th.links"),
      `${s.active_links ?? 0}/${s.total_links ?? 0}`,
    ]);
    const total = (s.links ?? []).reduce(
      (sum, l) => sum + (l.bitrate_bytes_per_sec ?? 0),
      0,
    );
    if (total) rows.push([t("mgmt.th_bitrate"), formatBitrate(total)]);
  }
  if (d.role !== "relay" && d.encoder) {
    rows.push([
      t("dev.card.encoder"),
      d.encoder.running
        ? badge(d.encoder.config?.pipeline ?? t("dev.badge.streaming"), "on")
        : badge(t("dev.badge.stopped"), "warn"),
    ]);
  }
  return widgetTable(rows);
}

/** Card widgets render the full interactive module card (same as the device page);
 * the wrapper keeps the module's CSS scope. */
function relayWidget(
  deviceId: string,
  conn: Connection | undefined,
): m.Children {
  const status = conn?.card.st.status;
  if (!deviceById(deviceId))
    return <p class={"muted"}>{t("dash.widget_missing")}</p>;
  if (!status)
    return (
      <p class={"muted"}>
        {conn ? t("dash.widget_waiting") : t("dev.badge.offline")}
      </p>
    );
  return (
    <div class={"mod-srtla"}>{deviceCardBody("srtla", conn!.card, status)}</div>
  );
}

function encoderWidget(
  deviceId: string,
  conn: Connection | undefined,
): m.Children {
  const status = conn?.card.st.status;
  if (!deviceById(deviceId))
    return <p class={"muted"}>{t("dash.widget_missing")}</p>;
  if (!status)
    return (
      <p class={"muted"}>
        {conn ? t("dash.widget_waiting") : t("dev.badge.offline")}
      </p>
    );
  return (
    <div class={"mod-encoder"}>
      {deviceCardBody("encoder", conn!.card, status)}
    </div>
  );
}

/** Combined device: encoder card stacked over its SRTLA receiver card. */
function combinedWidget(
  deviceId: string,
  conn: Connection | undefined,
): m.Children {
  const status = conn?.card.st.status;
  if (!deviceById(deviceId))
    return <p class={"muted"}>{t("dash.widget_missing")}</p>;
  if (!status)
    return (
      <p class={"muted"}>
        {conn ? t("dash.widget_waiting") : t("dev.badge.offline")}
      </p>
    );
  return (
    <div class={"mod-combined"}>
      {[
        <div class={"mod-encoder"}>
          {deviceCardBody("encoder", conn!.card, status)}
        </div>,
        <div class={"mod-srtla"}>
          {deviceCardBody("srtla", conn!.card, status)}
        </div>,
      ]}
    </div>
  );
}

/** One panel instance per obs widget (its own timers, VU canvas, pending guards). */
const obsPanels = new Map<string, { panel: ObsPanel; conn: Connection }>();

/** Get or create the widget's obs panel. The panel caches `conn.rpc`; if
 * syncConnectionsFor replaced the device's connection (dashboard edited,
 * device swapped), rebind to the live one. */
function obsPanelFor(w: ServerDashboardWidget, conn: Connection): ObsPanel {
  const entry = obsPanels.get(w.id);
  if (entry && entry.conn !== conn) {
    entry.panel.destroy();
    obsPanels.delete(w.id);
  }
  let panel = obsPanels.get(w.id)?.panel;
  if (!panel) {
    panel = createObsPanel({
      send: <T = Record<string, unknown>,>(
        type: string,
        data?: Record<string, unknown>,
      ) =>
        conn.rpc.call<ObsRequestResult<T> | undefined>("obs.request", {
          requestType: type,
          requestId: uuid(),
          requestData: data ?? {},
        }),
      onEvent: (h) => conn.rpc.on("obs.event", (data) => h(data as ObsEvent)),
      mirror: (s) => {
        conn.live.obsConnected = s.connected;
        conn.live.obsStreaming = s.streaming;
        conn.live.obsRecording = s.recording;
        if (s.scene) conn.live.obsScene = s.scene;
      },
      startConnected: () => conn.live.obsConnected,
      onDestroy: () => obsPanels.delete(w.id),
    });
    obsPanels.set(w.id, { panel, conn });
  }
  return panel;
}

/** The full control panel (preview, scenes, output actions, VU meter) plus the low-bitrate switcher card. */
function obsWidget(
  w: ServerDashboardWidget,
  conn: Connection | undefined,
): m.Children {
  const d = deviceById(w.deviceId);
  if (!conn || !d?.online)
    return <p class={"muted"}>{t("dev.badge.offline")}</p>;
  const status = conn.card.st.status;
  // The dashboard widget card is shared by all widget types, so scope the module CSS
  // with the same .mod-obs-controller class the device page's card root gets. The
  // switcher card renders under the panel while enabled on that device.
  const switcherOn = status?.modules["low-bitrate-switcher"]?.enabled === true;
  return (
    <div class={"mod-obs-controller"}>
      {[
        obsPanelFor(w, conn).component(),
        status && switcherOn
          ? switcherCard(conn.card, status, conn.live.switcher ?? null)
          : null,
      ]}
    </div>
  );
}

/** The status badge shown next to the widget title in the card head. Widget
 * module types (stats / kick-stats / the chats) render their own badge; the
 * core keeps only the device-card and status badge logic. */
function widgetBadge(w: ServerDashboardWidget): m.Vnode {
  switch (w.type) {
    case "relay": {
      const st = connectionFor(effectiveDeviceId(w))?.live.status?.state;
      const offline = !st;
      return badge(
        offline ? t("dev.badge.offline") : t("dev.badge.online"),
        offline ? "off" : "on",
      );
    }
    case "combined":
    case "encoder": {
      const deviceId = effectiveDeviceId(w);
      const conn = connectionFor(deviceId);
      const e =
        deviceById(deviceId)?.encoder ?? conn?.live.status?.state?.encoder;
      if (!e)
        return badge(
          conn ? t("dash.widget_waiting") : t("dev.badge.offline"),
          conn ? "" : "off",
        );
      return badge(
        e.running ? t("dev.badge.online") : t("dev.badge.stopped"),
        e.running ? "on" : "warn",
      );
    }
    case "obs": {
      const d = deviceById(w.deviceId);
      const conn = connectionFor(effectiveDeviceId(w));
      if (!conn || !d?.online) return badge(t("dev.badge.offline"), "off");
      // p.head() is [connected/offline badge, refresh button]; the refresh stays in the panel.
      return obsPanelFor(w, conn).head()[0];
    }
    default: {
      const mod = widgetModuleForType(w.type);
      if (mod) return mod.badge(w, widgetCtx(w)) as m.Vnode;
      const d = deviceById(effectiveDeviceId(w));
      if (!d) return badge(t("dash.widget_missing"), "warn");
      return badge(
        d.online ? t("dev.badge.online") : t("dev.badge.offline"),
        d.online ? "on" : "off",
      );
    }
  }
}

/** Per-widget state of the inline config editor (pencil icon). The field
 * names are the widget module's `configFields`; the core keeps them opaque. */
interface WidgetConfigState {
  editing: boolean;
  values: Record<string, string>;
}
const widgetConfigState = new Map<string, WidgetConfigState>();

/** Registered by the page rendering the dashboard; persists the in-place
 * widget mutation (PUT the dashboard) when the inline editor saves. */
let widgetConfigSaver: ((w: ServerDashboardWidget) => void) | null = null;
export function setWidgetConfigSaver(
  fn: ((w: ServerDashboardWidget) => void) | null,
): void {
  widgetConfigSaver = fn;
}

/** Registered by the page owning the grid; called when the server broadcasts
 * a `dashboards.changed` event (this dashboard was saved elsewhere). */
let dashboardChangedSink:
  | ((
      data: {
        id: string;
        widgets: ServerDashboardWidget[];
        version: number;
      } | null,
    ) => void)
  | null = null;
export function setDashboardChangedSink(
  fn:
    | ((
        data: {
          id: string;
          widgets: ServerDashboardWidget[];
          version: number;
        } | null,
      ) => void)
    | null,
): void {
  dashboardChangedSink = fn;
}
export function onDashboardsChanged(data: unknown): void {
  dashboardChangedSink?.(
    data as {
      id: string;
      widgets: ServerDashboardWidget[];
      version: number;
    } | null,
  );
}

/** The inline editor that opens from the pencil icon on a configurable widget.
 * One field per parameter in the widget module's `configFields` (labels and
 * placeholders come from `dash.widget_<name>` i18n keys). */
function configEditorForm(w: ServerDashboardWidget): m.Vnode {
  const fields = widgetModuleForType(w.type)?.configFields ?? [];
  const key = widgetKey(w);
  const s = widgetConfigState.get(key) ?? {
    editing: true,
    values: { ...(w.config ?? {}) },
  };
  return (
    <div class={"dash-config-form"}>
      {[
        ...fields.map((field) => {
          const name = configFieldName(field);
          const isSelect = typeof field !== "string" && field.type === "select";
          return (
            <label key={name}>
              {[
                <span>{t(`dash.widget_${name}`)}</span>,
                isSelect ? (
                  <select
                    class={"dash-config-input"}
                    value={s.values[name] ?? (field.type === "select" ? field.options[0] : "")}
                    onchange={(e: Event) => {
                      s.values[name] = (e.target as HTMLSelectElement).value;
                    }}
                  >
                    {field.type === "select"
                      ? field.options.map((opt) =>
                          <option key={opt} value={opt}>
                            {t(`dash.widget_${name}.${opt}`)}
                          </option>,
                        )
                      : []}
                  </select>
                ) : (
                  <input
                    class={"dash-config-input"}
                    value={s.values[name] ?? ""}
                    placeholder={t(`dash.widget_${name}`)}
                    oninput={(e: Event) => {
                      s.values[name] = (e.target as HTMLInputElement).value;
                    }}
                  />
                ),
              ]}
            </label>
          );
        }),
        <div class={"dash-config-actions"} key={"actions"}>
          {[
            button(t("ui.save"), {
              onclick: (e: Event) => {
                e.preventDefault();
                w.config = Object.fromEntries(
                  fields.map((field) => {
                    const nm = configFieldName(field);
                    let v = (s.values[nm] ?? "").trim();
                    if (typeof field !== "string" && field.type === "select" && v === "") {
                      v = field.options[0] ?? "";
                    }
                    return [nm, v];
                  }),
                );
                widgetConfigState.delete(key);
                widgetConfigSaver?.(w);
                m.redraw();
              },
            }),
            button(t("ui.cancel"), {
              onclick: () => {
                widgetConfigState.delete(widgetKey(w));
                m.redraw();
              },
            }),
          ]}
        </div>,
      ]}
    </div>
  );
}

const widgetKey = (w: ServerDashboardWidget): string =>
  w.id || `${w.type}:${w.name}`;

/** Channel widgets are device-independent: the server fetches the widget's
 * channel and pushes the data over the dashboard websocket. */
/** Card title: "device · type" for device widgets, just "type" for the channel ones. */
export function widgetTitle(w: ServerDashboardWidget): string {
  const d = deviceById(w.deviceId);
  const prefix = isIndependent(w.type) || !d ? "" : `${deviceLabel(d)} · `;
  return prefix + t(`wtype.${w.type.replace("-", "_")}`);
}

/** The app build a device reports in its hello, shown next to the title so a box
 * stuck on an old build (no `pipelines.list`, no stats pushes) is visible here
 * instead of as a silently empty widget. */
function widgetVersion(w: ServerDashboardWidget): m.Vnode | null {
  if (isIndependent(w.type)) return null;
  const d = deviceById(w.deviceId);
  const version = connectionFor(w.deviceId)?.live.device?.version ?? d?.version;
  if (version)
    return (
      <span class={"dash-widget-version"} title={version}>
        {version}
      </span>
    );
  // A device that answers (hello without a version field) runs a pre-version
  // build: its widget data (pipelines, stats) simply does not exist yet there.
  return d?.online ? (
    <span class={"dash-widget-version stale"} title={t("dash.version_stale")}>
      {"old app"}
    </span>
  ) : null;
}

/** Live body for a widget, given its device connection. Widget module types
 * render their own body; the core keeps only the device-card and status ones. */
function bodyFor(w: ServerDashboardWidget): m.Children {
  const deviceId = effectiveDeviceId(w);
  const conn = connectionFor(deviceId);
  switch (w.type) {
    case "relay":
      return relayWidget(deviceId, conn);
    case "encoder":
      return encoderWidget(deviceId, conn);
    case "combined":
      return combinedWidget(deviceId, conn);
    case "obs":
      return obsWidget(w, conn);
    default: {
      const mod = widgetModuleForType(w.type);
      if (mod) return mod.body(w, widgetCtx(w)) as m.Children;
      return statusWidget(deviceId, conn);
    }
  }
}

/** Device-card widget types (the ones whose body embeds a module's
 * device-card) → the frontend module that defines their grid size. Widget
 * module types declare their own sizes in the module; everything else falls
 * back to the core default. */
const CARD_MODULE: Record<string, string> = {
  obs: "obs-controller",
  encoder: "encoder",
  relay: "srtla",
};

/** Default/min/max `{w, h}` for a widget type — the module's own grid
 * contract, used when adding a widget or constraining a resize. */
export function widgetSize(type: WidgetType): {
  default: GridSize;
  min: GridSize;
  max?: GridSize;
} {
  const wm = widgetModuleForType(type);
  if (wm) return { default: wm.defaultSize, min: wm.defaultSize };
  const mod = CARD_MODULE[type] ? getFrontendModule(CARD_MODULE[type]) : undefined;
  if (mod)
    return { default: mod.defaultSize, min: mod.minSize, max: mod.maxSize };
  if (type === "combined")
    return { default: { w: 6, h: 10 }, min: { w: 4, h: 8 } };
  return { default: { w: 4, h: 4 }, min: { w: 3, h: 3 } };
}

export interface WidgetActions {
  remove: (w: ServerDashboardWidget) => void;
  hide: (w: ServerDashboardWidget) => void;
}

/** The live grid content for one widget: a slim persistent header (title, and
 * in edit mode a drag grip plus remove/hide/config actions) above the live body.
 * GridStack owns the surrounding `.grid-stack-item`; this is what fills it. */
export function widgetInner(
  w: ServerDashboardWidget,
  editMode: boolean,
  actions: WidgetActions,
): m.Vnode {
  const key = widgetKey(w);
  const independent = isIndependent(w.type);
  const editing =
    independent && editMode && (widgetConfigState.get(key)?.editing ?? false);
  return (
    <div
      key={key}
      class={["dash-widget", editing ? "is-editing" : undefined]
        .filter(Boolean)
        .join(" ")}
    >
      {[
        <div class={"dash-widget-head"}>
          {[
            <span class={"dash-grip"}>
              {[
                editMode ? <span class={"dash-grip-icon"}>{"⠿"}</span> : null,
                <span class={"dash-widget-title"}>{widgetTitle(w)}</span>,
                // The status badge sits right next to the title (hidden while the config form is open).
                editing
                  ? null
                  : [
                      widgetVersion(w),
                      <span class={"dash-widget-badge"}>{widgetBadge(w)}</span>,
                    ],
              ]}
            </span>,
            editMode ? (
              <span class={"dash-widget-actions"}>
                {[
                  independent ? (
                    <button
                      class={"icon-btn dash-widget-config"}
                      title={t("dash.widget_settings")}
                      aria-label={t("dash.widget_settings")}
                      onclick={(e: Event) => {
                        e.stopPropagation();
                        const s = widgetConfigState.get(key) ?? {
                          editing: false,
                          values: { ...(w.config ?? {}) },
                        };
                        s.editing = !s.editing;
                        widgetConfigState.set(key, s);
                        m.redraw();
                      }}
                    >
                      {editing ? "✓" : "⚙"}
                    </button>
                  ) : null,
                  <button
                    class={"icon-btn dash-widget-remove"}
                    title={t("dash.remove")}
                    aria-label={t("dash.remove")}
                    onclick={(e: Event) => {
                      e.stopPropagation();
                      actions.remove(w);
                    }}
                  >
                    {"×"}
                  </button>,
                ]}
              </span>
            ) : null,
          ]}
        </div>,
        <div class={"dash-widget-body"}>
          {editing ? configEditorForm(w) : bodyFor(w)}
        </div>,
      ]}
    </div>
  );
}
