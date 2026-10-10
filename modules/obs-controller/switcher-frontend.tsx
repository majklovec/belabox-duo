/* Low-bitrate switcher card: live state-machine status (pushed as
 * lowBitrateSwitcher.state) and the module settings form (modules.configure). */
import m from "mithril";

import type { Status } from "../../public/types";
import {
  actions,
  badge,
  brk,
  button,
  Card,
  type Child,
  checkField,
  definitionList,
  field,
  fieldGroup,
  form as formBox,
  input,
  numberAttrs,
  options,
} from "../../public/ts/components/ui";
import { since } from "../../public/ts/util";
import { t } from "../../public/ts/i18n";
import type { DeviceCard } from "../../public/ts/device/store";
import type {
  SwitcherDeviceOption,
  SwitcherMetricSources,
  SwitcherStatus,
} from "./types";

/** Display label for a source device option. */
const deviceLabel = (d: SwitcherDeviceOption): string => d.hostname ?? d.id;

/**
 * The options of the source selects come from the module's configuration
 * surface (the status's `switcherMetricSources`, provided by the module
 * backend); empty until the first registry query succeeds.
 */
const metricSources = (status: Status): SwitcherMetricSources =>
  status.switcherMetricSources ?? { encoder: [], relay: [] };

/** OBS's live scene names (`GetSceneList`); null until the first fetch succeeds. */
let scenes: string[] | null = null;
let scenesFetching = false;
let scenesNextAt = 0;
const SCENE_REFRESH_MS = 15_000;

/**
 * Fetch the scene list through the module's obs client, re-rendering on
 * arrival. Refreshed every 15 s (also the back-off while OBS is
 * unreachable). A failed fetch simply keeps the last known list.
 */
async function loadScenes(host: DeviceCard): Promise<void> {
  if (scenesFetching || Date.now() < scenesNextAt) return;
  scenesFetching = true;
  try {
    const result = await host.act<{ scenes?: { name: string }[] } | undefined>(
    	null,
    	"obs.request",
    	{ requestType: "GetSceneList", requestId: crypto.randomUUID(), requestData: {} },
    );
    const list = result?.scenes
    	?.map((s) => s.name)
    	.filter((n): n is string => n !== "");
    if (list) scenes = list;
  } catch {
    // device offline / OBS unreachable — keep the last known list
  } finally {
    scenesNextAt = Date.now() + SCENE_REFRESH_MS;
    scenesFetching = false;
    m.redraw();
  }
}

/**
 * The scene select's options: OBS's scenes, keeping the persisted value even
 * if the scene vanished. Optional scene fields get an empty "—" entry.
 */
const sceneOptions = (current: string, optional = false): [string, string][] => {
  const names = scenes ?? [];
  const out: [string, string][] = names.map((n): [string, string] => [n, n]);
  if (current && !out.some(([n]) => n === current)) out.push([current, current]);
  if (optional) out.push(["", "—"]);
  return out;
};

/** Flat form over the persisted config; strings for the numeric inputs. */
interface SwitcherForm {
  autoSwitch: boolean;
  encEnabled: boolean;
  encDeviceId: string;
  relEnabled: boolean;
  relDeviceId: string;
  lowBitrate: string;
  offlineBitrate: string;
  rtt: string;
  retryAttempts: string;
  pollInterval: string;
  instantlyRecover: boolean;
  onlySwitchWhenStreaming: boolean;
  sceneNormal: string;
  sceneLow: string;
  sceneOffline: string;
  sceneStarting: string;
  sceneEnding: string;
  scenePrivacy: string;
  logToFile: boolean;
}

let form: SwitcherForm | undefined;
let live: SwitcherStatus | null = null;

function loadForm(status: Status): SwitcherForm {
  const c = status.modules["obs-controller"].switcher;
  return {
    autoSwitch: c.switcher.bitrateSwitcherEnabled,
    encEnabled: c.sources.encoder.enabled,
    encDeviceId: c.sources.encoder.deviceId,
    relEnabled: c.sources.relay.enabled,
    relDeviceId: c.sources.relay.deviceId,
    lowBitrate: String(c.switcher.triggers.low),
    offlineBitrate: String(c.switcher.triggers.offline),
    rtt: String(c.switcher.triggers.rtt),
    retryAttempts: String(c.switcher.retryAttempts),
    pollInterval: String(c.switcher.pollIntervalMs),
    instantlyRecover: c.switcher.instantlySwitchOnRecover,
    onlySwitchWhenStreaming: c.switcher.onlySwitchWhenStreaming,
    sceneNormal: c.switcher.switchingScenes.normal,
    sceneLow: c.switcher.switchingScenes.low,
    sceneOffline: c.switcher.switchingScenes.offline,
    sceneStarting: c.optionalScenes.starting,
    sceneEnding: c.optionalScenes.ending,
    scenePrivacy: c.optionalScenes.privacy,
    logToFile: c.logToFile,
  };
}

