import {
    parseStyleMutations,
    styleMutationProperty,
    VectorStyleMutationSupportKey,
    VectorStyleSupportKey,
    type MapStyleHost,
    type MapStyleInstallation,
    type MapViewStyle,
    type NativeStyleDescriptor,
    type StyleMutation,
} from '@mapconductor/js-sdk-core';
import { compileStyle, type CompiledStyle, type StyleAffects } from '@mapconductor/vectorstyle';

import { NO_STYLE_RULES, type StyleRules } from './StyleRules';

/** Which style the rules are applied to. */
export type VectorStyleSource =
    /** The document itself. The app already has it. */
    | { readonly text: string }
    /**
     * A `style.json` to fetch.
     *
     * Fetched by this module rather than by the map, because the rules have
     * to be compiled against it before the map is given anything.
     */
    | { readonly url: string; readonly headers?: Readonly<Record<string, string>> }
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
export type UnsupportedPolicy = 'report' | 'reload';

/** Draws a style the map cannot read itself. Implemented by the vector tile module. */
export interface VectorStyleRasteriser {
    install(
        host: MapStyleHost,
        styleJson: string,
        affects: StyleAffects,
    ): VectorStyleRasterisation;
}

/** A rasteriser's work in progress. */
export interface VectorStyleRasterisation {
    /**
     * Draws a different style with the same tiles. The geometry has not
     * changed, only the paint over it, so this costs a re-rasterise and no
     * network.
     */
    restyle(styleJson: string, affects: StyleAffects): void;
    dispose(): void;
}

