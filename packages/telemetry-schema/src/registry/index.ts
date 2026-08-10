/**
 * The registries alone — no protobuf runtime, no crypto, no compression.
 *
 * A separate entry point because the renderer needs the id tables and nothing else. Importing the
 * package root there would pull `@bufbuild/protobuf`, three `@noble` libraries and `fflate` into
 * the web bundle, to obtain what is ultimately a few hundred integers. Worse, it would ship a
 * cryptography stack to the GitHub Pages build, which by design collects nothing and must have no
 * telemetry machinery in it at all.
 *
 * Import from `@jobmonitor/telemetry-schema/registry` in the renderer; the root export is for the
 * main process and the receiver, which do the encoding.
 */

export { Feature, Features, FEATURE_DEFS } from './features';
export { Operation, Operations, OPERATION_DEFS } from './operations';
export { ErrorCategory, ErrorCategories, ERROR_CATEGORY_DEFS } from './errorCategories';
export { buildRegistry, idEnum } from './registry';
export type { Def, Registry, IdOf } from './registry';