function toConfig(): Record<string, unknown> {
  const f = form!;
  const num = (s: string): number => {
    const v = Number(s);
    return Number.isFinite(v) && v >= 0 ? v : 0;
  };
  return {
    sources: {
      encoder: { enabled: f.encEnabled, deviceId: f.encDeviceId },
      relay: { enabled: f.relEnabled, deviceId: f.relDeviceId },
    },
    switcher: {
      bitrateSwitcherEnabled: f.autoSwitch,
      onlySwitchWhenStreaming: f.onlySwitchWhenStreaming,
      instantlySwitchOnRecover: f.instantlyRecover,
      retryAttempts: Math.max(
        1,
        Math.min(100, Math.floor(Number(f.retryAttempts) || 1)),
      ),
      pollIntervalMs: Math.max(200, Math.floor(Number(f.pollInterval) || 1000)),
      triggers: {
        low: num(f.lowBitrate),
        offline: num(f.offlineBitrate),
        rtt: num(f.rtt),
      },
      switchingScenes: {
        normal: f.sceneNormal,
        low: f.sceneLow,
        offline: f.sceneOffline,
      },
    },
    optionalScenes: {
      starting: f.sceneStarting,
      ending: f.sceneEnding,
      privacy: f.scenePrivacy,
    },
    logToFile: f.logToFile,
  };
}

function save(host: DeviceCard, status: Status): void {
  void host.act("switcher-save", "modules.configure", {
    id: "obs-controller",
    config: { switcher: toConfig() },
  });
}

const stateBadge = (state: SwitcherStatus["state"]): Child =>
  state === "NORMAL"
    ? badge(t("lowbs.state_normal"), "on")
    : state === "LOW"
      ? badge(t("lowbs.state_low"), "warn")
      : badge(t("lowbs.state_offline"), "off");

