/*
 * Build stamp of the deployed device app. The control server echoes it back to
 * the UI, so a box still running an old build (without newer RPCs like
 * `pipelines.list` or stats pushes) is visible at a glance instead of
 * showing empty widgets. Non-git checkouts report "dev".
 */
import { execSync } from "node:child_process";

export const APP_VERSION = (() => {
	try {
		return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"], timeout: 2000 })
			.toString()
			.trim();
	} catch {
		return "dev";
	}
})();
