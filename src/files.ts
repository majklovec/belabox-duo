/*
 * Backend file helpers.
 */
import { randomBytes } from "node:crypto";
import { rename, unlink, writeFile } from "node:fs/promises";

/**
 * Replace `path` atomically: write a fresh sibling file, then rename it over the target.
 *
 * Opening an existing file for writing in a sticky world-writable directory such as /tmp fails
 * with EACCES when it belongs to another user (fs.protected_regular), even for root — e.g. files
 * left by an earlier non-root run. Replacing via rename avoids that, and readers reloading on
 * SIGHUP never see a half-written file.
 */
export async function writeFileAtomic(path: string, data: string): Promise<void> {
    const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    try {
        await writeFile(tmp, data, { flag: "wx" });
        await rename(tmp, path);
    } catch (err: unknown) {
        await unlink(tmp).catch(() => {});
        throw err;
    }
}
