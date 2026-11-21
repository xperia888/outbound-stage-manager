// Run with: node --test tests/
// Loads the real <script> from index.html into a sandbox with minimal browser stubs,
// then tests the sync, merge and escaping fixes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const scriptStart = html.lastIndexOf('<script>');
const scriptEnd = html.lastIndexOf('</script>');
const appScript = html.slice(scriptStart + '<script>'.length, scriptEnd);

function decodeHtmlAttr(str) {
    return str
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

/** Fake google.script.run: each server call answers from a queue of responses. */
function createFakeAppsScript() {
    const calls = [];
    const responses = { saveBoardState: [], loadBoardState: [] };
    const makeRunner = () => {
        let onSuccess = () => {};
        const runner = {
            withSuccessHandler(fn) { onSuccess = fn; return runner; },
            withFailureHandler() { return runner; },
            saveBoardState(...args) {
                calls.push({ fn: 'saveBoardState', args });
                onSuccess(responses.saveBoardState.shift() || { ok: true, updatedAt: `t-save-${calls.length}` });
            },
            loadBoardState(...args) {
                calls.push({ fn: 'loadBoardState', args });
                onSuccess(responses.loadBoardState.shift() || { ok: true, stateJson: null, updatedAt: null });
            }
        };
        return runner;
    };
    const google = { script: {} };
    Object.defineProperty(google.script, 'run', { get: makeRunner });
    return { google, calls, responses };
}

function loadApp({ withAppsScript = false } = {}) {
    const timers = [];
    const storage = () => {
        const data = new Map();
        return {
            getItem: k => (data.has(k) ? data.get(k) : null),
            setItem: (k, v) => data.set(k, String(v)),
            removeItem: k => data.delete(k)
        };
    };
    const ctx = {
        console: { log() {}, error() {}, warn() {} },
        localStorage: storage(),
        sessionStorage: storage(),
        document: {
            getElementById: () => null,
            querySelectorAll: () => [],
            documentElement: { clientWidth: 1280 },
            addEventListener() {}
        },
        setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
        clearTimeout: () => {},
        setInterval: () => 0,
        requestAnimationFrame: () => 0,
        innerWidth: 1280,
        name: '',
        addEventListener() {},
        JSON, Math, Date, Map, Set, Array, Object, String, Number, Boolean, Promise, Error
    };
    ctx.window = ctx;
    const fake = createFakeAppsScript();
    if (withAppsScript) ctx.google = fake.google;
    vm.createContext(ctx);
    vm.runInContext(appScript, ctx);
    const run = code => vm.runInContext(code, ctx);
    const flushTimers = () => { while (timers.length) timers.shift().fn(); };
    return { ctx, run, flushTimers, fake };
}

const pallet = (id, slp, extra = {}) => ({
    id, slp, orderNumber: 'SO-1', columnId: 'col-s51', carrier: '', destination: '',
    dockNumber: '', notes: '', doubleStacked: false, createdAt: 1, history: [], ...extra
});

test('jsArg keeps apostrophes, quotes and backslashes intact in inline handlers', () => {
    const { run } = loadApp();
    const tricky = `Bob's "Fast" Trucking \\ </button>`;
    const attrValue = run(`jsArg(${JSON.stringify(tricky)})`);
    assert.ok(!attrValue.includes('"'), 'raw double quote would end the HTML attribute');
    assert.equal(vm.runInNewContext(decodeHtmlAttr(attrValue)), tricky);
});

test('3-way merge keeps both devices\' changes', () => {
    const { run } = loadApp();
    const base = { columns: [{ id: 'col-s51', name: 'S51', capacity: 8 }], pallets: [pallet('a', 'SLP-A'), pallet('b', 'SLP-B')], shippedPallets: [] };
    // This device: shipped A, scanned C
    const local = { ...base, pallets: [pallet('b', 'SLP-B'), pallet('c', 'SLP-C')], shippedPallets: [{ id: 'a', slp: 'SLP-A', shippedAt: 10 }] };
    // Other device: moved B, scanned D
    const remote = { ...base, pallets: [pallet('a', 'SLP-A'), pallet('b', 'SLP-B', { columnId: 'col-s52' }), pallet('d', 'SLP-D')], shippedPallets: [] };

    const merged = run(`mergeBoardStates(${JSON.stringify(base)}, ${JSON.stringify(local)}, ${JSON.stringify(remote)})`);
    const ids = merged.pallets.map(p => p.id).sort();
    assert.deepEqual(ids, ['b', 'c', 'd']);
    assert.equal(merged.pallets.find(p => p.id === 'b').columnId, 'col-s52', 'unchanged-here pallet takes the other device\'s move');
    assert.deepEqual(merged.shippedPallets.map(s => s.id), ['a']);
});

test('merge: a pallet shipped on another device stays shipped; same SLP scanned twice is kept once', () => {
    const { run } = loadApp();
    const base = { columns: [], pallets: [pallet('a', 'SLP-A')], shippedPallets: [] };
    const local = { ...base, pallets: [pallet('a', 'SLP-A', { notes: 'edited here' }), pallet('x1', 'SLP-X')] };
    const remote = { ...base, pallets: [pallet('x2', 'SLP-X')], shippedPallets: [{ id: 'a', slp: 'SLP-A', shippedAt: 5 }] };

    const merged = run(`mergeBoardStates(${JSON.stringify(base)}, ${JSON.stringify(local)}, ${JSON.stringify(remote)})`);
    assert.deepEqual(merged.pallets.map(p => p.slp), ['SLP-X']);
    assert.deepEqual(merged.shippedPallets.map(s => s.id), ['a']);
});

test('background polling resumes after a debounced save (debounce timer is reset)', () => {
    const { run, flushTimers, fake } = loadApp({ withAppsScript: true });
    run(`saveState()`);
    assert.notEqual(run('cloudSaveDebounceTimer'), null);
    flushTimers();
    assert.equal(run('cloudSaveDebounceTimer'), null);

    const loadsBefore = fake.calls.filter(c => c.fn === 'loadBoardState').length;
    run(`loadState({ isBackgroundPoll: true, silent: true })`);
    const loadsAfter = fake.calls.filter(c => c.fn === 'loadBoardState').length;
    assert.equal(loadsAfter, loadsBefore + 1, 'background poll should reach the server');
});

test('save conflict merges the other device\'s board and re-saves against its version', () => {
    const { run, fake } = loadApp({ withAppsScript: true });
    const baseState = run('JSON.parse(JSON.stringify(appState))');
    run(`lastCloudUpdatedAt = 't-1'; lastSyncedStateJson = ${JSON.stringify(JSON.stringify(baseState))};`);

    // This device scans a new SLP
    run(`appState.pallets.push(${JSON.stringify(pallet('mine', 'SLP-MINE'))})`);
    // Meanwhile another device scanned SLP-THEIRS
    const remoteState = { ...baseState, pallets: [...baseState.pallets, pallet('theirs', 'SLP-THEIRS')] };
    fake.responses.saveBoardState.push(
        { ok: false, conflict: true, stateJson: JSON.stringify(remoteState), updatedAt: 't-2' },
        { ok: true, updatedAt: 't-3' }
    );

    run('executeCloudSaveNow()');

    const saves = fake.calls.filter(c => c.fn === 'saveBoardState');
    assert.equal(saves.length, 2);
    assert.equal(saves[0].args[1], 't-1');
    assert.equal(saves[1].args[1], 't-2', 'second save is based on the other device\'s version');
    const savedSlps = JSON.parse(saves[1].args[0]).pallets.map(p => p.slp);
    assert.ok(savedSlps.includes('SLP-MINE') && savedSlps.includes('SLP-THEIRS'));
    assert.equal(run('lastCloudUpdatedAt'), 't-3');
});