export interface VectorStyleOptions {
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
export function createVectorStyle(options: VectorStyleOptions = {}): MapViewStyle {
    const document = options.document ?? 'currentDesign';
    const rules = options.rules ?? NO_STYLE_RULES;
    const resolved: Resolved = { ...options, document, rules };
    return {
        key: `${sourceKey(document)}|${rules.json}`,
        install: (host) => install(host, resolved),
        // How an installed style recognises its successor. The map hands
        // `update` a `MapViewStyle`, which says nothing about where it came
        // from; this is the one place a style can leave something for its
        // own kind to read.
        /** @internal */
        [VECTOR_STYLE]: resolved,
        /**
         * On React Native nothing above runs: the compiler is wasm and
         * Hermes has no wasm, and the map is the Android or iOS SDK rather
         * than a JavaScript object. The style crosses the bridge as this
         * and is rebuilt by the platform's own vector style module, so the
         * map a user sees comes from exactly the code a native app runs.
         */
        toNativeDescriptor: (): NativeStyleDescriptor => ({
            ...(document === 'currentDesign'
                ? { fromCurrentDesign: true }
                : 'text' in document
                  ? { documentJson: document.text }
                  : { documentUrl: document.url, documentHeaders: document.headers }),
            rulesJson: rules.json,
        }),
    } as MapViewStyle;
}

/** @internal */
const VECTOR_STYLE = Symbol.for('mapconductor.vectorstyle');

function sourceKey(source: VectorStyleSource): string {
    if (source === 'currentDesign') return 'current';
    if ('text' in source) return `text:${source.text.length}:${source.text}`;
    return `url:${source.url}`;
}

/** Whether `next` differs from an installed style only in its adjustments. */
function sameStyle(a: Resolved, b: Resolved): boolean {
    return (
        sourceKey(a.document) === sourceKey(b.document) &&
        a.rasteriser === b.rasteriser &&
        (a.onUnsupported ?? 'report') === (b.onUnsupported ?? 'report')
    );
}

type Resolved = VectorStyleOptions & {
    readonly document: VectorStyleSource;
    readonly rules: StyleRules;
};

/**
 * One style's life on one map.
 *
 * Resolving the document can mean a network round trip and loading the
 * compiler's wasm, so the work is started and this returns at once;
 * everything after checks `disposed` before touching the map, because a view
 * can be gone before its style arrives.
 */
function install(host: MapStyleHost, initial: Resolved): MapStyleInstallation {
    let style = initial;
    let disposed = false;
    /** The style as its author wrote it, kept so later rules compile against it. */
    let base: string | null = null;
    let rasterisation: VectorStyleRasterisation | null = null;
    let servedDocument = false;
    let styleLoaded: MapStyleInstallation | null = null;
    /** Serial: two rule changes in flight would race to be the last applied. */
    let queue: Promise<void> = Promise.resolve();

    const report = (diagnostics: readonly string[]) => {
        if (diagnostics.length === 0) return;
        host.report(diagnostics);
        style.onDiagnostics?.(diagnostics);
    };

    const resolve = async (source: VectorStyleSource): Promise<string> => {
        if (source !== 'currentDesign' && 'text' in source) return source.text;
        const url =
            source === 'currentDesign'
                ? host.vectorStyleUrl ??
                  raise(
                      'this map is not drawing a vector style, so there is nothing to adjust; ' +
                          'give `document` a style of your own',
                  )
                : source.url;
        const headers = source !== 'currentDesign' && 'url' in source ? source.headers : undefined;
        const response = await fetch(url, headers ? { headers } : undefined);
        if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
        return response.text();
    };

    // The browser's map takes the parsed style straight, so there is no
    // document to serve and nothing to take down afterwards. Android and iOS
    // hand over a URL because their renderers only read one; the SDK's local
    // tile server exists for them.
    const serve = (json: string) => {
        const vector = host.serviceRegistry.get(VectorStyleSupportKey);
        if (!vector) return;
        servedDocument = true;
        vector.showStyle(JSON.parse(json) as object, attributionsOf(json));
    };

    const apply = async (next: Resolved, firstTime: boolean) => {
        if (disposed || base === null) return;
        let compiled: CompiledStyle;
        try {
            compiled = await compileStyle(base, next.rules.json, { wasmUrl: next.wasmUrl });
        } catch (error) {
            report([`the rules could not be applied: ${messageOf(error)}`]);
            return;
        }
        if (disposed) return;
        report(compiled.diagnostics);

        const vector = host.serviceRegistry.get(VectorStyleSupportKey);
        const mutation = host.serviceRegistry.get(VectorStyleMutationSupportKey);
        const mutations = parseStyleMutations(compiled.mutationsJson);

        if (vector && mutation) {
            // The map draws styles itself and can be told differences: give
            // it the author's document and the deltas on top. The compiled
            // document is deliberately *not* what it is given — the next
            // rule change produces deltas against the original, and a map
            // holding an already-adjusted document would take them to mean
            // something else.
            if (firstTime) serve(base);
            const unapplied = mutation.apply(mutations);
            if (unapplied.length > 0) handleUnapplied(unapplied, compiled, next);
        } else if (vector) {
            // It draws styles but cannot be patched: the adjusted document
            // is the only way, and every rule change reloads.
            serve(JSON.stringify(compiled.style));
        } else if (next.rasteriser) {
            const json = JSON.stringify(compiled.style);
            if (rasterisation) {
                rasterisation.restyle(json, compiled.affects);
            } else {
                rasterisation = next.rasteriser.install(host, json, compiled.affects);
                if (disposed) {
                    rasterisation.dispose();
                    rasterisation = null;
                }
            }
        } else {
            report([
                'this map cannot draw a vector style, and no rasteriser was given; ' +
                    'pass `rasteriser` from @mapconductor/react-vectortile',
            ]);
        }

        // Whatever was just applied is lost the moment the map loads a style
        // again — an app switching basemap, a provider rebuilding. The
        // mutation store puts its own set back.
        if (firstTime && styleLoaded === null) styleLoaded = host.onStyleLoaded(() => {});
    };

    const handleUnapplied = (
        unapplied: readonly StyleMutation[],
        compiled: CompiledStyle,
        next: Resolved,
    ) => {
        // Named by property, not by layer. A backend with no property for a
        // spec key fails that key on every layer that uses it, so a list of
        // layers was hundreds of names for one cause — and never said which
        // property, which is the only part an app can act on.
        const properties = [...new Set(unapplied.map(styleMutationProperty))].sort();
        const shown = properties.slice(0, 5);
        const more = properties.length > shown.length ? ', ...' : '';
        const layers = new Set(unapplied.map((m) => ('layerId' in m ? m.layerId : ''))).size;
        const message =
            `${unapplied.length} adjustments were not applied: this map cannot set these ` +
            `properties by name (${shown.join(', ')}${more}) across ${layers} layers`;
        if ((next.onUnsupported ?? 'report') === 'reload') {
            report([`${message}; handing the map the adjusted document instead`]);
            host.serviceRegistry.get(VectorStyleMutationSupportKey)?.clear();
            serve(JSON.stringify(compiled.style));
        } else {
            report([message]);
        }
    };

    queue = (async () => {
        try {
            base = await resolve(style.document);
        } catch (error) {
            report([`the style could not be read: ${messageOf(error)}`]);
            return;
        }
        if (disposed) return;
        await apply(style, true);
    })();

    return {
        dispose() {
            if (disposed) return;
            disposed = true;
            styleLoaded?.dispose();
            styleLoaded = null;
            // Order matters: the mutations have to come off while the
            // document they were applied to is still the one loaded.
            host.serviceRegistry.get(VectorStyleMutationSupportKey)?.clear();
            if (servedDocument) host.serviceRegistry.get(VectorStyleSupportKey)?.clearStyle();
            rasterisation?.dispose();
            rasterisation = null;
        },
        update(candidate) {
            const next = (candidate as unknown as Record<symbol, Resolved | undefined>)[VECTOR_STYLE];
            // A different document is a different style, whatever else
            // matches: it has to be fetched and the map has to be told.
            if (!next || !sameStyle(style, next) || base === null) return false;
            style = next;
            queue = queue.then(() => (disposed ? undefined : apply(next, false)));
            return true;
        },
    };
}

function raise(message: string): never {
    throw new Error(message);
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * The credits the style's sources ask for.
 *
 * Carried onto the design so the map's attribution overlay shows them for as
 * long as the style is up. Nothing else about this can be wrong while still
 * looking right: the map draws perfectly whether or not anyone is credited
 * for the data.
 */
function attributionsOf(json: string): { attribution: string }[] {
    try {
        const sources = (JSON.parse(json) as { sources?: Record<string, { attribution?: unknown }> })
            .sources;
        if (!sources) return [];
        const seen = new Set<string>();
        for (const source of Object.values(sources)) {
            const credit = source?.attribution;
            if (typeof credit === 'string' && credit.trim() !== '') seen.add(credit);
        }
        return [...seen].map((attribution) => ({ attribution }));
    } catch {
        return [];
    }
}
