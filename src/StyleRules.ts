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
export interface StyleRules {
    /** The canonical form. */
    readonly json: string;
}

/** No adjustments: the style as its author wrote it. */
export const NO_STYLE_RULES: StyleRules = { json: '{"schemaVersion":1,"rules":[]}' };

/**
 * Takes a rules document as it stands.
 *
 * Not checked here — a document is checked when it is compiled against a
 * style, and the compiler reports then.
 */
export function parseStyleRules(json: string): StyleRules {
    return { json };
}

/**
 * The roles the built-in schema profiles assign.
 *
 * Open strings rather than a closed union: a style cut to a schema nobody
 * here has heard of can name its own roles through `customSchema`, and
 * adding a role to the built-in tables must not be a breaking change on
 * three platforms.
 */
export const LayerRole = {
    background: 'background',
    water: 'water',
    waterway: 'waterway',
    land: 'land',
    landuse: 'landuse',
    park: 'park',
    building: 'building',
    road: 'road',
    /**
     * The wide dark line drawn under a road to give it an edge.
     *
     * A style draws every road twice, and "make roads white" applied to both
     * halves gives a white slab rather than a road. Nothing in the tile
     * distinguishes them — only the layer's name does — so this is the one
     * role decided by a naming convention, and the compiler reports how many
     * layers it found.
     */
    roadCasing: 'road-casing',
    rail: 'rail',
    transit: 'transit',
    boundary: 'boundary',
    aeroway: 'aeroway',
    label: 'label',
    poi: 'poi',
} as const;

/** A style layer's `type`. */
export type StyleLayerKind = 'background' | 'fill' | 'line' | 'circle' | 'symbol' | 'other';

/** Which layers a rule reaches. */
export type StyleSelector =
    | 'all'
    /** What the layer *is*, across schemas that name their sources differently. */
    | { readonly role: string }
    /** The layer's `id`, as a glob: `*` for any run, `?` for one character. */
    | { readonly layerId: string }
    | { readonly sourceLayer: string }
    | { readonly kind: StyleLayerKind }
    | { readonly anyOf: readonly StyleSelector[] }
    | { readonly allOf: readonly StyleSelector[] }
    | { readonly not: StyleSelector };

/** A function of the colour already there, for what a literal cannot express. */
export type StyleColorFilter =
    | { readonly desaturate: number }
    | { readonly darken: number }
    | { readonly lighten: number }
    | { readonly invertLightness: true }
    | { readonly mix: { readonly color: string; readonly amount?: number } };

/** What to change about the layers a selector matched. */
export interface StylePatch {
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
export interface StyleRulesBuilder {
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
export function buildStyleRules(block: (rules: StyleRulesBuilder) => void): StyleRules {
    const written: unknown[] = [];
    let schema: unknown;

    const push = (selector: StyleSelector, patch: StylePatch) => {
        written.push({ selector, patch: normalise(patch) });
    };
    const builder: StyleRulesBuilder = {
        schema(name) {
            schema = name;
        },
        customSchema(roles) {
            schema = { roles };
        },
        all: (patch) => push('all', patch),
        role: (role, patch) => push({ role }, patch),
        layerId: (layerId, patch) => push({ layerId }, patch),
        sourceLayer: (sourceLayer, patch) => push({ sourceLayer }, patch),
        kind: (kind, patch) => push({ kind }, patch),
        where: push,
    };
    block(builder);

    // Written through `JSON.stringify` with an explicit key order rather than
    // by hand: unlike Kotlin and Swift, this runtime has a JSON writer that
    // is already correct about escaping, and the order below is what the
    // other two platforms emit.
    const document: Record<string, unknown> = { schemaVersion: 1 };
    if (schema !== undefined) document.schema = schema;
    document.rules = written;
    return { json: JSON.stringify(document) };
}

/** Drops the keys that were left out, so an absent field is absent. */
function normalise(patch: StylePatch): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
        if (value !== undefined) out[key] = value;
    }
    return out;
}
