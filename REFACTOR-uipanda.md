Here is the updated AI handoff. It now explicitly requires auditing **every** component and converting **all** of them to JSX, not just the ones that use PandaUI.

---

# AI Handoff: Refactor belabox-duo to PandaUI + lucide-mithril (Bun + JSX)

## 1. Objective

Refactor `https://github.com/majklovec/belabox-duo` so that:

- **Every** component in the codebase is audited and converted to **JSX** — including components that are not being replaced by PandaUI. No component may remain in `m()` hyperscript form.
- All custom UI components are replaced with components from `panda-ui-mithril`.
- All icons are replaced with components from `lucide-mithril` (`carlos-sweb/lucide-mithril`).
- The project uses **Bun** as the runtime, package manager, and bundler. No Babel or Vite.

Do not change business logic. Only refactor the UI layer, the JSX syntax, and build configuration.

## 2. Scope: Convert ALL Components to JSX

This is a hard requirement, not a suggestion. The refactor is **not complete** until:

1. Every `view` function in the project returns JSX, not `m()` calls.
2. Every custom component (whether or not it is being replaced by PandaUI) has been rewritten in JSX.
3. Every nested `m()` call inside a view — including wrappers, fragments, conditional children, and lists — is expressed in JSX.
4. No file in `src/` contains `m('...')` or `m(Component, ...)` as a rendering call, except where an `m()` call is required by an API that specifically demands it (e.g., some library hooks or `m.redraw`). Those exceptions must be documented.

**Rule of thumb:** if a file has a `view` method, that method must be JSX.

This includes:

- View components (`src/views/`, `src/pages/`)
- Reusable UI components (`src/components/`, `src/ui/`)
- Layout components (headers, footers, sidebars)
- Route targets and route resolvers that render views
- Any inline/anonymous views passed to `m.route`, `m.render`, or `m.mount`

## 3. Prerequisites & Installation

Use https://github.com/carlos-sweb/panda-ui-mithril/blob/master/llms.txt

Install dependencies using Bun:

```bash
bun add panda-ui-mithril mithril
bun add -d @pandacss/dev @pandacss/preset-panda
bun add lucide-mithril
```

If the lucide-mithril package is scoped, adjust accordingly (e.g. `@carlos-sweb/lucide-mithril` or `@levitatingorange/lucide-mithril`). The `@levitatingorange/lucide-mithril` package exports all Lucide icons as Mithril vnodes embedded in hyperscript.

Initialize Panda CSS:

```bash
bunx panda init --preset @pandacss/preset-panda
```

The `panda-ui-mithril` library provides a `bunx panda-ui-mithril init` command that creates a `pum/` folder with an editable theme, writes `panda.config.ts`, and configures the Mithril JSX transform for Bun.

## 4. Configure JSX for Mithril with Bun

Bun has built-in JSX and TSX support and reads `tsconfig.json`, `jsconfig.json`, or `bunfig.toml` to determine the JSX transform.

### Option A: tsconfig.json (Recommended for TypeScript projects)

```json
{
  "compilerOptions": {
    "jsx": "react",
    "jsxFactory": "m",
    "jsxFragmentFactory": "m.Fragment"
  }
}
```

This is the standard configuration for Mithril with TypeScript.

### Option B: bunfig.toml (For non-TypeScript projects)

```toml
jsx = "react"
jsxFactory = "m"
jsxFragment = "m.Fragment"
```

### JSX Pragma (Per-File)

You can also set the JSX factory per file using a pragma comment:

```js
/** @jsx m */
/** @jsxFrag m.Fragment */
import m from "mithril";
```

### Important: Import `m` in Every JSX File

Even with the global JSX factory configured, Bun requires that the `m` function be available in every JSX file. Import it explicitly:

```js
import m from "mithril";
```

Mithril event attributes are lowercase: `onclick`, `oninput`, `onchange`, etc.

## 5. Full Component Audit

Before writing any code, produce a complete inventory of every component in the repository.

### 5.1 Locate All Components

Search the entire `src/` tree for files that:

- Export an object with a `view` method (classic Mithril component)
- Export a function returning a vnode
- Use `m(...)` in a render path
- Contain inline JSX or hyperscript views

Suggested commands:

```bash
# Find all files with a view method
grep -rn "view(" src/ --include="*.js" --include="*.ts" --include="*.jsx" --include="*.tsx"

# Find all files that call m()
grep -rn "m(" src/ --include="*.js" --include="*.ts" --include="*.jsx" --include="*.tsx"

# List all custom UI/component files
find src -type d \( -name components -o -name ui -o -name views -o -name pages \)
```

### 5.2 Audit Table

For every file found, record the following. This table drives the refactor.

