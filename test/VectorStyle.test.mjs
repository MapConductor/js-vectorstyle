/**
 * What `createVectorStyle` does to a map, against a map that is only a
 * recorder.
 *
 * No provider is involved on purpose. What is being checked is the contract
 * every provider will be held to — which route a backend's capabilities put
 * it on, that changing the rules does not reload anything, and that
 * disposing leaves nothing behind — and a fake host is the only way to check
 * all of those without sixteen real maps.
 *
 * android-sdk の `VectorStyleTest`、ios-sdk の `VectorStyleTests` と
 * 1 対 1 で対応する。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { before, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    StyleMutationStore,
    VectorStyleMutationSupportKey,
    VectorStyleSupportKey,
} from '@mapconductor/js-sdk-core';
import { loadStyleWasm } from '../vendor/vectorstyle/dist/index.js';

import { buildStyleRules, createVectorStyle, LayerRole, parseStyleRules } from '../dist/index.js';

const STYLE = JSON.stringify({
    version: 8,
    name: 'test',
    sources: {
        s: { type: 'vector', tiles: ['https://x/{z}/{x}/{y}'], attribution: '© Someone' },
    },
    layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': '#f8f4f0' } },
        {
            id: 'water',
            type: 'fill',
            source: 's',
            'source-layer': 'water',
            paint: { 'fill-color': '#a0c8f0' },
        },
        {
            id: 'roads',
            type: 'line',
            source: 's',
            'source-layer': 'transportation',
            paint: { 'line-color': '#888', 'line-width': 2 },
        },
        {
            id: 'labels',
            type: 'symbol',
            source: 's',
            'source-layer': 'place',
            paint: { 'text-color': '#333' },
        },
    ],
});

const rules = (color) =>
    parseStyleRules(
        JSON.stringify({
            schemaVersion: 1,
            rules: [{ selector: { role: 'road' }, patch: { color } }],
        }),
    );

/** A map that records what it was asked to do. */
function makeHost({ vector = true, mutations = true, vectorStyleUrl = undefined } = {}) {
    const entries = new Map();
    const host = {
        shown: [],
        applied: [],
        diagnostics: [],
        credited: [],
        rasters: [],
        styleLoadedAttached: false,
        refuse: () => false,
        vectorStyleUrl,
        serviceRegistry: {
            get: (key) => entries.get(key),
            has: (key) => entries.has(key),
            capabilityStatus: () => 'Unknown',
        },
        tileServer: {},
        onStyleLoaded() {
            host.styleLoadedAttached = true;
            return {
                dispose() {
                    host.styleLoadedAttached = false;
                },
            };
        },
        upsertRaster: (state) => host.rasters.push(state.id),
        removeRaster: (id) => {
            host.rasters = host.rasters.filter((it) => it !== id);
        },
        report: (lines) => host.diagnostics.push(...lines),
    };
    host.store = new StyleMutationStore((list) => {
        host.applied.push(list);
        return list.filter(host.refuse);
    });
    if (vector) {
        entries.set(VectorStyleSupportKey, {
            showStyle(style, attributionRules) {
                host.shown.push(style);
                host.credited.push(...(attributionRules ?? []).map((r) => r.attribution));
            },
            clearStyle() {
                host.shown.push(null);
            },
        });
    }
    if (mutations) entries.set(VectorStyleMutationSupportKey, host.store);
    return host;
}

function makeRasteriser() {
    const it = { installed: [], restyled: [], disposals: 0 };
    it.install = (_host, styleJson) => {
        it.installed.push(styleJson);
        return {
            restyle: (json) => it.restyled.push(json),
            dispose: () => {
                it.disposals += 1;
            },
        };
    };
    return it;
}

