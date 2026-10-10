import { MapStyleHost, MapViewStyle } from '@mapconductor/js-sdk-core';
import { StyleAffects } from '@mapconductor/vectorstyle';

/**
 * What to change about a style, and where.
 *
 * ```ts
 * const rules = buildStyleRules((r) => {
 *     r.all({ color: '#000000' });
 *     r.role(LayerRole.label, { visible: false });
 *     r.role(LayerRole.roadCasing, { color: '#303030' });
 *     r.role(LayerRole.road, { color: '#ffffff', widthScale: 1.3 });
 * });
 * ```
 *
 * Rules apply in order and override each other property by property, the way
 * CSS does: the last rule to name a colour wins, and a rule that says
 * nothing about width leaves the width alone. Reordering the two road rules
 * above gives a different map, which is the point — only the app knows
 * whether the casings should keep their own colour.
 *
 * ## It is JSON underneath, on purpose
 *
 * `json` is the real definition, not a serialisation of the builder. The
 * same text is what the compiler reads on Android, iOS and the web, so a
 * rule set can be written by hand, stored, shipped from a server, or diffed
 * between two versions of an app — and {@link parseStyleRules} takes it
 * straight back. The builder is sugar over that, there so the common case is
 * checked by the compiler rather than by a typo.
 *
 * Nothing is validated here. A rule set is checked when it is compiled
 * against a style, which is the only place that can tell whether
 * `role('road')` means anything.
 */
interface StyleRules {
    /** The canonical form. */
    readonly json: string;
}
/** No adjustments: the style as its author wrote it. */
declare const NO_STYLE_RULES: StyleRules;
/**
 * Takes a rules document as it stands.
 *
 * Not checked here — a document is checked when it is compiled against a
 * style, and the compiler reports then.
 */
declare function parseStyleRules(json: string): StyleRules;
/**
 * The roles the built-in schema profiles assign.
 *
 * Open strings rather than a closed union: a style cut to a schema nobody
 * here has heard of can name its own roles through `customSchema`, and
 * adding a role to the built-in tables must not be a breaking change on
 * three platforms.
 */
declare const LayerRole: {
    readonly background: "background";
    readonly water: "water";
    readonly waterway: "waterway";
    readonly land: "land";
    readonly landuse: "landuse";
    readonly park: "park";
    readonly building: "building";
    readonly road: "road";
    /**
     * The wide dark line drawn under a road to give it an edge.
     *
     * A style draws every road twice, and "make roads white" applied to both
     * halves gives a white slab rather than a road. Nothing in the tile
     * distinguishes them — only the layer's name does — so this is the one
     * role decided by a naming convention, and the compiler reports how many
     * layers it found.
     */
    readonly roadCasing: "road-casing";
    readonly rail: "rail";
    readonly transit: "transit";
    readonly boundary: "boundary";
    readonly aeroway: "aeroway";
    readonly label: "label";
    readonly poi: "poi";
};
/** A style layer's `type`. */
type StyleLayerKind = 'background' | 'fill' | 'line' | 'circle' | 'symbol' | 'other';
/** Which layers a rule reaches. */
type StyleSelector = 'all'
/** What the layer *is*, across schemas that name their sources differently. */
 | {
    readonly role: string;
}
/** The layer's `id`, as a glob: `*` for any run, `?` for one character. */
 | {
    readonly layerId: string;
} | {
    readonly sourceLayer: string;
} | {
    readonly kind: StyleLayerKind;
} | {
    readonly anyOf: readonly StyleSelector[];
} | {
    readonly allOf: readonly StyleSelector[];
} | {
    readonly not: StyleSelector;
};
/** A function of the colour already there, for what a literal cannot express. */
type StyleColorFilter = {
    readonly desaturate: number;
} | {
    readonly darken: number;
} | {
    readonly lighten: number;
} | {
    readonly invertLightness: true;
} | {
    readonly mix: {
        readonly color: string;
        readonly amount?: number;
    };
};
/** What to change about the layers a selector matched. */
interface StylePatch {
    /** `layout.visibility`. */
    readonly visible?: boolean;
    /**
     * The layer's colour, whichever property that is for its type:
     * `fill-color` on a fill, `line-color` on a line, `text-color` and
     * `icon-color` on a symbol, `background-color` on the background.
     *
     * Any CSS colour the style spec accepts.
     */
    readonly color?: string;
    readonly colorFilter?: StyleColorFilter;
    /** `*-opacity`, 0 to 1. */
    readonly opacity?: number;
    /**
     * Multiplies how fat the layer is drawn: `line-width` on a line,
     * `circle-radius` on a circle.
     *
     * A multiplier rather than a value because the width is almost always an
     * expression over zoom, and replacing it with a number would throw that
     * curve away.
     */
    readonly widthScale?: number;
    /** Replaces the layer's filter, as a MapLibre filter expression. */
    readonly filter?: unknown;
    readonly minZoom?: number;
    readonly maxZoom?: number;
    /**
     * Any style-spec property by name. The last word: applied after
     * everything above, including over a `color` in the same rule.
     *
     * The escape hatch for what the fields above do not name —
     * `text-field`, `fill-pattern`, `line-dasharray`, a `fill-extrusion`
     * height. A property the SDK's own rasteriser cannot draw will show only
     * on a map that renders the style itself; the compiler says so.
     */
    readonly properties?: Readonly<Record<string, unknown>>;
}
/** Writes the `rules` array. */
interface StyleRulesBuilder {
    /**
     * Which tile schema the style's `source-layer` names come from.
     *
     * Left alone it is worked out from the style, which is right for
     * OpenMapTiles, Shortbread and Mapbox Streets.
     */
    schema(name: string): void;
    /** Teaches the compiler a schema of your own: role name to `source-layer` names. */
    customSchema(roles: Readonly<Record<string, readonly string[]>>): void;
    all(patch: StylePatch): void;
    role(role: string, patch: StylePatch): void;
    layerId(glob: string, patch: StylePatch): void;
    sourceLayer(name: string, patch: StylePatch): void;
    kind(kind: StyleLayerKind, patch: StylePatch): void;
    /** For a selector built by hand: `allOf`, `not` and friends. */
    where(selector: StyleSelector, patch: StylePatch): void;
}
/** Writes a rules document with the type checker checking the shape. */
declare function buildStyleRules(block: (rules: StyleRulesBuilder) => void): StyleRules;

