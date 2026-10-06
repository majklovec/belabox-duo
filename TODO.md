# Handoff Update: Inline Widget Editor with Drag & Resize

**Supersedes the "v1 ordered list, no drag-and-drop" decision** from the previous handoff. Everything else stands.

The dashboard is no longer a read-only ordered list configured from a separate settings panel. It becomes a **2D grid with inline editing** — users drag widgets to reposition, drag handles to resize, and add/remove widgets directly on the dashboard surface.

---

## 1. What Changes

| Aspect             | Before                               | After                                                         |
| ------------------ | ------------------------------------ | ------------------------------------------------------------- |
| Layout model       | Ordered list + width class           | 2D grid: `{x, y, w, h}` per item                              |
| Editor location    | Separate `dashboard-editor.ts` panel | Inline, on the dashboard surface, toggled by an "Edit" button |
| Interaction        | Up/down reorder, width dropdown      | Drag to move, drag corner/edge to resize                      |
| Persistence timing | On form submit                       | Debounced auto-save on drag/resize stop                       |
| Module contract    | `defaultWidth` only                  | `defaultSize`, `minSize`, `maxSize`                           |

Everything else — per-device scope, multiple dashboards, enabled-modules filter, module directory layout — is unchanged.

---

## 2. Data Model

```ts
interface Dashboard {
  id: string;
  name: string;
  /** Monotonic; bumped on every update. Used for optimistic concurrency. */
  version: number;
  items: DashboardItem[];
  /** Columns in the grid. Fixed at 12 for now; stored for forward-compat. */
  columns: number;
}

interface DashboardItem {
  moduleId: string;
  /** Grid units, 0-indexed. */
  x: number;
  y: number;
  /** Extent in grid units. */
  w: number;
  h: number;
  visible: boolean;
}
```

**Grid unit:** 12 columns wide. Row height is a fixed pixel value (recommend **60px**, expose as a CSS variable `--dash-row-h`). Widget positions and sizes are always integers in grid units — never pixels. This is what makes resize predictable and saveable.

**Migration from v1:** on first load of a v1 dashboard, assign `x = 0, y = runningRow, w = widthToColumns(width), h = defaultHeight(moduleId)` per item in order, then bump `version` to 2. One-time conversion, stored back on save. v1 dashboards never coexist with v2 in memory.

---

## 3. Module Contract Changes

`modules/types.ts` — extend `BrowserModule`:

```ts
export interface BrowserModule {
  id: string;
  title: string;
  icon?: string;
  component: unknown;
  /** Default grid size when added to a dashboard. */
  defaultSize: { w: number; h: number }; // replaces defaultWidth
  /** Minimum size the user can resize down to. */
  minSize: { w: number; h: number };
  /** Optional cap. Omit for unbounded. */
  maxSize?: { w: number; h: number };
  handleEvent?(event: string, data: unknown): void;
}
```

Suggested defaults per module:

| Module           | defaultSize  | minSize      |
| ---------------- | ------------ | ------------ |
| `encoder`        | `{w:6, h:5}` | `{w:4, h:4}` |
| `srtla`          | `{w:4, h:4}` | `{w:3, h:3}` |
| `modems`         | `{w:4, h:4}` | `{w:3, h:3}` |
| `obs-controller` | `{w:6, h:6}` | `{w:4, h:4}` |
| `kick-stats`     | `{w:3, h:3}` | `{w:3, h:3}` |
| `kick-chat`      | `{w:3, h:8}` | `{w:3, h:4}` |

**Module authors must design cards to be responsive within `[minSize, maxSize]`.** The card's `view()` receives no size props — it must query its own container if it needs to adapt. Add a `ResizeObserver` example to `modules/README.md`.

---

## 4. Library Choice

**Use `gridstack.js`.** It is the only mature, framework-agnostic grid library that handles drag, resize, collision, and serialization together. Mithril integration is done via lifecycle hooks (§5). Version: pin `^11` or later.

Alternatives considered and rejected:

- `muuri` — excellent drag/drop but no grid resize/serialization.
- `react-grid-layout` / `dashcraft-core` — React-only, or headless in ways that require re-implementing collision.
- **Custom implementation** — viable, but ~600 lines to do collision, snap, resize handles, touch support, and persistence correctly. Only justified if gridstack's bundle size (≈ 60 KB gzip) is unacceptable. Do not go custom on v1.

---

## 5. Mithril + Gridstack Integration

Wrap gridstack in a Mithril component. The card components themselves are unaware of gridstack — the wrapper owns all layout interaction.

