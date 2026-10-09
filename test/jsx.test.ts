import { describe, expect, test } from "bun:test";
import m from "mithril";
import { asJSX, pum } from "../public/ts/jsx";

describe("Mithril JSX adapters", () => {
	test("asJSX creates an object component whose view receives current attrs and children", () => {
		const Component = asJSX<{ label: string }>((v) => [
			m("span", v.attrs.label),
			v.children,
		]);
		const child = m("em", "child");
		const vnode = m(Component, { label: "initial" }, child);
		const tag = vnode.tag;
		if (typeof tag === "string" || typeof tag === "function") {
			throw new Error("Expected an object component with a view, not a bare view function");
		}
		expect(typeof tag.view).toBe("function");
		expect(tag.view(vnode)).toEqual([m("span", "initial"), [child]]);

		const newChild = m("em", "new child");
		const updated = m(Component, { label: "updated" }, newChild);
		expect(tag.view(updated)).toEqual([m("span", "updated"), [newChild]]);
	});

	test("pum preserves the original component and its lifecycle hooks", () => {
		const component: m.Component<{ label: string }> = {
			oninit: () => {},
			view: (v) => m("span", v.attrs.label, v.children),
		};
		const Component = pum(component);
		const vnode = m(Component, { label: "library" }, "child");
		expect(vnode.tag).toBe(component);
	});
});
