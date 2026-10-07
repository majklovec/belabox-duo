import m from "mithril";
import type { StatsSample } from "../types";
// ---------------------------------------------------------------------------
// Line chart
//
// SVG line chart for the viewer series, modeled on
// mithril-components/mithril-node-linechart: dashed grid, axis legends and
// circle + polyline per series, all drawn in a fixed 100×55 viewBox so the
// card can scale it with `width: 100%`.
// ---------------------------------------------------------------------------

const CHART = { w: 100, h: 55, x0: 10, x1: 92, y0: 10, y1: 45 } as const;

type Pt = [number, number];

function gridLines(vertical: number, horizontal: number): m.Children {
    const lines: m.Children[] = [];
    for (let i = 0; i <= vertical; i++) {
        const x = CHART.x0 + (i * (CHART.x1 - CHART.x0)) / vertical;
        lines.push(m("line", { key: `v${i}`, x1: x, x2: x, y1: CHART.y0, y2: CHART.y1 }));
    }
    for (let i = 0; i <= horizontal; i++) {
        const y = CHART.y1 - (i * (CHART.y1 - CHART.y0)) / horizontal;
        lines.push(m("line", { key: `h${i}`, x1: CHART.x0, x2: CHART.x1, y1: y, y2: y }));
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

/** The line chart: `points` oldest first; max Y is the series peak (min 1). */
export const LineChart: m.Component<{ points: StatsSample[]; title?: string }> = {
    view: (vnode) => {
        const { points } = vnode.attrs;
        if (!points.length) return m("svg.spark", { role: "img", "aria-hidden": "true" });
        const n = points.length;
        const max = Math.max(1, ...points.map((p) => p.v));
        const minT = points[0]!.t;
        const span = Math.max(1, points[n - 1]!.t - minT);
        const xs = (i: number) => (n === 1 ? (CHART.x0 + CHART.x1) / 2 : CHART.x0 + (i * (CHART.x1 - CHART.x0)) / (n - 1));
        const ys = (v: number) => CHART.y1 - (v / max) * (CHART.y1 - CHART.y0);
        const pt = (i: number): Pt => [xs(i), ys(points[i]!.v)];
        const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

        // X legends: up to 5 evenly placed ticks (start, end, …).
        const tickCount = n < 2 ? 1 : Math.min(5, n);
        const xTicks: m.Children[] = [];
        for (let i = 0; i < tickCount; i++) {
            const idx = tickCount === 1 ? 0 : Math.round((i * (n - 1)) / (tickCount - 1));
            const [x] = pt(idx);
            xTicks.push(m("text", { key: `x${i}`, x, y: CHART.y1 + 6, "text-anchor": "middle", "font-size": 3 }, timeLabel(points[idx]!.t)));
        }

        return m(
            "svg.spark",
            {
                viewBox: `0 0 ${CHART.w} ${CHART.h}`,
                preserveAspectRatio: "xMidYMid meet",
                role: "img",
                "aria-label": vnode.attrs.title,
            },
            [
                // Grid (mirrors the reference's dashed 10×10 grid).
                m("g", { class: "spark-grid" }, gridLines(10, 4)),
                // Y legends: min / max of the visible series.
                m("g", { class: "spark-axis" }, [
                    m("text", { key: "max", x: CHART.x0 - 1, y: CHART.y0 + 1, "text-anchor": "end", "font-size": 3 }, fmt(max)),
                    m("text", { key: "min", x: CHART.x0 - 1, y: CHART.y1 + 1, "text-anchor": "end", "font-size": 3 }, "0"),
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
