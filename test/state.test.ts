import { describe, expect, test } from "bun:test";
import type { SwitcherConfig } from "../public/types";
import {
    type DeviceConfig,
    type ModulesState,
    defaultModules,
    fromConfig,
} from "../src/state";

/**
 * Regression: the crash `TypeError: undefined is not an object (evaluating
 * 'cfg.sources[key]')` at startup — configs written by the always-on switcher
 * seed carried only `{ enabled: true }` until the card form saved, which made
 * the module dereference the missing `sources` on boot.
 */
const SWITCHER = "low-bitrate-switcher";

/** The stored slice type of `ModulesState["low-bitrate-switcher"]`. */
type StoredSlice = { enabled: boolean } & SwitcherConfig;

type SwitcherSlice = {
    enabled?: boolean;
    sources?: { encoder?: { enabled?: boolean; deviceId?: string }; relay?: { enabled?: boolean; deviceId?: string } };
    triggers?: { low?: number; offline?: number; rtt?: number };
    scenes?: { normal?: string; low?: string; offline?: string };
    optionalScenes?: { starting?: string; ending?: string; privacy?: string };
    logToFile?: boolean;
    autoSwitch?: boolean;
    onlySwitchWhenStreaming?: boolean;
    instantlySwitchOnRecover?: boolean;
    failBehaviour?: "pause" | "ignore";
    retryAttempts?: number;
    pollIntervalMs?: number;
};

function expectCompleteSlice(label: string, slice: SwitcherSlice): void {
    expect(slice.enabled, `${label}: enabled`).toBe(true);
    expect(slice.sources, `${label}: sources`).toBeDefined();
    expect(slice.sources?.encoder, `${label}: sources.encoder`).toBeDefined();
    expect(slice.sources?.relay, `${label}: sources.relay`).toBeDefined();
    expect(slice.triggers, `${label}: triggers`).toBeDefined();
    expect(typeof slice.triggers?.low, `${label}: triggers.low`).toBe("number");
    expect(slice.scenes, `${label}: scenes`).toBeDefined();
    expect(slice.optionalScenes, `${label}: optionalScenes`).toBeDefined();
    expect(typeof slice.retryAttempts, `${label}: retryAttempts`).toBe("number");
    expect(typeof slice.pollIntervalMs, `${label}: pollIntervalMs`).toBe("number");
    expect(typeof slice.logToFile, `${label}: logToFile`).toBe("boolean");
    expect(typeof slice.autoSwitch, `${label}: autoSwitch`).toBe("boolean");
}

describe("switcher module slice is never incomplete", () => {
    test("defaultModules seeds a complete slice", () => {
        expectCompleteSlice("default", defaultModules("relay")[SWITCHER] as SwitcherSlice);
    });

    test("a fresh config (no stored modules) gets a complete slice", () => {
        const cfg: Partial<DeviceConfig> = { role: "relay" };
        const st = fromConfig(cfg);
        expectCompleteSlice("fresh", st.settings.modules?.[SWITCHER] as SwitcherSlice);
    });

    test("the crashed shape ({ enabled: true } only) is backfilled", () => {
        // (casts: the point is the stored modules map is incomplete)
        const cfg: Partial<DeviceConfig> = {
            role: "relay",
            modules: { [SWITCHER]: { enabled: true } as StoredSlice } as ModulesState,
        };
        const st = fromConfig(cfg);
        expectCompleteSlice("stale", st.settings.modules?.[SWITCHER] as SwitcherSlice);
    });

    test("stored values win when filling the gaps", () => {
        // (casts: the point is the stored slice is partial)
        const cfg: Partial<DeviceConfig> = {
            role: "relay",
            modules: {
                [SWITCHER]: {
                    enabled: true,
                    pollIntervalMs: 5000,
                    triggers: { rtt: 900 },
                    sources: { relay: { enabled: true, deviceId: "dev-9" } },
                } as StoredSlice,
            } as ModulesState,
        };
        const st = fromConfig(cfg);
        const sw = st.settings.modules?.[SWITCHER] as SwitcherSlice;
        expectCompleteSlice("overrides", sw);
        expect(sw.pollIntervalMs).toBe(5000);
        expect(sw.triggers?.rtt).toBe(900);
        expect(typeof sw.triggers?.low, "low backfilled").toBe("number");
        expect(sw.sources?.relay?.deviceId).toBe("dev-9");
        expect(sw.sources?.relay?.enabled).toBe(true);
        expect(sw.sources?.encoder?.enabled).toBe(false);
    });

    test("a full stored slice is left untouched", () => {
        const full: SwitcherSlice = {
            enabled: true,
            sources: {
                encoder: { enabled: true, deviceId: "enc-1" },
                relay: { enabled: true, deviceId: "rl-1" },
            },
            failBehaviour: "ignore",
            autoSwitch: false,
            onlySwitchWhenStreaming: true,
            instantlySwitchOnRecover: false,
            retryAttempts: 3,
            pollIntervalMs: 750,
            triggers: { low: 200, offline: 100, rtt: 300 },
            scenes: { normal: "A", low: "B", offline: "C" },
            optionalScenes: { starting: "S", ending: "E", privacy: "P" },
            logToFile: false,
        };
        const cfg: Partial<DeviceConfig> = {
            role: "relay",
            modules: { [SWITCHER]: full as StoredSlice } as ModulesState,
        };
        const st = fromConfig(cfg);
        expect(st.settings.modules?.[SWITCHER]).toEqual(full as StoredSlice);
    });
});
