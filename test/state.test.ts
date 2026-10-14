import { describe, expect, test } from "bun:test";
import type { SwitcherConfig } from "../public/types";
import {
    type DeviceConfig,
    type ModulesState,
    defaultModules,
    fromConfig,
} from "../src/state";

/**
 * Regression for the switcher merge: pre-merge configs stored the switcher
 * under a top-level `modules["low-bitrate-switcher"]` slice (or the older
 * camelCase `lowBitrateSwitcher` key). The switcher now rides on the OBS
 * module, so `fromConfig` folds the legacy slice into
 * `modules["obs-controller"]` (its `enabled` becoming `switcherEnabled`),
 * filling missing fields with the defaults. The obs slice must always end up
 * with a complete switcher set.
 */
const OBS = "obs-controller";
const LEGACY = "low-bitrate-switcher";

/** The switcher fields as they now live on the obs module slice (plus the obs
 * url, which the migration test inspects to prove the obs fields survive). */
type ObsSwitcherFields = SwitcherConfig & { switcherEnabled?: boolean; obsUrl?: string };

function expectCompleteObsSwitcher(label: string, obs: ObsSwitcherFields): void {
    expect(typeof obs.obsSourceName, `${label}: obsSourceName`).toBe("string");
    expect(typeof obs.failBehaviour, `${label}: failBehaviour`).toBe("string");
    expect(obs.triggers, `${label}: triggers`).toBeDefined();
    expect(typeof obs.triggers?.low, `${label}: triggers.low`).toBe("number");
    expect(obs.scenes, `${label}: scenes`).toBeDefined();
    expect(obs.optionalScenes, `${label}: optionalScenes`).toBeDefined();
    expect(typeof obs.retryAttempts, `${label}: retryAttempts`).toBe("number");
    expect(typeof obs.pollIntervalMs, `${label}: pollIntervalMs`).toBe("number");
    expect(typeof obs.logToFile, `${label}: logToFile`).toBe("boolean");
    expect(typeof obs.autoSwitch, `${label}: autoSwitch`).toBe("boolean");
}

describe("switcher fields fold into the obs module slice", () => {
    test("defaultModules seeds a complete obs switcher slice", () => {
        expectCompleteObsSwitcher("default", defaultModules("relay")[OBS] as ObsSwitcherFields);
    });

    test("a fresh config (no stored modules) gets a complete obs switcher slice", () => {
        const cfg: Partial<DeviceConfig> = { role: "relay" };
        const st = fromConfig(cfg);
        expectCompleteObsSwitcher("fresh", st.settings.modules?.[OBS] as ObsSwitcherFields);
    });

    test("a legacy low-bitrate-switcher slice migrates into the obs slice", () => {
        // (cast: the point is the stored modules map is a pre-merge shape)
        const cfg: Partial<DeviceConfig> = {
            role: "relay",
            modules: { [LEGACY]: { enabled: true } } as unknown as ModulesState,
        };
        const st = fromConfig(cfg);
        const obs = st.settings.modules?.[OBS] as ObsSwitcherFields;
        expectCompleteObsSwitcher("migrated", obs);
        expect(obs.switcherEnabled, "migrated: switcherEnabled").toBe(true);
        expect(
            st.settings.modules as unknown as Record<string, unknown>,
            "migrated: no legacy slice",
        ).not.toHaveProperty(LEGACY);
    });

    test("the crashed shape ({ enabled: true } only) migrates complete", () => {
        const cfg: Partial<DeviceConfig> = {
            role: "relay",
            modules: { [LEGACY]: { enabled: true } } as unknown as ModulesState,
        };
        const st = fromConfig(cfg);
        expectCompleteObsSwitcher("stale", st.settings.modules?.[OBS] as ObsSwitcherFields);
    });

    test("stored legacy values win when filling the obs gaps", () => {
        const cfg: Partial<DeviceConfig> = {
            role: "relay",
            modules: {
                [LEGACY]: {
                    enabled: true,
                    pollIntervalMs: 5000,
                    triggers: { rtt: 900 },
                    obsSourceName: "SRTLA-1",
                },
            } as unknown as ModulesState,
        };
        const st = fromConfig(cfg);
        const obs = st.settings.modules?.[OBS] as ObsSwitcherFields;
        expectCompleteObsSwitcher("overrides", obs);
        expect(obs.pollIntervalMs).toBe(5000);
        expect(obs.triggers?.rtt).toBe(900);
        expect(typeof obs.triggers?.low, "low backfilled").toBe("number");
        expect(obs.obsSourceName).toBe("SRTLA-1");
    });

    test("an obs slice without switcher fields absorbs a legacy switcher slice", () => {
        const cfg: Partial<DeviceConfig> = {
            role: "relay",
            modules: {
                [OBS]: {
                    enabled: true,
                    obsUrl: "ws://1.2.3.4:4455",
                    obsPassword: "pw",
                    sceneEvents: true,
                },
                [LEGACY]: {
                    enabled: false,
                    pollIntervalMs: 5000,
                    obsSourceName: "SRTLA-1",
                },
            } as unknown as ModulesState,
        };
        const st = fromConfig(cfg);
        const obs = st.settings.modules?.[OBS] as ObsSwitcherFields;
        expect(obs.obsUrl, "keeps obs url").toBe("ws://1.2.3.4:4455");
        expect(obs.obsSourceName, "legacy value fills the gap").toBe("SRTLA-1");
        expect(obs.pollIntervalMs, "legacy value fills the gap").toBe(5000);
        expect(obs.switcherEnabled, "legacy enabled=false -> switcherEnabled false").toBe(false);
    });
});
