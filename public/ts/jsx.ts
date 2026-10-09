/* Bridges Mithril's object components and TypeScript's JSX props checking. */
import type m from "mithril";

export type JSXComponent<A> = m.Component<A> & ((props: A) => m.Vnode);

/** Bare view functions must be wrapped: Mithril calls function tags as component factories. */
export const asJSX = <A,>(fn: (v: m.Vnode<A>) => m.Vnode | m.Children): JSXComponent<A> =>
	pum({ view: fn });

/** panda-ui-mithril components are `m.Component` objects with a `view`; mithril's
 * renderer handles them natively, JSX type-checking only needs a props call. */
export const pum = <A,>(c: m.Component<A>): JSXComponent<A> => c as JSXComponent<A>;
