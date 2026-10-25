import { defineConfig } from 'tsup';

export default defineConfig({
    entry: ['src/index.ts'],
    format: ['esm'],
    dts: true,
    clean: true,
    // vendor/ is the Rust build fetched from MapConductor/vectortile's release.
    // It ships next to dist/ as it is: it finds its worker and wasm relative to
    // its own files (`new URL('./worker.js', import.meta.url)`), which bundling
    // would break.
    external: [/\/vendor\//, '@mapconductor/js-sdk-core'],
});
