import { describe, expect, test } from "bun:test";
import {
    defaultLowBitrateSwitcherConfig,
    type LowBitrateSwitcherConfig,
} from "../../src/switcher";
import {
    type SwitcherMetrics,
    type SwitcherActiveSources,
} from "./types";
import {
    determineState,
    normalizeSwitcherConfig,
    SwitcherEngine,
    type ObsSnapshot,
    type SwitcherDeps,
} from "./switcher-engine";

const SOURCES: SwitcherActiveSources = { encoder: "encoder", relay: null, combined: null };

interface DepsOpts {
    obs?: ObsSnapshot | null;
    metrics?: SwitcherMetrics | null;
    setSceneOk?: boolean;
}

function makeDeps(opts: DepsOpts = {}): {
    deps: SwitcherDeps;
    scenes: string[];
    logs: [string, string][];
    updated: { count: number };
} {
    const scenes: string[] = [];
    const logs: [string, string][] = [];
    const updated = { count: 0 };
    const deps: SwitcherDeps = {
        obs: () => (opts.obs === undefined ? { connected: true, streaming: true, scene: "LIVE" } : opts.obs),
        setScene: async (scene) => {
            scenes.push(scene);
            return opts.setSceneOk ?? true;
        },
        metrics: async () =>
            opts.metrics === undefined
                ? { bitrateKbps: 5000, rttMs: 50, connected: true, streaming: true }
                : opts.metrics,
        sources: () => SOURCES,
        log: (level, message) => logs.push([level, message]),
        onUpdate: () => {
            updated.count += 1;
        },
        now: () => 1_700_000_000_000,
    };
    return { deps, scenes, logs, updated };
}

/** The defaults with the given switcher-level patch. */
const cfg = (switcherPatch: Partial<LowBitrateSwitcherConfig["switcher"]> = {}): LowBitrateSwitcherConfig => {
    const c = normalizeSwitcherConfig({})!;
    c.switcher = { ...c.switcher, ...switcherPatch };
    return c;
};

/** Run fn with a started (and stopped) engine. */
async function withEngine(
    config: LowBitrateSwitcherConfig,
    deps: SwitcherDeps,
    fn: (engine: SwitcherEngine) => Promise<void>,
): Promise<void> {
    const engine = new SwitcherEngine(config, deps);
    engine.start();
    try {
        await fn(engine);
    } finally {
        engine.stop();
    }
}

const good: SwitcherMetrics = { bitrateKbps: 5000, rttMs: 50, connected: true, streaming: true };
const low: SwitcherMetrics = { bitrateKbps: 450, rttMs: 50, connected: true, streaming: true };
const offline: SwitcherMetrics = { bitrateKbps: 300, rttMs: 50, connected: true, streaming: true };

describe("determineState", () => {
    test("master switch off forces NORMAL", () => {
        expect(determineState(offline, cfg({ bitrateSwitcherEnabled: false }))).toBe("NORMAL");
    });
    test("disconnected source is OFFLINE", () => {
        expect(determineState({ ...good, connected: false }, cfg())).toBe("OFFLINE");
    });
    test("bitrate below the offline trigger is OFFLINE", () => {
        expect(determineState(offline, cfg())).toBe("OFFLINE");
    });
    test("bitrate below the low trigger is LOW", () => {
        expect(determineState(low, cfg())).toBe("LOW");
    });
    test("rtt above its trigger is LOW", () => {
        expect(determineState({ ...good, rttMs: 2000 }, cfg())).toBe("LOW");
    });
    test("good metrics are NORMAL", () => {
        expect(determineState(good, cfg())).toBe("NORMAL");
    });
    test("null metrics fields never trigger an off-state", () => {
        expect(determineState({ bitrateKbps: null, rttMs: null, connected: null, streaming: null }, cfg())).toBe("NORMAL");
    });
});

