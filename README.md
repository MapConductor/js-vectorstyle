# @mapconductor/js-vectorstyle

Declarative adjustments to a MapLibre style — recolour roads, hide labels, tint
water — applied as a MapConductor map's appearance.

```ts
import { buildStyleRules, createVectorStyle, LayerRole } from '@mapconductor/js-vectorstyle';

const rules = buildStyleRules((rules) => {
    rules.role(LayerRole.label, { visible: false });
    rules.role(LayerRole.road, { color: '#d0d0d0', widthScale: 1.4 });
});

// Hand the result to the map as its style (in React, `<MapView mapStyle={style}>`).
const style = createVectorStyle({ document: 'currentDesign', rules });
```

It has no framework dependency, only `@mapconductor/js-sdk-core`.

## Where it applies

- **Maps that draw MapLibre styles themselves** (MapLibre, Mapbox and MapTiler)
  take the adjustment in place, without reloading the map.
- **Every other map** draws it through
  [`@mapconductor/react-vectortile`](https://github.com/MapConductor/react-vectortile),
  which renders the style to raster tiles and compiles the rules with this
  package.

## The compiler

The rules are compiled by a Rust/wasm build from
[MapConductor/vectortile](https://github.com/MapConductor/vectortile), shipped
inside this package under `vendor/`. `npm run build` fetches it from the release
pinned in `scripts/vector-assets.json` and checks its SHA-256. To use a local
build instead, set `MAPCONDUCTOR_VECTORTILE_DIR` to a checkout of
mapconductor-vectortile.

## Development

This repository is a submodule of
[react-sdk](https://github.com/MapConductor/react-sdk), which links it with
`@mapconductor/js-sdk-core` as an npm workspace. Build and test it from there:
it needs the style API of the js-sdk-core in that workspace, which is newer than
the one on npm.

```sh
# in react-sdk
npm test --workspace @mapconductor/js-vectorstyle   # builds first
```

The public API is frozen in `api/js-vectorstyle.api.d.ts`; react-sdk's
`node scripts/api-surface.mjs check` compares against it.
