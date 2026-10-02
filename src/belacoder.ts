/*
 * belacoder (https://github.com/BELABOX/belacoder): bitrate control through a
 * file holding the min and max bitrate in bit/s, one per line (-b).
 */
import { BITRATE_FILE } from "./config";
import { Encoder } from "./encoder";

export class Belacoder extends Encoder {
    protected bitrateArgs(): string[] {
        return ["-b", BITRATE_FILE];
    }

    protected writeBitrateControl(minKbps: number, maxKbps: number): Promise<void> {
        const text = `${minKbps * 1000}\n${maxKbps * 1000}\n`;
        return this.writeControlFile(BITRATE_FILE, text, ` ${text.replace(/\n/g, " ")}`);
    }
}