| File                           | Type (view / component / layout / route) | Uses custom UI?         | Uses icons?        | PandaUI target(s)            | lucide-mithril target(s) | JSX status |
| ------------------------------ | ---------------------------------------- | ----------------------- | ------------------ | ---------------------------- | ------------------------ | ---------- |
| `src/views/Home.js`            | view                                     | yes (`Button`, `Card`)  | yes (`camera.svg`) | `Button`, `Card`, `CardBody` | `Camera`                 | ☐          |
| `src/components/Header.js`     | layout                                   | no                      | yes (gear)         | —                            | `Settings`               | ☐          |
| `src/components/StreamForm.js` | component                                | yes (`Input`, `Button`) | no                 | `Input`, `Button`, `Field`   | —                        | ☐          |
| `src/routes.js`                | route                                    | no                      | no                 | —                            | —                        | ☐          |

Every row must end with `JSX status = ✅` before the refactor is considered complete.

### 5.3 Definition of Done for the Audit

- Every `.js` / `.ts` file with a `view` method is listed.
- Every custom component under `src/components/` or `src/ui/` is listed.
- Every icon usage is listed.
- Every row has a PandaUI / lucide-mithril target (or `—` if none applies).
- Every row has been converted to JSX.

## 6. Mapping Table

Adjust names to match the actual library exports.

| Custom Component / Icon  | PandaUI / lucide-mithril Replacement                                                    | Import                                                          |
| ------------------------ | --------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `Button.js`              | `Button`                                                                                | `import { Button } from 'panda-ui-mithril';`                    |
| `Card.js`                | `Card`, `CardTitle`, `CardBody`                                                         | `import { Card, CardTitle, CardBody } from 'panda-ui-mithril';` |
| `Alert.js`               | `Alert`                                                                                 | `import { Alert } from 'panda-ui-mithril';`                     |
| `Input.js`               | `Input`                                                                                 | `import { Input } from 'panda-ui-mithril';`                     |
| `Modal.js`               | `Dialog` or `Modal`                                                                     | `import { Dialog } from 'panda-ui-mithril';`                    |
| `Tabs.js`                | `Tabs`                                                                                  | `import { Tabs } from 'panda-ui-mithril';`                      |
| `Badge.js`               | `Badge`                                                                                 | `import { Badge } from 'panda-ui-mithril';`                     |
| Inline SVG / custom icon | `Camera`, `Settings`, `Play`, `Square`, `Wifi`, `Battery`, `User`, `Menu`, `X`, `Check` | `import { Camera } from 'lucide-mithril';`                      |

If a custom component has no PandaUI equivalent, compose it from PandaUI primitives (`Box`, `Flex`, `Stack`, `Grid`) and still convert it to JSX.

## 7. Refactoring Examples (JSX with Bun)

### 7.1 Custom Button → PandaUI Button

**Before (custom component + hyperscript):**

```js
import m from "mithril";

const Button = {
  view: ({ attrs, children }) => m("button.custom-btn", attrs, children),
};
```

**After (PandaUI + JSX):**

```jsx
import m from "mithril";
import { Button } from "panda-ui-mithril";

export const MyView = {
  view: () => (
    <Button variant="primary" size="md" onclick={handleClick}>
      Click me
    </Button>
  ),
};
```

### 7.2 Inline SVG → lucide-mithril

**Before:**

```js
m("svg", { width: 24, height: 24, viewBox: "0 0 24 24" }, [
  m("path", { d: "..." }),
]);
```

**After:**

```jsx
import m from "mithril";
import { Camera } from "lucide-mithril";

export const CameraIcon = {
  view: () => <Camera size={24} />,
};
```

> If `lucide-mithril` exports vnodes directly instead of components, use `{Camera}` rather than `<Camera />`.

### 7.3 Full Component Refactor

**Before:**

```js
const StatusCard = {
  view: ({ attrs }) =>
    m("div.card", [
      m("h3", attrs.title),
      m("p", attrs.message),
      m("button.btn", { onclick: attrs.onRetry }, "Retry"),
    ]),
};
```

**After:**

```jsx
import m from "mithril";
import { Card, CardTitle, CardBody, Button, Alert } from "panda-ui-mithril";
import { RefreshCw } from "lucide-mithril";

export const StatusCard = {
  view: ({ attrs }) => (
    <Card>
      <CardTitle>{attrs.title}</CardTitle>
      <CardBody>
        <Alert status={attrs.status}>{attrs.message}</Alert>
        <Button variant="primary" onclick={attrs.onRetry}>
          <RefreshCw size={16} /> Retry
        </Button>
      </CardBody>
    </Card>
  ),
};
```

### 7.4 Component With No Custom UI (Still Must Become JSX)

Even if a component has no custom UI and no icons, it must still be converted to JSX.

**Before:**

```js
const Layout = {
  view: ({ children }) =>
    m("div.layout", [m("header", m("h1", "BelaBox Duo")), m("main", children)]),
};
```

**After:**

