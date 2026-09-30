Best framework for this codebase: Mithril.js
Looking at yocur actual code, you already have a well-factored vanilla setup: a hyperscript helper (h), a tiny byId, WebSocket RPC with a pending map, and a set of small entry points (devices.ts, app.ts, settings.ts, setup.ts) loaded directly as ES modules — no build step.

Given those constraints, Mithril is the best fit. Here's why, ranked by importance:

Why Mithril fits this code
No build step required. You load .ts/.js directly. Mithril ships as a single ES module (~10 KB gzipped). You can import m from "https://esm.sh/mithril" and you're done — same deployment story you have now.

Your h() is basically m(). Migration is nearly mechanical:

ts
// today
h("tr", { className: "selected" }, h("td", {}, box), ...)
// mithril
m("tr.selected", m("td", box), ...)
m() handles props, children, event handlers, SVG (via m("svg", …)), and returns real DOM. You could even keep your h as a thin wrapper initially.

Auto-redraw matches your push model. Your WS handler currently calls render(status), renderInterfaces(...), renderLog(), etc. by hand. Mithril's m.redraw() after an event/response gives you the same thing with less code: state lives in plain objects, the view is a pure function of state.

Component-per-card maps cleanly onto your existing sections:

text
EncoderCard | SrtlaCard | InterfacesCard | ModemsCard | LogCard
Each one takes { status, stats, … } and returns a vnode tree. Your renderEncoder, renderSrtla, renderInterfaces, renderModems become the view functions with almost identical bodies.

Forms and FormData work unchanged. Mithril does not own the DOM the way Vue/React do; requestSubmit, reportValidity, FormData, and your prefill/touched logic keep working.

Tiny surface. You'd only use: m, m.route (optional, if you merge the 4 pages), m.request (optional — you already have WS RPC), lifecycle hooks (oninit, oncreate, onupdate, onremove) for the few imperative bits (meters, focus preservation, scroll). That's it.

How the four entry points would map
Today Mithril
devices.ts → table rows DevicesPage component, setInterval → m.redraw()
app.ts → the big device page DevicePage with child card components; WS onmessage just mutates state + m.redraw()
settings.ts SettingsPage
setup.ts wizard SetupWizard with step in state; rebuildSteps() becomes derived data
You could either keep 4 HTML files and mount 4 separate Mithril apps, or consolidate into one SPA with m.route and a single index.html. The former is closer to what you have; the latter is cleaner long-term.

The pieces to watch out for
document.activeElement / "don't clobber user input" logic — Mithril re-renders only changed vnodes, so value on an <input> still tracks the DOM. Your touched set and focus checks mostly disappear because Mithril won't overwrite the input unless the vnode's value changes. Keep touched only if you want to remember user edits across status pushes.

replaceChildren in a few places (log, iface-rows, modem-list) — becomes {rows.map(fn)} in the view. This is where the code shrinks the most.

<meter> elements — set value via vnode attrs; Mithril sets attributes for SVG/meter correctly.

Log ring buffer with dedupe counter — keep logRows as plain state; the view sorts and slices. nextLocalId still works.

inFlight / awaitingStatus button disabling — trivially expressed as disabled: inFlight.has(id) || awaitingStatus.has(id) || !allowed(lastStatus).

Auto-reconnect WS — keep it as a module-level singleton; on each onmessage do Object.assign(state, …) then m.redraw().
