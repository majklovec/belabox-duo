/*
 * ModemManager integration (mmcli): enumeration, per-modem details,
 * network interface lookup, AT passthrough and control actions.
 */
import { run } from "./exec";

export interface ModemInfo {
    index: number;
    path: string;
    state: string;
    powerState: string;
    signalQuality?: number;
    accessTech?: string;
    operatorName?: string;
    registrationState?: string;
    model?: string;
    manufacturer?: string;
    imei?: string;
    primaryPort?: string;
    deviceId?: string;
    simPath?: string;
}

function parseModemList(output: string): Array<{ index: number; path: string; label: string }> {
    const result: Array<{ index: number; path: string; label: string }> = [];
    for (const line of output.split("\n")) {
        const m = line.match(/Modem\/(\d+)\s+(.*)$/);
        if (!m) continue;
        const idx = parseInt(m[1], 10);
        result.push({
            index: idx,
            path: `/org/freedesktop/ModemManager1/Modem/${idx}`,
            label: m[2].trim(),
        });
    }
    return result;
}

export async function detectModems(): Promise<ModemInfo[]> {
    const out = await run("mmcli", ["-L"], true);
    if (!out) return [];
    const list = parseModemList(out);
    const modems: ModemInfo[] = [];

    for (const { index, path, label } of list) {
        const detail = await run("mmcli", ["-m", String(index)], true);
        const info: ModemInfo = { index, path, state: "unknown", powerState: "unknown", model: label };
        const grab = (re: RegExp): string | undefined => {
            const m = detail.match(re);
            return m ? m[1].trim() : undefined;
        };
        info.state             = grab(/^\s*state:\s*(.+)$/m) ?? "unknown";
        info.powerState        = grab(/^\s*power state:\s*(.+)$/m) ?? "unknown";
        info.model             = grab(/^\s*model:\s*(.+)$/m) ?? info.model;
        info.manufacturer      = grab(/^\s*manufacturer:\s*(.+)$/m);
        info.imei              = grab(/^\s*imei:\s*(.+)$/m);
        info.primaryPort       = grab(/^\s*primary port:\s*(.+)$/m);
        info.deviceId          = grab(/^\s*device id:\s*(.+)$/m);
        info.simPath           = grab(/^\s*sim:\s*(.+)$/m);
        info.operatorName      = grab(/^\s*operator name:\s*(.+)$/m);
        info.registrationState = grab(/^\s*registration:\s*(.+)$/m);
        const signalStr = grab(/^\s*signal quality:\s*(.+)$/m);
        if (signalStr) {
            const m = signalStr.match(/(\d+)/);
            if (m) info.signalQuality = parseInt(m[1], 10);
        }
        const techStr = grab(/^\s*access tech:\s*(.+)$/m);
        if (techStr) info.accessTech = techStr;
        modems.push(info);
    }
    return modems;
}

export async function modemNetworkIface(modem: ModemInfo): Promise<string | null> {
    const bearers = await run("mmcli", ["-m", String(modem.index), "-b"], true);
    if (bearers) {
        for (const line of bearers.split("\n")) {
            const m = line.match(/Bearer\/(\d+)/);
            if (!m) continue;
            const bDetail = await run("mmcli", ["-b", m[1]], true);
            const ifMatch = bDetail.match(/interface:\s*(\S+)/);
            if (ifMatch) return ifMatch[1];
        }
    }
    const candidates = await run("ip", ["-o", "-4", "addr", "show"], true);
    const wwan = candidates.match(/wwan\d+/g);
    if (wwan && wwan.length > 0) {
        const match = wwan.find((n) => n === `wwan${modem.index}`);
        return match ?? wwan[0];
    }
    return null;
}

export const sendAtCommand = (idx: number, cmd: string) =>
    run("mmcli", ["-m", String(idx), `--command=${cmd}`], true);

export const setModemEnabled = async (idx: number, enabled: boolean) => {
    await run("mmcli", ["-m", String(idx), enabled ? "-e" : "-d"], true);
    return true;
};

export async function resetModem(idx: number): Promise<boolean> {
    const out = await run("mmcli", ["-m", String(idx), "--reset"], true);
    if (out) return true;
    await setModemEnabled(idx, false);
    await Bun.sleep(2000);
    await setModemEnabled(idx, true);
    return true;
}

export const connectModem    = async (idx: number) =>
    (await run("mmcli", ["-m", String(idx), "--simple-connect=apn=internet"], true)).length > 0;

export const disconnectModem = async (idx: number) =>
    (await run("mmcli", ["-m", String(idx), "--simple-disconnect"], true)).length > 0;