function switcherCardBody(
  host: DeviceCard,
  status: Status,
  live: SwitcherStatus | null,
): m.Vnode {
  if (form === undefined) form = loadForm(status);
  const f = form;
  const sources = metricSources(status);
  void loadScenes(host);
  const s = live ?? status.lowBitrateSwitcher ?? null;
  const busy = host.busy.has("switcher-save");
  return (
    <Card title={t("lowbs.title")} class={"mod-switcher"}>
      {definitionList([
        [
          t("lowbs.row_state"),
          s ? stateBadge(s.state) : badge(t("lowbs.idle"), "off"),
        ],
        [
          t("lowbs.row_desired"),
          s ? (
            <span>
              {[
                stateBadge(s.desiredState),
                s.desiredState !== s.state && (
                  <span
                    class={"muted"}
                  >{` · ${t("lowbs.row_retries", s.retryCount, f.retryAttempts)}`}</span>
                ),
              ]}
            </span>
          ) : null,
        ],
        [t("lowbs.row_scene"), s?.currentScene ?? null],
        [t("lowbs.row_updated"), s ? since(s.updatedAt) : null],
      ])}
      {formBox(
        { onSubmit: () => save(host, status) },
        checkField(
          t("lowbs.auto_switch"),
          <input
            type={"checkbox"}
            checked={f.autoSwitch}
            onchange={(e: Event) =>
              (f.autoSwitch = (e.target as HTMLInputElement).checked)
            }
          />,
        ),
        fieldGroup(
          t("lowbs.group_sources"),
          checkField(
            t("lowbs.source_encoder"),
            <input
              type={"checkbox"}
              checked={f.encEnabled}
              onchange={(e: Event) =>
                (f.encEnabled = (e.target as HTMLInputElement).checked)
              }
            />,
          ),
          <select
            value={f.encDeviceId}
            disabled={!f.encEnabled}
            class={"lbs-select"}
            onchange={(e: Event) =>
              (f.encDeviceId = (e.target as HTMLSelectElement).value)
            }
          >
            {options(
              sources.encoder.map((d): [string, string] => [
                d.id,
                deviceLabel(d),
              ]),
            )}
          </select>,
          brk(),
          checkField(
            t("lowbs.source_relay"),
            <input
              type={"checkbox"}
              checked={f.relEnabled}
              onchange={(e: Event) =>
                (f.relEnabled = (e.target as HTMLInputElement).checked)
              }
            />,
          ),
          <select
            value={f.relDeviceId}
            disabled={!f.relEnabled}
            class={"lbs-select"}
            onchange={(e: Event) =>
              (f.relDeviceId = (e.target as HTMLSelectElement).value)
            }
          >
            {options(
              sources.relay.map((d): [string, string] => [
                d.id,
                deviceLabel(d),
              ]),
            )}
          </select>,
        ),
        fieldGroup(
          t("lowbs.group_triggers"),
          <div class={"lbs-grid"}>
            {[
              field(
                t("lowbs.trigger_low_bitrate"),
                input(
                  { v: f.lowBitrate } as { v: string },
                  "v",
                  numberAttrs(0, 1e9, "2500"),
                  (v) => (f.lowBitrate = v),
                ),
              ),
              field(
                t("lowbs.trigger_offline_bitrate"),
                input(
                  { v: f.offlineBitrate } as { v: string },
                  "v",
                  numberAttrs(0, 1e9, "500"),
                  (v) => (f.offlineBitrate = v),
                ),
              ),
              field(
                t("lowbs.trigger_rtt"),
                input(
                  { v: f.rtt } as { v: string },
                  "v",
                  numberAttrs(0, 1e6, "300"),
                  (v) => (f.rtt = v),
                ),
              ),
              field(
                t("lowbs.retry_attempts"),
                input(
                  { v: f.retryAttempts } as { v: string },
                  "v",
                  numberAttrs(1, 100, "3"),
                  (v) => (f.retryAttempts = v),
                ),
              ),
              field(
                t("lowbs.poll_interval"),
                input(
                  { v: f.pollInterval } as { v: string },
                  "v",
                  numberAttrs(200, 3600000, "1000"),
                  (v) => (f.pollInterval = v),
                ),
              ),
            ]}
          </div>,
        ),
        fieldGroup(
          t("lowbs.group_scenes"),
          <div class={"lbs-grid"}>
            {[
              field(
                t("lowbs.scene_normal"),
                <select
                  value={f.sceneNormal}
                  class={"lbs-select"}
                  onchange={(e: Event) =>
                    (f.sceneNormal = (
                      e.target as HTMLSelectElement
                    ).value)
                  }
                >
                  {options(sceneOptions(f.sceneNormal))}
                </select>,
              ),
              field(
                t("lowbs.scene_low"),
                <select
                  value={f.sceneLow}
                  class={"lbs-select"}
                  onchange={(e: Event) =>
                    (f.sceneLow = (e.target as HTMLSelectElement).value)
                  }
                >
                  {options(sceneOptions(f.sceneLow))}
                </select>,
              ),
              field(
                t("lowbs.scene_offline"),
                <select
                  value={f.sceneOffline}
                  class={"lbs-select"}
                  onchange={(e: Event) =>
                    (f.sceneOffline = (
                      e.target as HTMLSelectElement
                    ).value)
                  }
                >
                  {options(sceneOptions(f.sceneOffline))}
                </select>,
              ),
              field(
                t("lowbs.scene_starting"),
                <select
                  value={f.sceneStarting}
                  class={"lbs-select"}
                  onchange={(e: Event) =>
                    (f.sceneStarting = (
                      e.target as HTMLSelectElement
                    ).value)
                  }
                >
                  {options(sceneOptions(f.sceneStarting, true))}
                </select>,
              ),
              field(
                t("lowbs.scene_ending"),
                <select
                  value={f.sceneEnding}
                  class={"lbs-select"}
                  onchange={(e: Event) =>
                    (f.sceneEnding = (e.target as HTMLSelectElement).value)
                  }
                >
                  {options(sceneOptions(f.sceneEnding, true))}
                </select>,
              ),
              field(
                t("lowbs.scene_privacy"),
                <select
                  value={f.scenePrivacy}
                  class={"lbs-select"}
                  onchange={(e: Event) =>
                    (f.scenePrivacy = (e.target as HTMLSelectElement).value)
                  }
                >
                  {options(sceneOptions(f.scenePrivacy, true))}
                </select>,
              ),
            ]}
          </div>,
        ),
        brk(),
        checkField(
          t("lowbs.instantly_recover"),
          <input
            type={"checkbox"}
            checked={f.instantlyRecover}
            onchange={(e: Event) =>
              (f.instantlyRecover = (e.target as HTMLInputElement).checked)
            }
          />,
        ),
        checkField(
          t("lowbs.only_streaming"),
          <input
            type={"checkbox"}
            checked={f.onlySwitchWhenStreaming}
            onchange={(e: Event) =>
              (f.onlySwitchWhenStreaming = (
                e.target as HTMLInputElement
              ).checked)
            }
          />,
        ),
        checkField(
          t("lowbs.log_to_file"),
          <input
            type={"checkbox"}
            checked={f.logToFile}
            onchange={(e: Event) =>
              (f.logToFile = (e.target as HTMLInputElement).checked)
            }
          />,
        ),
        brk(),
        actions(button(t("ui.save"), { type: "submit", disabled: busy })),
      )}
    </Card>
  );
}

/**
 * The switcher card, rendered by the obs module below its own card (device
 * page: the global host + the pushed live state; dashboard: the widget's
 * connection host + its switcher state). Returns null when the switcher is
 * not enabled (its toggle then lives in the obs card's head only).
 */
export function switcherCard(
  host: DeviceCard,
  status: Status,
  liveState: SwitcherStatus | null,
): m.Vnode | null {
  if (status.modules["obs-controller"].switcherEnabled !== true) return null;
  return switcherCardBody(host, status, liveState);
}

/** The last pushed switcher live state (the device page's module-scope one). */
export function switcherLive(): SwitcherStatus | null {
  return live;
}

/** Routes the pushed switcher live state (invoked by the obs module). */
export function handleSwitcherEvent(event: string, data: unknown): void {
  if (event === "lowBitrateSwitcher.state") {
    live = (data as SwitcherStatus) ?? null;
    m.redraw();
  }
}