```ts
// public/ts/device/dashboard.ts
import m from "mithril";
import { GridStack } from "gridstack";
import "gridstack/dist/gridstack.min.css";
import { getModule } from "../../../modules/registry.frontend";
import { st } from "./store";
import { saveDashboardDebounced } from "./persistence";

export const Dashboard: m.Component<{ dashboard: Dashboard }> = {
  oncreate({ dom, attrs }) {
    const grid = GridStack.init(
      {
        column: attrs.dashboard.columns ?? 12,
        cellHeight: 60,
        margin: 8,
        float: false,
        disableDrag: true,
        disableResize: true,
        draggable: { handle: ".dash-widget-handle" },
      },
      dom as HTMLElement,
    );

    grid.load(
      attrs.dashboard.items.map(toGridstackNode),
      /* addAndRemove */ false,
    );
    grid.on("change", (_event, items) => {
      saveDashboardDebounced(attrs.dashboard.id, fromGridstackNodes(items));
    });

    (dom as any)._grid = grid;
    (dom as any)._gridSub = st.editMode.subscribe((mode) => {
      grid.enableMove(mode);
      grid.enableResize(mode);
    });
  },

  onupdate({ dom, attrs }) {
    const grid = (dom as any)._grid as GridStack;
    const incoming = attrs.dashboard.items.map(toGridstackNode);
    if (!grid.isAreaEmpty && sameLayout(grid.save(false), incoming)) return;
    grid.load(incoming, false);
  },

  onremove({ dom }) {
    (dom as any)._gridSub?.();
    (dom as any)._grid?.destroy(false);
  },

  view({ attrs }) {
    return m(
      "div.dashboard-grid.grid-stack",
      attrs.dashboard.items
        .filter((i) => i.visible && st.modules[i.moduleId]?.enabled)
        .map((item) => {
          const mod = getModule(item.moduleId);
          return m(
            "div.grid-stack-item",
            {
              "gs-id": item.moduleId,
              "gs-x": item.x,
              "gs-y": item.y,
              "gs-w": item.w,
              "gs-h": item.h,
              "gs-min-w": mod.minSize.w,
              "gs-min-h": mod.minSize.h,
              "gs-max-w": mod.maxSize?.w,
              "gs-max-h": mod.maxSize?.h,
            },
            [
              m("div.grid-stack-item-content.dash-widget", [
                m("header.dash-widget-handle", [
                  m("span.dash-widget-title", mod.title),
                  st.editMode() &&
                    m(
                      "button.dash-widget-remove",
                      {
                        onclick: () =>
                          removeWidget(attrs.dashboard, item.moduleId),
                      },
                      "×",
                    ),
                ]),
                m("div.dash-widget-body", m(mod.component)),
              ]),
            ],
          );
        }),
    );
  },
};
```

Key points:

- **`disableDrag` / `disableResize` start as `true`.** Edit mode toggles them. Read-only viewers get zero interaction.
- **`gs-id` is the module ID** — gridstack keys on it, so re-renders map cleanly to the same widget.
- **Only the header is the drag handle** (`.dash-widget-handle`), so the widget body stays interactive (buttons, chat scroll, etc.).
- **`onupdate` is defensive.** It only reloads if the incoming layout differs from the current one, otherwise Mithril's re-render would fight gridstack's drag state.

---

## 6. Inline Editor UX

The editor lives on the dashboard itself. No separate settings panel for layout.

**Header bar (above the grid):**

```
[ Dashboard name ▾ ]  [ + Add widget ]  [ Edit / Done ]
```

- **Dashboard name** — dropdown listing all dashboards + "New…" + "Rename…" + "Delete". This replaces the old "Dashboards" tab.
- **+ Add widget** — opens a small popover listing modules not yet on this dashboard. Clicking one appends it at the first free position with `defaultSize`.
- **Edit / Done** — toggles `st.editMode`. In edit mode, drag and resize are enabled and the header shows a "Saving…" / "Saved" indicator.

**Per-widget chrome (only in edit mode):**

- Drag handle is the whole header bar.
- Resize handle is gridstack's default bottom-right corner (`.ui-resizable-handle`), styled to match the theme.
- A `×` in the header removes the widget from the dashboard (does not disable the module).
- A small eye icon toggles `visible: false` — keeps position and size when re-shown.

**Exit edit mode** does not need a save button. Persistence happens continuously (debounced).

**Module configuration** (OBS URL, Kick channel, etc.) moves to a separate "Modules" settings panel — the one part of the old `dashboard-editor.ts` that survives. It is not part of the inline editor.

---

## 7. Persistence and Sync

**Save timing.** Debounce on gridstack's `change` event: 500 ms after the last drag/resize.

**Save payload.** `dashboards.update` sends the full item array with the current `version`.

**Server-side version check:**

```ts
if (incoming.version !== stored.version) {
  return reject(409, { current: stored });
}
stored.items = incoming.items;
stored.version += 1;
broadcast("dashboards.changed", stored);
```

