// d.ts for PO module imports (value: file path under Bun, asset URL when bundled).
declare module "*.po" {
	const ref: string; // file path or asset URL — see loadPO in src/i18n.ts
	export default ref;
}
