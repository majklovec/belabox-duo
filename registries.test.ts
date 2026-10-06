import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ALL_MODULES } from "./modules/registry.backend";

const EXPECTED_ORDER = [
    "encoder",
    "srtla",
    "modems",
    "obs-controller",
];

/**
 * The frontend registry cannot be imported outside the browser graph (it
 * mounts mithril at module init), so its declaration order is checked from
 * the source: each entry is the single frontend export of its module file.
 */
const FRONTEND_EXPORT_TO_ID: Record<string, string> = {
    encoderModule: "encoder",
    srtlaModule: "srtla",
    modemsModule: "modems",
    obsControllerModule: "obs-controller",
};

const frontendIds = (): string[] => {
    const src = readFileSync(join(import.meta.dir, "modules", "registry.frontend.ts"), "utf8");
    const start = src.indexOf("[", src.indexOf("FRONTEND_MODULES"));
    const block = src.slice(start + 1, src.indexOf("];", start));
    const names = [...block.matchAll(/\b(\w+Module)\b/g)].map((m) => m[1]);
    return names.map((n) => {
        const id = FRONTEND_EXPORT_TO_ID[n];
        expect(id, `unrecognized frontend registry entry ${n}`).toBeTypeOf("string");
        return id;
    });
};

describe("module registries", () => {
    test("backend registry enumerates all four modules in order", () => {
        expect(ALL_MODULES.length).toBe(4);
        expect(ALL_MODULES.map((mod) => mod.id)).toEqual(EXPECTED_ORDER);
    });

    test("registry IDs match element-wise between the two registries", () => {
        expect(frontendIds()).toEqual(ALL_MODULES.map((mod) => mod.id));
    });
});
