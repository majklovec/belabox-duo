/* Pre-bundle `panda-ui-mithril/preset` to plain JS.
 *
 * Panda's config loader refuses to strip types from files inside node_modules,
 * and the pum package ships the preset as TS, so we bundle it once locally and
 * import that from panda.config.ts. Run before `bunx panda` (predev/prepare).
 */
import { join } from "node:path";
import { build } from "bun";

const result = await build({
	entrypoints: [join(import.meta.dir, "../node_modules/panda-ui-mithril/src/preset.ts")],
	outdir: join(import.meta.dir, "../.panda-dist"),
	target: "browser",
	format: "esm",
	external: ["@pandacss/dev"],
	naming: "pum-preset.js",
});

if (!result.success) {
	console.error("Failed to bundle pum preset");
	process.exit(1);
}
console.log("pum preset bundled → .panda-dist/pum-preset.js");