/** Which style the rules are applied to. */
type VectorStyleSource = 
/** The document itself. The app already has it. */
{
    readonly text: string;
}
/**
 * A `style.json` to fetch.
 *
 * Fetched by this module rather than by the map, because the rules have
 * to be compiled against it before the map is given anything.
 */
 | {
    readonly url: string;
    readonly headers?: Readonly<Record<string, string>>;
}
/**
 * Whatever the map is already drawing.
 *
 * For adjusting a basemap the app did not supply. The module reads the
 * design's style URL from the host and fetches it; a backend that has no
 * such thing cannot be adjusted this way and says so.
 */
 | 'currentDesign';
/**
 * What to do about an adjustment the map would not take.
 *
 * `'report'` says so and leaves the rest applied — the default, because the
 * alternative makes the map reload, and not reloading is the point.
 * `'reload'` hands the map the adjusted document instead, which is correct
 * and expensive.
 */
type UnsupportedPolicy = 'report' | 'reload';
/** Draws a style the map cannot read itself. Implemented by the vector tile module. */
interface VectorStyleRasteriser {
    install(host: MapStyleHost, styleJson: string, affects: StyleAffects): VectorStyleRasterisation;
}
/** A rasteriser's work in progress. */
interface VectorStyleRasterisation {
    /**
     * Draws a different style with the same tiles. The geometry has not
     * changed, only the paint over it, so this costs a re-rasterise and no
     * network.
     */
    restyle(styleJson: string, affects: StyleAffects): void;
    dispose(): void;
}
interface VectorStyleOptions {
    /** Which style to adjust. Defaults to whatever the map is already drawing. */
    readonly document?: VectorStyleSource;
    readonly rules?: StyleRules;
    /**
     * Draws the style for a backend that cannot read one.
     *
     * `@mapconductor/react-vectortile` supplies one. Left out, a map without
     * vector style support is told so in the diagnostics rather than left
     * blank — there is nothing sensible this can do on its own.
     */
    readonly rasteriser?: VectorStyleRasteriser;
    readonly onUnsupported?: UnsupportedPolicy;
    readonly onDiagnostics?: (diagnostics: readonly string[]) => void;
    /** Where the compiler's `.wasm` is served from, if not the default. */
    readonly wasmUrl?: string | URL;
}
/**
 * A vector style, with adjustments, as the map's appearance.
 *
 * ```tsx
 * <MapLibreView state={state} style={createVectorStyle({ rules })} />
 * ```
 *
 * What happens underneath depends on the backend, and the app does not have
 * to know:
 *
 * - **A map that reads vector styles** (MapLibre, Mapbox, MapTiler) is given
 *   the document and told the per-layer differences. Changing the rules
 *   later sends new differences and **reloads nothing** — which is the whole
 *   reason the adjustments are compiled into deltas as well as a document.
 * - **A map that cannot** (Google Maps, Leaflet, Cesium, OpenLayers...) is
 *   handed raster tiles drawn from the adjusted document, if the app passed
 *   a `rasteriser`. Changing the rules re-rasterises and refetches nothing.
 *
 * Either way the same rules produce the same map, because both paths start
 * from one compilation of one style.
 *
 * Quietly doing nothing is the failure this design is built against, so
 * `onDiagnostics` always hears how many layers each rule matched, which
 * matched none, and what this backend would not take.
 */
declare function createVectorStyle(options?: VectorStyleOptions): MapViewStyle;

export { LayerRole, NO_STYLE_RULES, type StyleColorFilter, type StyleLayerKind, type StylePatch, type StyleRules, type StyleRulesBuilder, type StyleSelector, type UnsupportedPolicy, type VectorStyleOptions, type VectorStyleRasterisation, type VectorStyleRasteriser, type VectorStyleSource, buildStyleRules, createVectorStyle, parseStyleRules };
