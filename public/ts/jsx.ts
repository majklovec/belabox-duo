/* Bridges between Mithril's function-component convention (called with the vnode) and
 * TypeScript's JSX type checking (treats the first parameter as the props type). */
import type m from "mithril";

export type JSXComponent<A> = (props: A) => m.Vnode;

/** App function components (mithril renders them with the vnode). */
export const asJSX = <A,>(fn: (v: m.Vnode<A>) => m.Vnode | m.Children): JSXComponent<A> =>
	fn as unknown as JSXComponent<A>;

/** panda-ui-mithril components are `m.Component` objects with a `view`; mithril's
 * renderer handles them natively, JSX type-checking only needs a props call. */
export const pum = <A,>(c: m.Component<A>): JSXComponent<A> => c as unknown as JSXComponent<A>;
