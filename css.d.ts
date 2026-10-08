/* Module styles.css files are side-effect imports: Bun's bundler emits them into
 * the page (see the HTML entrypoints in api.ts / server.ts). Declaration only so
 * `tsc --noEmit` accepts the import. */
declare module "*.css";
