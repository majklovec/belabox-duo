/** Bun lowers component tags to m(), which accepts Mithril view objects. */
export type MithrilJSXComponent<Attrs = {}, State = {}> = import("mithril").Component<Attrs, State> &
	((attrs: Attrs & { children?: import("mithril").Children }) => import("mithril").Vnode);