**Conflict handling on the client:** on `409`, show a toast — _"Dashboard was edited by someone else. Reload?"_ — and stop auto-saving until the user reloads. Do not attempt merge. Dashboards are per-device and rarely edited concurrently; last-write-wins with a version guard is the right complexity level.

**Broadcast.** When any viewer saves, the device emits `dashboards.changed` with the new object. Every other browser replaces `st.dashboards[id]` and Mithril re-renders. Because `onupdate` diffs the layout, no flicker for unchanged widgets.

**Edit-mode indicator.** Emit an ephemeral `dashboards.editing` presence event (`{id, viewerCount}`) so a viewer sees "2 people editing" and can decide to back off. Do not block editing — presence is informational only.

---

## 8. CSS

`public/ts/device/dashboard.css` — global, not module-scoped (it's the shell, not a module).

```css
.dashboard-grid {
  --dash-row-h: 60px;
}
.dash-widget {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  overflow: hidden;
}
.dash-widget-handle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 8px;
  cursor: default;
  user-select: none;
}
body.dash-edit .dash-widget-handle {
  cursor: grab;
}
body.dash-edit .dash-widget {
  outline: 1px dashed var(--color-accent);
}
.dash-widget-body {
  flex: 1;
  overflow: auto;
}
```

Gridstack's own CSS (`gridstack.min.css`) is imported once from `dashboard.ts`. Override its `.ui-resizable-handle` styles to match the theme.

---

## 9. Verification Checklist

**Structural**

- [ ] `DashboardItem` uses `{x, y, w, h}`; no `order` or `width` field remains.
- [ ] `BrowserModule` uses `defaultSize` / `minSize` / `maxSize`; no `defaultWidth`.
- [ ] `dashboard-editor.ts` is deleted; its "Modules" role moves to a `modules-settings.ts` panel.
- [ ] `gridstack` is a dependency; version pinned.

**Grid behavior**

- [ ] Drag a widget; it snaps to the grid and other widgets reflow.
- [ ] Resize a widget; it respects `minSize` and `maxSize`.
- [ ] Removing a widget leaves its module enabled; re-adding restores it at a fresh position.
- [ ] A widget with `visible: false` is hidden but keeps its `{x, y, w, h}`.
- [ ] A module disabled at the device level does not render, even if present in `items`.

**Edit mode**

- [ ] Edit toggle enables drag/resize; Done disables them.
- [ ] In read-only mode, widgets cannot be dragged or resized.
- [ ] The widget body is fully interactive in both modes (buttons click, chat scrolls).
- [ ] Only the header bar initiates drag.

**Persistence & sync**

- [ ] Drag → wait 500 ms → `dashboards.update` fires once.
- [ ] Reload the page; layout is identical.
- [ ] Open two browsers; move a widget in one; the other updates within ~1 s.
- [ ] Simultaneous edit in two browsers triggers `409` on the second; a reload toast appears; no data corruption.
- [ ] `dashboards.changed` does not cause a full re-mount of unchanged widgets.

**Migration**

- [ ] A v1 dashboard (ordered list) loads cleanly, converts to v2, and saves back.
- [ ] A v2 dashboard is never misinterpreted as v1.

**Runtime**

- [ ] Gridstack's bundle adds ≤ 70 KB gzip to the frontend.
- [ ] No Mithril-side memory leak on repeated edit-mode toggles (`onremove` cleans listeners).

---

## 10. Anti-Patterns

- **Do not** put layout logic in module `frontend.ts` files. Modules render content; the dashboard shell owns positioning.
- **Do not** save on every `change` event — debounce. A drag emits dozens of `change` events per second.
- **Do not** auto-merge conflicting dashboard edits. Reject and reload.
- **Do not** hardcode pixel positions. Everything is grid units; the shell converts.
- **Do not** make the entire widget draggable. The header is the handle; the body is interactive.
- **Do not** render a module that is not enabled at the device level, even if listed in `items`. Filter at render time (see `view()` in §5).
- **Do not** attempt to make gridstack a Mithril component library. It is imperative DOM; wrap it, do not virtualize it.
- **Do not** ship a custom drag implementation on v1. Revisit only if gridstack's weight is a proven problem.

---

## 11. Definition of Done

1. Dashboards render on a 12-column grid with `{x, y, w, h}` positioning.
2. Inline edit mode toggles drag and resize without a page reload.
3. Layout auto-saves on drag/resize stop, with a version guard.
4. Multiple viewers stay in sync via `dashboards.changed`.
5. `dashboard-editor.ts` is gone; only the Modules settings panel remains.
6. Every existing module's card renders correctly at its `minSize`.
7. Verification checklist (§9) fully checked.