/** The work is asynchronous; wait for it to land rather than guess. */
async function settle(host, until) {
    const deadline = Date.now() + 10_000;
    while (!until() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(until(), `nothing happened: ${host.diagnostics.join(' | ')}`);
}

before(async () => {
    // Node cannot `fetch` a local file, which is how the browser build finds
    // its binary, so the bytes are handed over directly.
    const here = new URL('./', import.meta.url);
    await loadStyleWasm(
        await readFile(fileURLToPath(new URL('../../vectorstyle/pkg/mvt_style_wasm_bg.wasm', here))),
    );
});

describe('createVectorStyle', () => {
    let host;
    beforeEach(() => {
        host = makeHost();
    });

    /**
     * A map that reads styles and takes patches gets the author's document
     * and the differences on top — not the adjusted document. The next rule
     * change produces differences against the original, and a map holding an
     * already-adjusted document would read them as something else.
     */
    test('a map that reads styles is given the original and the differences', async () => {
        const installation = createVectorStyle({
            document: { text: STYLE },
            rules: rules('#ffffff'),
        }).install(host);
        try {
            await settle(host, () => host.applied.length > 0);

            assert.equal(host.shown.length, 1);
            assert.equal(host.shown[0].layers[2].paint['line-color'], '#888', 'the original');
            const paint = host.applied.flat()[0];
            assert.equal(paint.layerId, 'roads');
            assert.equal(paint.value, '"#ffffff"');
            // The document says `#888`; what comes back is the same colour
            // in the one form every renderer can read. MapLibre on iOS
            // parses the colour itself, so the compiler canonicalises every
            // one that crosses the boundary.
            assert.equal(paint.previous, '"#888888"');
            assert.ok(host.credited.includes('© Someone'), 'the style credit was not carried');
        } finally {
            installation.dispose();
        }
    });

    /**
     * The point of the whole design: moving a slider sends new differences
     * and the map is never handed a document again.
     */
    test('changing the rules does not reload anything', async () => {
        const installation = createVectorStyle({
            document: { text: STYLE },
            rules: rules('#ffffff'),
        }).install(host);
        try {
            await settle(host, () => host.applied.length > 0);
            const servedOnce = host.shown.length;

            const again = createVectorStyle({ document: { text: STYLE }, rules: rules('#ff0000') });
            assert.ok(installation.update(again), 'an adjustment-only change was refused');
            await settle(host, () => host.applied.length > 1);

            assert.equal(host.shown.length, servedOnce, 'the map was handed a document again');
            const last = host.applied.at(-1)[0];
            assert.equal(last.value, '"#ff0000"');
            assert.equal(last.previous, '"#888888"', "still relative to the author's style");
        } finally {
            installation.dispose();
        }
    });

    test('a different document is not an update', async () => {
        const installation = createVectorStyle({
            document: { text: STYLE },
            rules: rules('#ffffff'),
        }).install(host);
        try {
            await settle(host, () => host.applied.length > 0);
            assert.equal(
                installation.update(createVectorStyle({ document: { url: 'https://x/s.json' } })),
                false,
            );
        } finally {
            installation.dispose();
        }
    });

    /**
     * A map that reads styles but cannot be patched has only one way to show
     * an adjustment: the adjusted document. Every rule change reloads, which
     * is why the capability is worth implementing.
     */
    test('a map that cannot be patched is given the adjusted document', async () => {
        host = makeHost({ mutations: false });
        const installation = createVectorStyle({
            document: { text: STYLE },
            rules: rules('#ffffff'),
        }).install(host);
        try {
            await settle(host, () => host.shown.length > 0);
            assert.equal(host.applied.length, 0);
            assert.equal(host.shown[0].layers[2].paint['line-color'], '#ffffff');
        } finally {
            installation.dispose();
        }
    });

    test('a map that cannot read styles goes through the rasteriser', async () => {
        host = makeHost({ vector: false, mutations: false });
        const rasteriser = makeRasteriser();
        const installation = createVectorStyle({
            document: { text: STYLE },
            rules: rules('#ffffff'),
            rasteriser,
        }).install(host);

        await settle(host, () => rasteriser.installed.length > 0);
        assert.ok(rasteriser.installed[0].includes('#ffffff'));
        assert.equal(host.shown.length, 0, 'the map was handed a style it cannot read');

        assert.ok(
            installation.update(
                createVectorStyle({ document: { text: STYLE }, rules: rules('#ff0000'), rasteriser }),
            ),
        );
        await settle(host, () => rasteriser.restyled.length > 0);
        assert.equal(rasteriser.installed.length, 1);
        assert.ok(rasteriser.restyled[0].includes('#ff0000'));

        installation.dispose();
        assert.equal(rasteriser.disposals, 1);
    });

    /**
     * A backend that can do neither is told so. Left to itself it would show
     * an ordinary map and the adjustments would simply not be there, which
     * is the failure this whole design is built against.
     */
    test('a map with neither is told so rather than left blank', async () => {
        host = makeHost({ vector: false, mutations: false });
        const installation = createVectorStyle({ document: { text: STYLE } }).install(host);
        try {
            await settle(host, () => host.diagnostics.some((d) => d.includes('no rasteriser')));
        } finally {
            installation.dispose();
        }
    });

    test('adjusting the current design needs a style to adjust', async () => {
        const installation = createVectorStyle({ rules: rules('#ffffff') }).install(host);
        try {
            await settle(host, () =>
                host.diagnostics.some((d) => d.includes('not drawing a vector style')),
            );
            assert.equal(host.applied.length, 0);
        } finally {
            installation.dispose();
        }
    });

    test('what the map refuses is reported and the rest stays', async () => {
        host.refuse = () => true;
        const installation = createVectorStyle({
            document: { text: STYLE },
            rules: rules('#ffffff'),
        }).install(host);
        try {
            await settle(host, () => host.diagnostics.some((d) => d.includes('were not applied')));
            assert.equal(host.shown.length, 1, "'report' is the default, so nothing was re-served");
        } finally {
            installation.dispose();
        }
    });

    test('the reload policy hands over the adjusted document instead', async () => {
        host.refuse = () => true;
        const installation = createVectorStyle({
            document: { text: STYLE },
            rules: rules('#ffffff'),
            onUnsupported: 'reload',
        }).install(host);
        try {
            await settle(host, () => host.shown.length >= 2);
            assert.equal(host.shown.at(-1).layers[2].paint['line-color'], '#ffffff');
        } finally {
            installation.dispose();
        }
    });

    test('disposing leaves the map as it was found', async () => {
        const installation = createVectorStyle({
            document: { text: STYLE },
            rules: rules('#ffffff'),
        }).install(host);
        await settle(host, () => host.applied.length > 0);

        installation.dispose();

        assert.ok(host.shown.includes(null), 'the style was not cleared');
        assert.equal(host.store.applied.length, 0, 'the adjustments were not taken off');
        assert.equal(host.styleLoadedAttached, false, 'the style-loaded hook is still attached');
    });

    test('disposing twice is harmless', async () => {
        const installation = createVectorStyle({
            document: { text: STYLE },
            rules: rules('#ffffff'),
        }).install(host);
        await settle(host, () => host.applied.length > 0);
        installation.dispose();
        installation.dispose();
        assert.equal(host.shown.filter((it) => it === null).length, 1);
    });

    test('the diagnostics always say what the rules matched', async () => {
        const heard = [];
        const installation = createVectorStyle({
            document: { text: STYLE },
            rules: rules('#ffffff'),
            onDiagnostics: (lines) => heard.push(...lines),
        }).install(host);
        try {
            await settle(host, () => heard.some((d) => d.includes('matched 1 layers')));
        } finally {
            installation.dispose();
        }
    });
});

describe('buildStyleRules', () => {
    /**
     * The text *is* the contract, and the compiler on three platforms reads
     * it, so it is asserted as text rather than through a parser.
     */
    test('writes the example the design was argued from', () => {
        const rules = buildStyleRules((r) => {
            r.all({ color: '#000000' });
            r.role(LayerRole.label, { visible: false });
            r.role(LayerRole.roadCasing, { color: '#303030' });
            r.role(LayerRole.road, { color: '#ffffff', widthScale: 1.3 });
        });
        assert.equal(
            rules.json,
            '{"schemaVersion":1,"rules":[' +
                '{"selector":"all","patch":{"color":"#000000"}},' +
                '{"selector":{"role":"label"},"patch":{"visible":false}},' +
                '{"selector":{"role":"road-casing"},"patch":{"color":"#303030"}},' +
                '{"selector":{"role":"road"},"patch":{"color":"#ffffff","widthScale":1.3}}' +
                ']}',
        );
    });

    test('leaves out what was not set', () => {
        const rules = buildStyleRules((r) => r.all({ color: undefined, opacity: 0.5 }));
        assert.equal(
            rules.json,
            '{"schemaVersion":1,"rules":[{"selector":"all","patch":{"opacity":0.5}}]}',
        );
    });

    test('names a schema when told to', () => {
        assert.equal(
            buildStyleRules((r) => r.schema('openmaptiles')).json,
            '{"schemaVersion":1,"schema":"openmaptiles","rules":[]}',
        );
        assert.equal(
            buildStyleRules((r) => r.customSchema({ parcel: ['zoning'] })).json,
            '{"schemaVersion":1,"schema":{"roles":{"parcel":["zoning"]}},"rules":[]}',
        );
    });

    test('composes selectors', () => {
        const rules = buildStyleRules((r) =>
            r.where({ allOf: [{ role: 'road' }, { not: { role: 'road-casing' } }] }, { color: '#fff' }),
        );
        assert.equal(
            rules.json,
            '{"schemaVersion":1,"rules":[{"selector":{"allOf":[{"role":"road"},' +
                '{"not":{"role":"road-casing"}}]},"patch":{"color":"#fff"}}]}',
        );
    });
});
