/*
 * Belacoder-specific encoder pieces: the bitrate control file and process
 * start. The common pipeline handling and process supervision live in
 * encoder.ts; ceracoder's config-based bitrate control lives in
 * encoder_ceracoder.ts.
 */
import { BITRATE_FILE, DRY_RUN, ENCODER_BIN } from "./config";
import { state } from "./state";
import { type EncoderConfig, pumpStderr } from "./encoder";

/** belacoder's bitrate control file: min and max bitrate in bit/s, one per line. */
export async function writeBitrateFile(minKbps: number, maxKbps: number): Promise<void> {
	const content = `${minKbps * 1000}\n${maxKbps * 1000}\n`;
	if (DRY_RUN) {
		console.log(`[DRY-RUN] write ${BITRATE_FILE}: ${content.replace(/\n/g, " ")}`);
		return;
	}
	await Bun.write(BITRATE_FILE, content);
}

export function spawnBelacoder(cfg: EncoderConfig, pipelineFile: string): Bun.Subprocess {
	const args = [
		pipelineFile,
		cfg.host,
		cfg.port,
		"-d", String(cfg.delay),
		"-b", BITRATE_FILE,
		"-l", String(cfg.latency),
	];
	if (cfg.streamid) args.push("-s", cfg.streamid);
	console.log(`Starting ${ENCODER_BIN} ${args.join(" ")}`);

	const p = Bun.spawn([ENCODER_BIN, ...args], { stdin: "ignore", stdout: "inherit", stderr: "pipe" });
	state.encoder.pid = p.pid;

	// Surface the noisy stderr in the console and keep the last problem line for the UI.
	void pumpStderr(p.stderr).catch(() => {});
	return p;
}
