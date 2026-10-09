/* Panda CSS pipeline: the design system comes from `panda-ui-mithril/preset`
 * (bundled to .panda-dist by scripts/gen-panda-preset.ts). We only run `cssgen`
 * (no codegen): the app imports pum components directly, so the only artifact
 * needed is the stylesheet — generated into public/css/panda/styles.css.
 *
 * @pandacss/* is pinned to 1.12.1: pum (0.6.0)'s peer range is
 * `^0.53.0 || ^1.0.0`, and 1.x is the line its recipe CSS output was built
 * against. */
import { defineConfig, defineRecipe } from "@pandacss/dev";
import pandaPreset from "@pandacss/preset-panda";
import { pumPreset } from "./.panda-dist/pum-preset.js";

// `input` is a reserved keyword in pum's preset and the library ships no
// input recipe, so the app's bound <input> elements attach this recipe
// (variant classes extend it the same way: `input input--size_sm`).
const inputRecipe = defineRecipe({
	className: "input",
	base: {
		display: "inline-flex",
		alignItems: "center",
		width: "clamp(3rem, 20rem, 100%)",
		height: "token(spacing.10)",
		radius: "token(radii.md)",
		border: "1px solid token(colors.neutral)",
		bg: "token(colors.base-200)",
		color: "token(colors.base-content)",
		transition: "border 150ms ease",
		"&:focus-visible": {
			outline: "none",
			borderColor: "token(colors.primary)",
		},
	},
	variants: {
		size: {
			sm: { height: "token(spacing.9)" },
			md: {},
			lg: { height: "token(spacing.12)" },
		},
		color: {
			null: {},
			nonNull: { border: "1px solid token(colors.error)" },
		},
	},
});

export default defineConfig({
	presets: [pandaPreset, pumPreset],
	outdir: "public/css/panda",
	syntax: "object-literal",
	preflight: true,
	jsxFramework: "mithril",
	importMap: {
		// Matches the raw import specifier (`import { css } from "styled-system/css"`):
		// the matcher does `importSpecifier.includes(entry)`, and bun/tsconfig path
		// aliases resolve the specifier to this outdir at build/run time.
		css: ["styled-system/css"],
		jsx: ["mithril"],
	},
	include: ["./public/ts/**/*.{ts,tsx}", "./modules/**/*.tsx"],
	theme: {
		extend: {
			semanticTokens: {
				colors: {
					primary: { value: "var(--dev-accent)" },
					"primary-content": { value: "#10131a" },
					accent: { value: "var(--dev-accent)" },
					"accent-content": { value: "#10131a" },
					primarySubtle: { value: "var(--dev-accent)" },
					"primarySubtle-content": { value: "#10131a" },
				},
			},
		},
	},
	recipes: {
		input: inputRecipe,
	},
	// The app attaches recipe class names as plain strings (`class="input"`,
	// pum's component classNames), so extract-from-usage would miss them —
	// emit every recipe (pum's + the input one) unconditionally.
	staticCss: { recipes: "*" },
	globalCss: {
		body: {
			backgroundColor: "var(--colors-base-100)",
			color: "var(--colors-base-content)",
		},
		// pum's dark branch is scoped to [data-theme="dark"]; set it by default
		// so the UI renders dark without requiring a runtime call.
		"html": {
			"&:not([data-theme])": {
				"--colors-base-100": "#1d232a",
				"--colors-base-200": "#191e24",
				"--colors-base-300": "#15191e",
				"--colors-base-content": "oklch(80% 0.008 285.885)",
				"--colors-neutral": "#a3a6ad",
			},
		},
		// GridStack owns the widget item + resize handle; .dash-widget fills it.
		".dash-widget": {
			height: "100%",
			display: "flex",
			flexDirection: "column",
			minHeight: "0px",
			backgroundColor: "color-mix(in srgb, var(--colors-base-200) 92%, var(--colors-base-300))",
			border: "1px solid var(--border, color-mix(in srgb, var(--colors-neutral) 14%, #262b36))",
			borderRadius: "var(--radius, 0.75rem)",
			overflow: "hidden",
			minWidth: "0px",
		},
	},
});
