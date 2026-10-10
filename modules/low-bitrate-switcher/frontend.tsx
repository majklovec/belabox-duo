/* Low-bitrate switcher module — the device page card (live state from its own
 * status, settings form saving via lowBitrateSwitcher.save). */
import "./styles.css";
import type { Status } from "../../public/types";
import { card } from "../../public/ts/device/store";
import { handleSwitcherEvent, switcherCard, switcherLive } from "./switcher-frontend";
import type { BridgedModule } from "./types";

export { switcherCard } from "./switcher-frontend";

const lowBitrateSwitcherModule: BridgedModule = {
	id: "low-bitrate-switcher",
	kind: "device-card",
	title: "Low bitrate switcher",
	defaultSize: { w: 6, h: 13 },
	minSize: { w: 4, h: 6 },
	component: (status?: Status) => (status ? switcherCard(card, status, switcherLive()) : null),
	handleEvent: (event, data) => {
		handleSwitcherEvent(event, data);
	},
};

export default lowBitrateSwitcherModule;