```jsx
import m from "mithril";

export const Layout = {
  view: ({ children }) => (
    <div class="layout">
      <header>
        <h1>BelaBox Duo</h1>
      </header>
      <main>{children}</main>
    </div>
  ),
};
```

### 7.5 Fragments and Lists in JSX

**Before:**

```js
m(
  "ul",
  items.map((item) => m("li", { key: item.id }, item.label)),
);
```

**After:**

```jsx
<ul>
  {items.map((item) => (
    <li key={item.id}>{item.label}</li>
  ))}
</ul>
```

**Fragments:**

```jsx
<>
  <Header />
  <Main />
</>
```

## 8. Bun-Specific Build & Run Commands

### package.json scripts

```json
{
  "scripts": {
    "dev": "bun run --watch src/index.tsx",
    "build": "bun build src/index.tsx --outdir dist --minify",
    "start": "bun run src/index.tsx",
    "panda": "bunx panda",
    "prepare": "bunx panda codegen"
  }
}
```

### Panda CSS Build

```bash
bunx panda codegen
```

This generates the CSS utilities. The `prepare` script ensures it runs after install.

### Bun Build

Bun's built-in bundler handles JSX transpilation without Babel or Vite:

```bash
bun build ./src/index.tsx --outdir ./dist --minify
```

## 9. Execution Steps

1. Install dependencies with `bun add` (see Section 3).
2. Initialize Panda CSS with `bunx panda init --preset @pandacss/preset-panda`.
3. Run `bunx panda-ui-mithril init` to auto-configure the Mithril JSX transform and create the theme folder.
4. Verify `tsconfig.json` or `bunfig.toml` contains the correct JSX factory settings.
5. **Run the full component audit (Section 5) and fill in the audit table.**
6. **Convert every component in the audit table to JSX — even those with no custom UI or icons.**
7. Replace custom components with PandaUI equivalents, one by one, starting with the most-used ones (`Button`, `Card`, `Alert`, `Input`).
8. Replace all icons with `lucide-mithril` components.
9. Remove unused custom component and icon files.
10. Clean up custom CSS that targeted old components.
11. Run `bun run dev` and verify visual/functional parity.

## 10. Migration Checklist

- [ ] Dependencies installed with `bun add`.
- [ ] Panda CSS initialized with `bunx panda init`.
- [ ] JSX configured for Mithril in `tsconfig.json` or `bunfig.toml`.
- [ ] `import m from 'mithril';` present in all JSX files.
- [ ] **Full component audit completed (Section 5.2 table filled).**
- [ ] **Every component converted to JSX — including those with no custom UI.**
- [ ] **No remaining `m('...')` render calls outside documented exceptions.**
- [ ] Custom components replaced with PandaUI.
- [ ] All icons replaced with lucide-mithril.
- [ ] Unused custom files removed.
- [ ] Custom CSS cleaned up.
- [ ] `bun run dev` starts without errors.
- [ ] `bun build` succeeds.
- [ ] Visual and functional tests pass.

## 11. Verification: Grep-Based Checks

Before declaring the refactor complete, run these checks and confirm they return only documented exceptions:

```bash
# Any leftover hyperscript renders?
grep -rn "m('" src/ --include="*.js" --include="*.ts" --include="*.jsx" --include="*.tsx"
grep -rn 'm("' src/ --include="*.js" --include="*.ts" --include="*.jsx" --include="*.tsx"

# Any leftover custom UI imports?
grep -rn "from '.*components/" src/
grep -rn "from '.*ui/" src/

# Any leftover inline SVGs?
grep -rn "<svg" src/ --include="*.js" --include="*.ts" --include="*.jsx" --include="*.tsx"

# Files still missing the mithril import but containing JSX?
grep -rLn "from 'mithril'" src/ --include="*.jsx" --include="*.tsx"
```

Any hit must either be fixed or explicitly documented as an allowed exception (for example, an `m()` call required by a library API).

## 12. Notes for the AI Agent

- **Convert everything to JSX.** A component is not "done" if it still uses `m()` for rendering, even if it has no custom UI or icons.
- Prefer JSX over `m()` for all new and refactored views.
- Use lowercase Mithril event attributes: `onclick`, `oninput`, `onchange`.
- If a PandaUI component does not exist for a custom one, compose it using PandaUI primitives such as `Box`, `Flex`, or `Stack` — and still write it in JSX.
- Use Panda CSS `css()` for any custom styling needed alongside PandaUI.
- Verify exact import paths, component names, and prop APIs from the target repositories before bulk-replacing.
- Do not alter business logic; keep the refactor scoped to the UI layer, JSX syntax, and build configuration.
- The `panda-ui-mithril init` command handles the Mithril JSX transform configuration automatically, so run it early in the process.

---

This handoff is ready to be given to an AI coding agent. It uses Bun for all tooling, configures JSX for Mithril natively, requires a full component audit with every component converted to JSX, and includes concrete before/after examples, grep-based verification, and a final checklist.
