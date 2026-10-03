import m from "mithril";
import { encoderCard } from "./device/encoder";
import { srtlaCard } from "./device/srtla";
import { st } from "./device/store";
const mk = (role: string, cera: boolean): any => ({
	role, state: { encoder: { running: false, config: null }, srtla: { running: true, startedAt: Date.now() - 60000, reloadCount: 1 }, srtlaOptions: {} },
	audioSources: [{ id: "default", name: "Default" }], monitor: { running: true, reloadMode: "signal" },
	srtlaControl: { connected: true }, ceracoder: cera ? { minBitrate: 300 } : null,
});
st.pipelines = [{ id: "p1", name: "h264 1080p", group: "test", asrc: true, acodec: true, overlay: true } as any];
import { fields } from "./device/store";
fields.pipeline = "p1";
m.mount(document.getElementById("app")!, { view: () => [encoderCard(mk("encoder", true)), srtlaCard(mk("relay", false)), encoderCard(mk("combined", false)), srtlaCard(mk("combined", false))] });