describe("SwitcherEngine", () => {
    test("switches to LOW after retryAttempts consecutive polls", async () => {
        const { deps, scenes } = makeDeps({ metrics: low });
        await withEngine(cfg({ retryAttempts: 5 }), deps, async (engine) => {
            for (let i = 1; i <= 4; i++) {
                await engine.tick();
                expect(engine.status().state).toBe("NORMAL");
                expect(engine.status().desiredState).toBe("LOW");
                expect(engine.status().retryCount).toBe(i);
            }
            await engine.tick(); // 5th bad poll
            expect(engine.status().state).toBe("LOW");
            expect(scenes).toEqual(["LOW"]);
            // Stable: no further switches, retry counter is down
            await engine.tick();
            expect(engine.status().retryCount).toBe(0);
            expect(scenes).toEqual(["LOW"]);
        });
    });

    test("switch to OFFLINE and back to the normal scene on recovery", async () => {
        const { deps, scenes } = makeDeps({ metrics: offline });
        await withEngine(cfg({ retryAttempts: 2 }), deps, async (engine) => {
            await engine.tick();
            await engine.tick();
            expect(engine.status().state).toBe("OFFLINE");
            expect(scenes).toEqual(["BRB"]);
        });
    });

    test("instantlySwitchOnRecover returns to NORMAL on the first good poll", async () => {
        let current: SwitcherMetrics = low;
        const { deps, scenes } = makeDeps({});
        deps.metrics = async () => current;
        await withEngine(cfg({ retryAttempts: 3, instantlySwitchOnRecover: true }), deps, async (engine) => {
            for (let i = 0; i < 3; i++) await engine.tick();
            expect(engine.status().state).toBe("LOW");
            current = good;
            await engine.tick();
            expect(engine.status().state).toBe("NORMAL");
            expect(scenes).toEqual(["LOW", "LIVE"]);
        });
    });

    test("without instantlySwitchOnRecover recovery also waits for retries", async () => {
        let current: SwitcherMetrics = low;
        const { deps, scenes } = makeDeps({});
        deps.metrics = async () => current;
        await withEngine(cfg({ retryAttempts: 2, instantlySwitchOnRecover: false }), deps, async (engine) => {
                await engine.tick();
                await engine.tick();
                expect(engine.status().state).toBe("LOW");
                current = good;
                await engine.tick();
                expect(engine.status().state).toBe("LOW"); // still retrying
                expect(scenes).toEqual(["LOW"]);
                await engine.tick();
                expect(engine.status().state).toBe("NORMAL");
                expect(scenes).toEqual(["LOW", "LIVE"]);
            });
    });

    test("a switch target change restarts the retry count", async () => {
        let current: SwitcherMetrics = low;
        const { deps, scenes } = makeDeps({});
        deps.metrics = async () => current;
        await withEngine(cfg({ retryAttempts: 3 }), deps, async (engine) => {
            await engine.tick();
            await engine.tick(); // count 2 toward LOW
            expect(engine.status().retryCount).toBe(2);
            current = offline;
            await engine.tick(); // desired flips to OFFLINE
            expect(engine.status().desiredState).toBe("OFFLINE");
            expect(engine.status().retryCount).toBe(1);
            await engine.tick();
            await engine.tick();
            expect(engine.status().state).toBe("OFFLINE");
            expect(scenes).toEqual(["BRB"]);
        });
    });

    test("never switches away from an optional (operator) scene", async () => {
        const { deps, scenes, logs } = makeDeps({ metrics: offline, obs: { connected: true, streaming: true, scene: "STARTING" } });
        await withEngine(cfg({ retryAttempts: 2 }), deps, async (engine) => {
            await engine.tick();
            await engine.tick();
            expect(engine.status().state).toBe("NORMAL");
            expect(engine.status().retryCount).toBe(0);
            expect(scenes).toEqual([]);
            expect(logs.every(([, m]) => !m.includes("switched"))).toBe(true);
        });
    });

    test("never switches from a scene the switcher does not own", async () => {
        const { deps, scenes } = makeDeps({ metrics: offline, obs: { connected: true, streaming: true, scene: "UNKNOWN" } });
        await withEngine(cfg({ retryAttempts: 2 }), deps, async (engine) => {
            await engine.tick();
            await engine.tick();
            expect(engine.status().state).toBe("NORMAL");
            expect(scenes).toEqual([]);
        });
    });

    test("failBehaviour pause: a disconnected OBS pauses the module", async () => {
        const { deps, scenes } = makeDeps({ metrics: offline, obs: { connected: false, streaming: false, scene: "LIVE" } });
        await withEngine(cfg({ retryAttempts: 2 }), deps, async (engine) => {
            await engine.tick();
            await engine.tick();
            expect(engine.status().active).toBe(false);
            expect(engine.status().state).toBe("NORMAL");
            expect(scenes).toEqual([]);
        });
    });

    test("failBehaviour ignore: keeps the state, never touches the scene", async () => {
        const c = cfg({ retryAttempts: 2 });
        c.obsController = { moduleId: "obs-controller", failBehaviour: "ignore" };
        const { deps, scenes, logs } = makeDeps({ metrics: offline, obs: { connected: false, streaming: false, scene: "LIVE" } });
        await withEngine(c, deps, async (engine) => {
            await engine.tick();
            await engine.tick();
            expect(engine.status().state).toBe("NORMAL");
            expect(engine.status().desiredState).toBe("OFFLINE");
            expect(scenes).toEqual([]);
            expect(logs.some(([level]) => level === "warn")).toBe(true);
        });
    });

    test("a missing obs-controller idles the module", async () => {
        const { deps, logs } = makeDeps({ obs: null });
        await withEngine(cfg({ retryAttempts: 2 }), deps, async (engine) => {
            await engine.tick();
            expect(engine.status().active).toBe(false);
            expect(engine.status().obsConnected).toBe(false);
            expect(logs.some(([level, m]) => level === "error" && m.includes("unavailable"))).toBe(true);
        });
    });

    test("onlySwitchWhenStreaming ignores metrics while not streaming", async () => {
        const { deps, scenes } = makeDeps({ metrics: offline, obs: { connected: true, streaming: false, scene: "LIVE" } });
        await withEngine(cfg({ retryAttempts: 2, onlySwitchWhenStreaming: true }), deps, async (engine) => {
            await engine.tick();
            await engine.tick();
            expect(engine.status().state).toBe("NORMAL");
            expect(engine.status().active).toBe(false);
            expect(scenes).toEqual([]);
        });
    });

    test("a failed scene switch keeps counting toward the next attempt", async () => {
        const { deps, scenes } = makeDeps({ metrics: offline, setSceneOk: false });
        await withEngine(cfg({ retryAttempts: 2 }), deps, async (engine) => {
            await engine.tick();
            await engine.tick();
            expect(scenes).toEqual(["BRB"]); // one attempt, it failed
            expect(engine.status().state).toBe("NORMAL");
            // The failed attempt already starts the count: the next poll re-attempts
            await engine.tick();
            expect(scenes).toEqual(["BRB", "BRB"]);
        });
    });

    test("no source available: module idles with a warning", async () => {
        const { deps, logs } = makeDeps({ metrics: null });
        await withEngine(cfg({ retryAttempts: 2 }), deps, async (engine) => {
            await engine.tick();
            expect(engine.status().active).toBe(false);
            expect(logs.some(([level, m]) => level === "warn" && m.includes("no active source"))).toBe(true);
        });
    });

    test("tick reports the status through onUpdate and not when stopped", async () => {
        const { deps, updated } = makeDeps({});
        const engine = new SwitcherEngine(cfg({}), deps);
        await engine.tick();
        expect(updated.count).toBe(0); // not running yet
        engine.start();
        await engine.tick();
        expect(updated.count).toBe(1);
        engine.stop();
        expect(engine.isRunning).toBe(false);
    });

    test("updateConfig applies a new retry count mid-run", async () => {
        let current: SwitcherMetrics = offline;
        const { deps, scenes } = makeDeps({});
        deps.metrics = async () => current;
        await withEngine(cfg({ retryAttempts: 10 }), deps, async (engine) => {
            await engine.tick();
            expect(engine.status().retryCount).toBe(1);
            engine.updateConfig(cfg({ retryAttempts: 1 }));
            await engine.tick();
            expect(engine.status().state).toBe("OFFLINE");
            expect(scenes).toEqual(["BRB"]);
        });
    });
});

describe("normalizeSwitcherConfig", () => {
    test("non-object input is rejected", () => {
        expect(normalizeSwitcherConfig(null)).toBeNull();
        expect(normalizeSwitcherConfig("x")).toBeNull();
        expect(normalizeSwitcherConfig([])).toBeNull();
    });

    test("empty input yields the factory defaults", () => {
        const c = normalizeSwitcherConfig({});
        expect(c).toEqual(defaultLowBitrateSwitcherConfig());
    });

    test("partially valid input merges over the defaults", () => {
        const c = normalizeSwitcherConfig({
            switcher: { triggers: { low: 100, offline: -5, rtt: 4000 }, retryAttempts: "fast" },
        })!;
        expect(c.switcher.triggers.low).toBe(100);
        expect(c.switcher.triggers.offline).toBe(400); // invalid: default kept
        expect(c.switcher.triggers.rtt).toBe(4000);
        expect(c.switcher.retryAttempts).toBe(5); // invalid: default kept
    });
});
