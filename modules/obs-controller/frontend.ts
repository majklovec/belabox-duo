/* OBS Studio panel — live preview (polled GetSourceScreenshot), stream/record and
 * input actions, scene deck and a VU meter. All calls go through the obs.request
 * passthrough (the browser is never a direct OBS client); state arrives via
 * `obs.event` pushes (InputVolumeMeters feeds the VU meter, scene/stream/record
 * events keep the buttons honest).
 *
 * Rendered on two surfaces: the device page (module registry below — one instance
 * on the page, state mirrored onto st.obs) and the dashboard's "obs" widget
 * (one instance per widget, fed by that device's viewer websocket via
 * `createObsPanel` below).
 */
import "./styles.css";
import m from "mithril";
import { badge, button, Card } from "../../public/ts/components/ui";
import { t } from "../../public/ts/i18n";
import { obsRequest, st } from "../../public/ts/device/store";
import type { Status } from "../../public/types";
import type { BrowserModule } from "../types";

// ----------------------------------------------------------------------
// Panel factory — one instance per render surface, own state and timers
// ----------------------------------------------------------------------
/** Successful obs-websocket v5 envelope (the shape `obs.request` answers with). */
export interface ObsRequestResult<T> {
	requestType?: string;
	requestStatus?: { result: boolean; code?: number; comment?: string };
	responseData?: T;
}
/** One push of a forwarded OBS event (or the synthetic disconnect drop). */
export interface ObsEvent {
	eventType?: string;
	eventData?: Record<string, unknown>;
	disconnected?: boolean;
}
export interface ObsPanelDeps {
	/** Send one obs.request through this device's connection. */
	send: <T>(requestType: string, requestData?: Record<string, unknown>) => Promise<ObsRequestResult<T> | undefined>;
	/** Subscribe to `obs.event` pushes; returns an unsubscribe. */
	onEvent: (handler: (ev: ObsEvent) => void) => () => void;
	/** Mirror shared state to the surface's own store (device st.obs, dashboard live). */
	mirror?: (s: ObsPanelState) => void;
	/** The surface already knows OBS is up (dashboard warm start) — skip the first ping. */
	startConnected?: () => boolean;
	/** Runs when the last render unmounts (dropped timers, unsubscribed pushes). */
	onDestroy?: () => void;
}
export interface ObsPanelState {
	connected: boolean;
	streaming: boolean;
	recording: boolean;
	scene: string | null;
}
/** A built panel: render its body, add its head extras, feed it pushes. */
export interface ObsPanel {
	component(): m.Vnode;
	head(): m.Vnode[];
	handleEvent(event: string, data: unknown): void;
	state: ObsPanelState;
	/** Stop timers and unsubscribe; safe to call more than once. */
	destroy(): void;
}

/** Per-input VU meter frame: the smoothed display level plus its target. */
interface VuFrame {
	/** 0..1 target level from the last InputVolumeMeters push. */
	target: number;
	/** Displayed (smoothed) level. */
	level: number;
	/** Peak-hold level. */
	peak: number;
	/** Frames left before the peak starts to decay. */
	peakHold: number;
}

/** Outline microphone (24×24, strokes with currentColor); muted adds a slash. */
function micIcon(muted: boolean): m.Vnode {
	return m(
		"svg.obs-mic-icon",
		{ viewBox: "0 0 24 24", "aria-hidden": "true" },
		[
			m("rect", { x: "9", y: "3", width: "6", height: "11", rx: "3" }),
			m("path", { d: "M5 11a7 7 0 0 0 14 0" }),
			m("path", { d: "M12 18v3" }),
			m("path", { d: "M8 21h8" }),
			muted ? m("path", { d: "M4 4 20 20" }) : null,
		],
	);
}

/**
 * Build the panel. `component()` renders the card body; `head()` the card
 * header extras (connection badge + refresh); `handleEvent` feeds pushes.
 */
