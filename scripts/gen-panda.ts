// REFACTOR-uipanda.md §2 — single entrypoint for the Panda CSS pipeline.
//
// 1. Bundle the pum preset to .panda-dist (must exist before any panda CLI run).
// 2. Run `panda codegen` (emits the css() runtime + types) and `panda cssgen`
//    (extracts css() calls and writes public/css/panda/styles.css) in one shell.
//    Both artifacts live under the gitignored public/css/panda/, so this is
//    cheap to rerun any time the generated tree is missing or stale.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const baseDir = fileURLToPath(new URL("..", import.meta.url));
// @pandacss/dev 1.x ships the CLI as a local `panda` bin alongside its own
// codegen/cssgen implementations — invoking it directly (not via `bun x`)
// keeps everything on the pinned 1.12.1 set.
const panda = new URL("../node_modules/@pandacss/dev/bin.js", import.meta.url);

// Bundle-first: codegen/cssgen fail late if the preset file is missing.
execFileSync(process.execPath, [fileURLToPath(new URL("./gen-panda-preset.ts", import.meta.url))], { stdio: "inherit", cwd: baseDir });
for (const command of ["codegen", "cssgen"]) {
    execFileSync(process.execPath, [fileURLToPath(panda), command], { stdio: "inherit", cwd: baseDir });
}
