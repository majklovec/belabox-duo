import m from "mithril";
import type { StatsSample } from "../types";
// ---------------------------------------------------------------------------
// Line chart
//
// SVG line chart for the viewer series, modeled on
// mithril-components/mithril-node-linechart: dashed grid, axis legends and
// circle + polyline per series. The viewBox is fitted to the container's
// aspect ratio (via ResizeObserver) so the plot scales uniformly and fills
// the whole card — no letterbox gaps — and the fixed unit margins are only
// as wide as the axis legends need. The Y scale spans the series min→max
// (not 0→max) so small variations aren't squashed at the bottom.
// ---------------------------------------------------------------------------

/** Fixed unit scale: the viewBox width is always 100 units. */
const W = 100;
/** Margins (viewBox units) — just enough room for the axis legends. */
const M = { left: 10, right: 5, top: 2, bottom: 6.5 } as const;
/** Fallback viewBox height (units) until the first size measurement lands. */
const H_FALLBACK = 55;
const GRID_V = 10;

type Pt = [number, number];
type State = { aspect: number | null; observer: ResizeObserver };

function gridLines(vertical: number, horizontal: number, x0: number, x1: number, y0: number, y1: number): m.Children {
    const lines: m.Children[] = [];
    for (let i = 0; i <= vertical; i++) {
        const x = x0 + (i * (x1 - x0)) / vertical;
        lines.push(m("line", { key: `v${i}`, x1: x, x2: x, y1: y0, y2: y1 }));
    }
    for (let i = 0; i <= horizontal; i++) {
        const y = y1 - (i * (y1 - y0)) / horizontal;
        lines.push(m("line", { key: `h${i}`, x1: x0, x2: x1, y1: y, y2: y }));
    }
    return lines;
}

/** Compact time label: HH:MM for the current day, otherwise MM-DD. */
function timeLabel(t: number): string {
    const d = new Date(t);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const pad = (n: number) => String(n).padStart(2, "0");
    return sameDay ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The line chart: `points` oldest first; Y spans the series min→max. */
export const LineChart: m.Component<{ points: StatsSample[]; title?: string }, State> = {
    oncreate(vnode) {
        const el = vnode.dom as SVGElement;
        vnode.state.aspect = null;
        vnode.state.observer = new ResizeObserver(() => {
            const r = el.getBoundingClientRect();
            const aspect = r.height > 0 ? r.width / r.height : null;
            if (aspect && (vnode.state.aspect === null || Math.abs(aspect - vnode.state.aspect) > 0.01)) {
                vnode.state.aspect = aspect;
                void m.redraw();
            }
        });
        vnode.state.observer.observe(el);
    },
    onremove(vnode) {
        vnode.state.observer.disconnect();
    },
    view: (vnode) => {
        const { points } = vnode.attrs;
        if (!points.length) return m("svg.spark", { role: "img", "aria-hidden": "true" });
        const n = points.length;

        // Fit the viewBox height to the container aspect so the chart scales
        // uniformly and fills the space; the horizontal grid row count follows.
        const aspect = vnode.state?.aspect ?? null;
        const h = aspect && aspect >= 0.2 && aspect <= 10 ? W / aspect : H_FALLBACK;
        const x0 = M.left, x1 = W - M.right;
        const y0 = M.top, y1 = Math.max(y0 + 8, h - M.bottom);
        const gridH = Math.max(2, Math.min(12, Math.round((y1 - y0) / 9)));

        // Y scale: series min→max (min 1 value so an all-zero series still renders).
        const min = Math.min(...points.map((p) => p.v));
        const max = Math.max(1, ...points.map((p) => p.v));
        const span = max - min;
        const xs = (i: number) => (n === 1 ? (x0 + x1) / 2 : x0 + (i * (x1 - x0)) / (n - 1));
        const ys = (v: number) => (span <= 0 ? (y0 + y1) / 2 : y1 - ((v - min) / span) * (y1 - y0));
        const pt = (i: number): Pt => [xs(i), ys(points[i]!.v)];
        const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

        // X legends: up to 5 evenly placed ticks (start, end, …).
        const tickCount = n < 2 ? 1 : Math.min(5, n);
        const xTicks: m.Children[] = [];
        for (let i = 0; i < tickCount; i++) {
            const idx = tickCount === 1 ? 0 : Math.round((i * (n - 1)) / (tickCount - 1));
            const [x] = pt(idx);
            xTicks.push(m("text", { key: `x${i}`, x, y: y1 + 5, "text-anchor": "middle", "font-size": 3 }, timeLabel(points[idx]!.t)));
        }

        return m(
            "svg.spark",
            {
                viewBox: `0 0 ${W} ${h}`,
                preserveAspectRatio: "xMidYMid meet",
                role: "img",
                "aria-label": vnode.attrs.title,
            },
            [
                // Grid (mirrors the reference's dashed grid).
                m("g", { class: "spark-grid" }, gridLines(GRID_V, gridH, x0, x1, y0, y1)),
                // Y legends: min / max of the visible series.
                m("g", { class: "spark-axis" }, [
                    m("text", { key: "max", x: x0 - 1, y: y0 + 1, "text-anchor": "end", "font-size": 3 }, fmt(max)),
                    m("text", { key: "min", x: x0 - 1, y: y1 + 1, "text-anchor": "end", "font-size": 3 }, fmt(min)),
                ]),
                // X legends.
                m("g", { class: "spark-axis" }, xTicks),
                // Series points.
                m("g", { class: "spark-points" }, points.map((p, i) => {
                    const [x, y] = pt(i);
                    return m("circle", { key: i, cx: x, cy: y, r: 0.8 });
                })),
                // The line itself.
                m("g", { class: "spark-line" }, m("polyline", { points: points.map((_, i) => pt(i).join(",")).join(" ") })),
            ],
        );
    },
};