export function createObsPanel({ send, onEvent, mirror, startConnected, onDestroy }: ObsPanelDeps): ObsPanel {
	/* Panel-local UI state. */
	const ui = {
		/** GetSceneList names; the active one is ui.scene. */
		scenes: [] as string[],
		/** Metering input names (seeded from GetInputList, then follows InputVolumeMeters) — one row per source. */
		vuInputs: [] as string[],
		/** Per-input mute state, for each row's mic toggle icon. */
		vuMuted: new Map<string, boolean>(),
		studio: false,
		connected: false,
		streaming: false,
		recording: false,
		scene: null as string | null,
		loaded: false,
		loading: false,
		// preview (always the preview output; falls back to the current scene)
		previewInterval: 5_000, // ms; 0 = manual only
		previewPaused: false,
		previewData: null as string | null,
		previewAt: 0,
		previewFailed: false,
		lastAttempt: 0,
		inFlight: false,
	};
	const state: ObsPanelState = { connected: false, streaming: false, recording: false, scene: null };

	/** Action keys with a request in flight (disables their buttons). */
	const pending = new Set<string>();
	let mounts = 0;
	let tickTimer = 0;
	let rafId = 0;
	let pingInFlight = false;
	let lastPing = 0;

	/* One meter canvas per input plus its smoothed frame. Smoothing is as in
	 * obs.html: fast attack, 30-frame peak hold, slow decay. */
	const vuCanvases = new Map<string, HTMLCanvasElement>();
	const vuState = new Map<string, VuFrame>();
	const getVuFrame = (name: string): VuFrame => {
		let f = vuState.get(name);
		if (!f) {
			f = { target: 0, level: 0, peak: 0, peakHold: 0 };
			vuState.set(name, f);
		}
		return f;
	};

	const pushState = (): void => {
		state.connected = ui.connected;
		state.streaming = ui.streaming;
		state.recording = ui.recording;
		state.scene = ui.scene;
		mirror?.(state);
	};

	const obsCall = async <T>(type: string, data: Record<string, unknown> = {}): Promise<T | undefined> => {
		let res: ObsRequestResult<T> | undefined;
		try {
			res = await send<T>(type, data);
		} catch {
			return undefined; // the socket is down — the next tick will re-probe
		}
		return res?.requestStatus?.result ? res.responseData : undefined;
	};

	/** Connection probe: a GetVersion is the cheapest round-trip the module answers. */
	async function ping(): Promise<void> {
		if (pingInFlight || ui.connected) return;
		pingInFlight = true;
		const res = await obsCall<unknown>("GetVersion");
		pingInFlight = false;
		if (res !== undefined && !ui.connected) {
			ui.connected = true;
			pushState();
			m.redraw();
		}
	}

	/** Re-read every input's mute state so each row's mic icon reflects OBS. */
	async function syncAllMute(): Promise<void> {
		const names = ui.vuInputs;
		await Promise.all(
			names.map(async (name) => {
				const mute = await obsCall<{ inputMuted: boolean }>("GetInputMute", { inputName: name });
				if (mute) ui.vuMuted.set(name, mute.inputMuted === true);
			}),
		);
		m.redraw();
	}

	/** Fetch a single input's mute state the first time it reports volume (scene switch brings new sources). */
	function ensureMute(name: string): void {
		if (ui.vuMuted.has(name)) return;
		void obsCall<{ inputMuted: boolean }>("GetInputMute", { inputName: name }).then((mute) => {
			if (mute) {
				ui.vuMuted.set(name, mute.inputMuted === true);
				m.redraw();
			}
		});
	}

	/** Scenes, inputs, the active scene, studio mode and the selected input's mute state. */
	async function loadAll(): Promise<void> {
		if (ui.loading) return;
		ui.loading = true;
		const [scenes, inputs, studio, scene] = await Promise.all([
			obsCall<{ scenes: { sceneName: string }[] }>("GetSceneList"),
			obsCall<{ inputs: { inputName: string }[] }>("GetInputList"),
			obsCall<{ studioModeEnabled: boolean }>("GetStudioModeEnabled"),
			// GetCurrentProgramScene answers { currentProgramSceneName } — not { sceneName }.
			obsCall<{ currentProgramSceneName: string }>("GetCurrentProgramScene"),
		]);
		if (scenes?.scenes) ui.scenes = scenes.scenes.map((s) => s.sceneName);
		// Seed the active scene so the preview scene fallback and the scene-deck
		// highlight work before the first scene-change event arrives.
		if (scene?.currentProgramSceneName) ui.scene = scene.currentProgramSceneName;
		if (inputs?.inputs) {
			ui.vuInputs = inputs.inputs.map((i) => i.inputName);
		}
		if (studio?.studioModeEnabled !== undefined) ui.studio = studio.studioModeEnabled;
		await syncAllMute();
		ui.loading = false;
		ui.loaded = true;
		m.redraw();
	}

	/** Drop the panel's live state when OBS goes away. */
	function offline(): void {
		ui.connected = false;
		ui.streaming = false;
		ui.recording = false;
		ui.scene = null;
		ui.loaded = false;
		vuCanvases.clear();
		vuState.clear();
		ui.vuMuted.clear();
		ui.vuInputs = [];
		ui.previewData = null;
		ui.previewFailed = false;
		ui.inFlight = false;
		ui.lastAttempt = 0;
		lastPing = 0; // probe again on the next tick
		pushState();
	}

	/** Refresh the preview right away (also used when the source changes). */
	async function capturePreview(): Promise<void> {
		if (!ui.connected || ui.inFlight || ui.previewPaused) return;
		ui.inFlight = true;
		ui.lastAttempt = Date.now();
		m.redraw();
		const grab = async (name: string) =>
			(await obsCall<{ imageData: string }>("GetSourceScreenshot", {
				sourceName: name,
				imageFormat: "jpg",
				imageWidth: 640,
				imageHeight: 360,
				imageCompressionQuality: 60,
			}))?.imageData;
		try {
			// The "Program" virtual output is the canonical capture target; setups where
			// it rejects the name (code 600) fall back to the current scene, as obs.html does.
			let data: string | undefined;
			data = await grab("Program");
			if (!data && ui.scene) data = await grab(ui.scene);
			if (data) {
				ui.previewData = data;
				ui.previewAt = Date.now();
				ui.previewFailed = false;
			} else ui.previewFailed = true;
		} finally {
			ui.inFlight = false;
			m.redraw();
		}
	}

	/** One-shot request with the button's pending guard. */
	function press(key: string, type: string, data: Record<string, unknown> = {}): void {
		if (!ui.connected || pending.has(key)) return;
		pending.add(key);
		m.redraw();
		void obsCall(type, data).finally(() => {
			pending.delete(key);
			m.redraw();
		});
	}

	/** Get-then-set toggle (mute, studio mode) sharing one pending slot. */
	function toggle(
		key: string,
		getType: string,
		getData: Record<string, unknown>,
		read: (r: Record<string, unknown>) => boolean,
		setType: string,
		setData: (next: boolean) => Record<string, unknown>,
		apply: (next: boolean) => void,
	): void {
		if (!ui.connected || pending.has(key)) return;
		pending.add(key);
		m.redraw();
		void (async () => {
			const current = await obsCall<Record<string, unknown>>(getType, getData);
			if (!current) return; // do not guess when the read fails
			const next = !read(current);
			const res = await obsCall<unknown>(setType, setData(next));
			if (res !== undefined) apply(next);
		})().finally(() => {
			pending.delete(key);
			m.redraw();
		});
	}

	/** Screenshot the program output at full size and download it. */
	async function screenshot(): Promise<void> {
		if (!ui.connected || pending.has("obs.screenshot")) return;
		pending.add("obs.screenshot");
		m.redraw();
		const grab = async (name: string) =>
			(await obsCall<{ imageData: string }>("GetSourceScreenshot", {
				sourceName: name,
				imageFormat: "png",
				imageWidth: 1920,
				imageHeight: 1080,
				imageCompressionQuality: 90,
			}))?.imageData;
		try {
			let data: string | undefined;
			data = await grab("Program");
			if (!data && ui.scene) data = await grab(ui.scene);
			if (data) {
				const a = document.createElement("a");
				a.href = data;
				a.download = `obs-screenshot-${Date.now()}.png`;
				a.click();
			}
		} finally {
			pending.delete("obs.screenshot");
			m.redraw();
		}
	}

	/** One 500ms tick: probe, (re)load, poll the preview and repaint. */
	const tick = (): void => {
		const now = Date.now();
		if (!ui.connected && now - lastPing > 3_000) {
			lastPing = now;
			void ping();
		}
		if (ui.connected && !ui.loaded && !ui.loading) void loadAll();
		if (
			ui.connected &&
			ui.loaded &&
			ui.previewInterval > 0 &&
			!ui.previewPaused &&
			!ui.inFlight &&
			now - ui.lastAttempt >= ui.previewInterval
		)
			void capturePreview();
		m.redraw();
	};

	/** Smooth one input's level/peak and paint its meter canvas. */
	function drawVu(c: HTMLCanvasElement, f: VuFrame): void {
		const dpr = window.devicePixelRatio || 1;
		const rect = c.getBoundingClientRect();
		const W = Math.max(1, Math.round(rect.width * dpr));
		const H = Math.max(1, Math.round(rect.height * dpr));
		if (c.width !== W) c.width = W;
		if (c.height !== H) c.height = H;
		const ctx = c.getContext("2d");
		if (!ctx) return;

		f.level += (f.target - f.level) * 0.35;
		if (f.target > f.peak) {
			f.peak = f.target;
			f.peakHold = 30;
		} else if (f.peakHold > 0) {
			f.peakHold--;
		} else f.peak = Math.max(f.level, f.peak - 0.008);

		ctx.fillStyle = "#0a0a0a";
		ctx.fillRect(0, 0, W, H);
		const g = ctx.createLinearGradient(0, 0, W, 0);
		g.addColorStop(0, "#00e676");
		g.addColorStop(0.6, "#ffeb3b");
		g.addColorStop(0.85, "#ff9800");
		g.addColorStop(1, "#f44336");
		ctx.fillStyle = g;
		ctx.fillRect(0, 0, Math.min(f.level, 1) * W, H);
		if (f.peak > 0.01) {
			ctx.fillStyle = "#fff";
			ctx.fillRect(Math.min(f.peak, 1) * W - 2, 0, 2, H);
		}
	}

	const vuLoop = (): void => {
		for (const [name, c] of vuCanvases) drawVu(c, getVuFrame(name));
		rafId = requestAnimationFrame(vuLoop);
	};

	function handleEvent(event: string, data: unknown): void {
		if (event !== "obs.event") return;
		const ev = data as ObsEvent;
		// Synthetic drop event from the backend (no eventType field)
		if (ev.disconnected) {
			offline();
			m.redraw();
			return;
		}
		const d = ev.eventData ?? {};
		let dirty = false; // the rAF loop feeds the VU meter itself — no redraw needed per meter event
		switch (ev.eventType) {
			case "CurrentProgramSceneChanged":
				ui.scene = (d.sceneName as string) ?? null;
				dirty = true;
				break;
			case "StreamStateChanged":
				ui.streaming = d.outputActive === true;
				dirty = true;
				break;
			case "RecordStateChanged":
				ui.recording = d.outputActive === true;
				dirty = true;
				break;
			// OBS 31+ renamed InputMute to InputMuteStateChanged — handle both.
			case "InputMute":
			case "InputMuteStateChanged":
				if (typeof d.inputName === "string") {
					const next = d.inputMuted === true;
					if (ui.vuMuted.get(d.inputName) !== next) {
						ui.vuMuted.set(d.inputName, next);
						dirty = true;
					}
				}
				break;
			case "InputVolumeMeters": {
				// obs-websocket v5 delivers a per-bus `inputLevelsMul` array — typically
				// 2D `[[L,R,M],[L,R,M]]` for the two buses; flatten to per-channel levels.
				const inputs = d.inputs as Array<{ inputName: string; inputLevelsMul: number[] | number[][] }> | undefined;
				if (inputs?.length) {
					// The row list follows the sources that are actually metering: a scene
					// change swaps them, so adopt the incoming set — keep current order for
					// sources still present, append new ones in arrival order, drop the rest.
					const incoming = inputs.map((i) => i.inputName);
					const dropped = ui.vuInputs.filter((n) => !incoming.includes(n));
					const fresh = incoming.filter((n) => !ui.vuInputs.includes(n));
					if (dropped.length || fresh.length) {
						ui.vuInputs = [...ui.vuInputs.filter((n) => incoming.includes(n)), ...fresh];
						for (const n of dropped) vuState.delete(n);
						for (const n of fresh) ensureMute(n);
						dirty = true; // the row set changed — re-render the list
					}
					for (const inp of inputs) {
						const flat = [...(inp.inputLevelsMul ?? [])].flat();
						const avg = flat.reduce((a, b) => a + b, 0) / Math.max(1, flat.length);
						getVuFrame(inp.inputName).target = Math.min(1, Math.max(0, Math.pow(avg, 0.5)));
					}
				}
				// The first event after a drop is what proves the link is back up
				if (!ui.connected) {
					ui.connected = true;
					dirty = true;
				}
				break;
			}
		}
		if (dirty) {
			pushState();
			m.redraw();
		}
	}

	let unsubscribe = () => {};

	/** Card header extras: connection badge + refresh (host adds the title). */
	function head(): m.Vnode[] {
		return [
			badge(ui.connected ? t("obs.connected") : t("obs.offline"), ui.connected ? "on" : "off"),
		];
	}

	function component(): m.Vnode {
		/* Countdown / meta text for the preview bar. */
		const meta = (): string => {
			if (!ui.connected) return t("obs.offline");
			if (ui.previewPaused) return t("obs.paused");
			if (ui.previewInterval === 0) return t("obs.manual");
			const remaining = Math.max(0, Math.ceil((ui.lastAttempt + ui.previewInterval - Date.now()) / 1000));
			return t("obs.next", remaining);
		};

		/* Actions — state comes from the stream/record/mute/studio events. */
		const actionBtn = (key: string, label: string, active: boolean, cls: string, run: () => void) =>
			button(label, {
				class: active ? `${cls} active`.trim() : `secondary`,
				disabled: !ui.connected || pending.has(key),
				onclick: run,
			});

		return m(
			"div",
			{
				oncreate: () => {
					mounts++;
					if (mounts === 1) {
						if (startConnected?.()) ui.connected = true;
						tickTimer = window.setInterval(tick, 500);
						rafId = requestAnimationFrame(vuLoop);
					}
				},
				onremove: () => {
					mounts--;
					if (mounts <= 0) {
						mounts = 0;
						destroy();
					}
				},
			},
			!ui.connected
				? m("p.muted", t("obs.offline"))
				: !ui.loaded
					? m("p.muted", t("obs.waiting"))
					: [
						/* Preview */
						m(
							"div.obs-preview-block",
							m(
								"div.obs-preview-stage",
								ui.previewData
									? m("img", { alt: t("obs.preview"), src: ui.previewData })
									: m("div.obs-preview-empty", ui.previewFailed ? t("obs.preview_failed") : t("obs.waiting")),
							),
							m(
								"div.obs-preview-bar",
								m(
									"select",
									{
										disabled: !ui.connected,
										value: String(ui.previewInterval),
										onchange: (e: Event) => (ui.previewInterval = Number((e.target as HTMLSelectElement).value)),
									},
									[
										[5_000, "5s"],
										[10_000, "10s"],
										[30_000, "30s"],
										[0, t("obs.manual")],
									].map(([ms, label]) => m("option", { key: String(ms), value: String(ms) }, label)),
								),
								ui.previewInterval > 0 && !ui.previewPaused
									? m("span.obs-preview-meta", meta())
									: null,
								button(ui.previewPaused ? t("obs.resume") : t("obs.pause"), {
									class: "secondary",
									onclick: () => (ui.previewPaused = !ui.previewPaused),
								}),
								button(t("obs.preview_now"), {
									class: "secondary",
									disabled: ui.inFlight || ui.previewPaused,
									onclick: () => void capturePreview(),
								}),
								// button(t("obs.screenshot"), {
								// 	class: "secondary",
								// 	disabled: pending.has("obs.screenshot"),
								// 	onclick: () => void screenshot(),
								// }),
							),
						),
						/* Scenes + output actions */
						m(
							"div.obs-deck",
							m(
								"div.obs-deck-col",
								m("h3.obs-section", t("obs.scenes")),
								m(
									"div.obs-scene-deck",
									ui.scenes.length
										? ui.scenes.map((name) =>
											button(name, {
												class: ui.scene === name ? "active" : "secondary",
												disabled: !ui.connected || pending.has("obs.scene"),
												onclick: () => press("obs.scene", "SetCurrentProgramScene", { sceneName: name }),
											}),
										  )
										: m("span.muted", t("obs.no_scenes")),
								),
							),
							m(
								"div.obs-deck-col",
								m("h3.obs-section", t("obs.output")),
								m(
									"div.obs-actions",
									actionBtn(
										"obs.stream",
										ui.streaming ? t("obs.stop_stream") : t("obs.start_stream"),
										ui.streaming,
										"obs-action-stream",
										() => press("obs.stream", ui.streaming ? "StopStream" : "StartStream"),
									),
									actionBtn(
										"obs.record",
										ui.recording ? t("obs.stop_record") : t("obs.start_record"),
										ui.recording,
										"obs-action-record",
										() => press("obs.record", ui.recording ? "StopRecord" : "StartRecord"),
									),
									// actionBtn(
									// 	"obs.studio",
									// 	t("obs.studio"),
									// 	ui.studio,
									// 	"obs-action-studio",
									// 	() =>
									// 		toggle(
									// 			"obs.studio",
									// 			"GetStudioModeEnabled",
									// 			{},
									// 			(r) => r.studioModeEnabled === true,
									// 			"SetStudioModeEnabled",
									// 			(next) => ({ studioModeEnabled: next }),
									// 			(next) => {
									// 				ui.studio = next;
									// 			},
									// 		),
									// ),
								),
							),
						),
						/* Audio — one meter row per input, each with its own mic mute toggle. */
						m(
							"div.obs-deck",
							m("h3.obs-section", t("obs.audio")),
							m(
								"div.obs-audio",
								ui.vuInputs.length
									? ui.vuInputs.map((name) => {
										const muted = ui.vuMuted.get(name) === true;
										const muteKey = `obs.mute.${name}`;
										return m(
											"div.obs-audio-row",
											{ key: name },
											button(micIcon(muted), {
												class: muted ? "obs-mic muted" : "obs-mic",
												title: t(muted ? "obs.unmute" : "obs.mute"),
												disabled: !ui.connected || pending.has(muteKey),
												onclick: () =>
													toggle(
														muteKey,
														"GetInputMute",
														{ inputName: name },
														(r) => r.inputMuted === true,
														"SetInputMute",
														(next) => ({ inputName: name, inputMuted: next }),
														(next) => {
															ui.vuMuted.set(name, next);
														},
													),
											}),
											m("span.obs-audio-name", { title: name }, name),
											m("canvas.obs-vu", {
												oncreate: (v) => vuCanvases.set(name, v.dom as HTMLCanvasElement),
												onremove: () => vuCanvases.delete(name),
											}),
										);
									})
									: m("span.muted", t("obs.no_inputs")),
							),
						),
					],
		);
	}

	unsubscribe = onEvent((ev) => handleEvent("obs.event", ev));

	/** Tear down timers/subscriptions without waiting for the last onremove. */
	let destroyed = false;
	function destroy(): void {
		if (destroyed) return;
		destroyed = true;
		window.clearInterval(tickTimer);
		cancelAnimationFrame(rafId);
		vuCanvases.clear();
		vuState.clear();
		unsubscribe();
		onDestroy?.();
	}

	return { component, head, handleEvent, state, destroy };
}


// ----------------------------------------------------------------------
// Device page binding — the module registry renders this one instance
// ----------------------------------------------------------------------
const panel = createObsPanel({
	send: obsRequest,
	onEvent: () => () => {}, // the registry routes obs.event through handleEvent
	mirror: (s) => {
		st.obs.connected = s.connected;
		st.obs.streaming = s.streaming;
		st.obs.recording = s.recording;
		st.obs.scene = s.scene;
	},
});

export const obsControllerModule: BrowserModule = {
	id: "obs-controller",
	title: "OBS",
	defaultSize: { w: 6, h: 13 },
	minSize: { w: 4, h: 4 },
	component: (_status?: Status) => m(Card, { title: t("obs.card"), class: "mod-obs-controller", headActions: panel.head() }, panel.component()),
	handleEvent: (event, data) => panel.handleEvent(event, data),
};
	