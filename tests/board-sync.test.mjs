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
    const responses = { saveBoardState: [], loadBoardState: [], logScanEvents: [] };
    const respond = (fn, args) => {
        if (fn === 'saveBoardState') return responses.saveBoardState.shift() || { ok: true, updatedAt: `t-save-${calls.length}` };
        if (fn === 'loadBoardState') return responses.loadBoardState.shift() || { ok: true, stateJson: null, updatedAt: null };
        if (fn === 'logScanEvents') return responses.logScanEvents.shift() || { ok: true, loggedIds: args[0].map(e => e.id) };
        return { ok: false, error: 'unknown' };
    };
    const makeRunner = () => {
        let onSuccess = () => {};
        const runner = {
            withSuccessHandler(fn) { onSuccess = fn; return runner; },
            withFailureHandler() { return runner; },
            api(request) {
                const { fn, args, key } = JSON.parse(JSON.stringify(request));
                calls.push({ fn, args, key });
                onSuccess(respond(fn, args));
            }
        };
        return runner;
    };
    const google = { script: {} };
    Object.defineProperty(google.script, 'run', { get: makeRunner });
    return { google, calls, responses, respond };
}

function loadApp({ withAppsScript = false, accessCode = 'test-code', cloudApiUrl = '', fetchImpl = null, googleImpl = null } = {}) {
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
    if (accessCode) ctx.localStorage.setItem('outbound_access_code_v2', accessCode);
    if (fetchImpl) ctx.fetch = fetchImpl;
    const fake = createFakeAppsScript();
    if (withAppsScript) ctx.google = googleImpl || fake.google;
    vm.createContext(ctx);
    // Tests never talk to the real sheet: CLOUD_API_URL is blank unless a test sets one
    const script = appScript.replace(/const CLOUD_API_URL = '[^']*';/, `const CLOUD_API_URL = ${JSON.stringify(cloudApiUrl)};`);
    vm.runInContext(script, ctx);
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

test('scan log: scans and shipments are queued, sent in one batch, then cleared', () => {
    const { run, flushTimers, fake } = loadApp({ withAppsScript: true });
    run(`addSlpToStaging({ slp: 'SLP-LOG1', orderNumber: 'SO-9', columnId: 'col-s52' })`);
    run(`addSlpToStaging({ slp: 'SLP-LOG2', orderNumber: 'SO-9', columnId: 'col-s52', doubleStacked: true })`);
    run(`shipWholeOrder('SO-9')`);
    assert.equal(run('scanLogQueue.length'), 4);

    flushTimers();
    const logCalls = fake.calls.filter(c => c.fn === 'logScanEvents');
    assert.equal(logCalls.length, 1, 'quick scans are batched into one call');
    const events = logCalls[0].args[0];
    assert.deepEqual(events.map(e => `${e.action} ${e.slp}`), ['SCAN SLP-LOG1', 'SCAN SLP-LOG2', 'SHIP SLP-LOG1', 'SHIP SLP-LOG2']);
    assert.equal(events[0].toLane, 'S52');
    assert.equal(events[2].fromLane, 'S52');
    assert.equal(events[1].doubleStacked, true);
    assert.equal(run('scanLogQueue.length'), 0);
    assert.equal(run(`JSON.parse(safeStorageGet(SCAN_LOG_QUEUE_KEY)).length`), 0);
});

test('scan log: events stay queued and are retried when the sheet is unreachable', () => {
    const { run, flushTimers, fake } = loadApp({ withAppsScript: true });
    fake.responses.logScanEvents.push({ ok: false, error: 'Busy — try again' });
    run(`addSlpToStaging({ slp: 'SLP-RETRY', orderNumber: 'SO-7', columnId: 'col-s51' })`);
    run('flushScanLog()');
    assert.equal(run('scanLogQueue.length'), 1, 'kept after a failed send');
    assert.notEqual(run('scanLogFlushTimer'), null, 'retry scheduled');

    flushTimers(); // retry succeeds (default response)
    assert.equal(fake.calls.filter(c => c.fn === 'logScanEvents').length, 2);
    assert.equal(run('scanLogQueue.length'), 0);
});

test('scan log: nothing is queued in Local Mode', () => {
    const { run } = loadApp();
    run(`addSlpToStaging({ slp: 'SLP-LOCAL', orderNumber: 'SO-1', columnId: 'col-s51' })`);
    assert.equal(run('scanLogQueue.length'), 0);
});

function loadCodeGs({ accessCode = 'secret-1' } = {}) {
    const code = readFileSync(new URL('../Code.gs', import.meta.url), 'utf8');
    const sheets = new Map();
    const makeSheet = () => {
        const rows = [];
        const range = (r, c, nr = 1, nc = 1) => ({
            setValues(vals) {
                vals.forEach((v, i) => {
                    const row = (rows[r - 1 + i] = rows[r - 1 + i] || []);
                    v.forEach((x, j) => { row[c - 1 + j] = x; });
                });
                return this;
            },
            setValue(v) { (rows[r - 1] = rows[r - 1] || [])[c - 1] = v; return this; },
            getValue() { return (rows[r - 1] || [])[c - 1] ?? ''; },
            getValues() { return Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => (rows[r - 1 + i] || [])[c - 1 + j] ?? '')); },
            clearContent() { for (let i = 0; i < nr; i++) if (rows[r - 1 + i]) rows[r - 1 + i][c - 1] = ''; return this; },
            setNumberFormat() { return this; },
            setFontWeight() { return this; }
        });
        return {
            rows,
            getRange(a, c, nr, nc) {
                if (typeof a !== 'string') return range(a, c, nr, nc);
                const m = /^([A-Z])(\d+)(?::([A-Z])(\d+))?$/.exec(a);
                if (!m) return range(1, 1); // whole-column refs like 'A:A' (formatting only)
                const col = m[1].charCodeAt(0) - 64, row = Number(m[2]);
                const ncols = m[3] ? m[3].charCodeAt(0) - 64 - col + 1 : 1;
                return range(row, col, 1, ncols);
            },
            getLastRow() { return rows.length; },
            setFrozenRows() {}
        };
    };
    const cacheStore = new Map();
    const ctx = {
        SpreadsheetApp: {
            getActiveSpreadsheet: () => ({
                getSheetByName: n => sheets.get(n) || null,
                insertSheet: n => { const s = makeSheet(); sheets.set(n, s); return s; }
            }),
            flush() {}
        },
        LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
        CacheService: {
            getScriptCache: () => ({
                getAll: keys => Object.fromEntries(keys.filter(k => cacheStore.has(k)).map(k => [k, cacheStore.get(k)])),
                putAll: obj => Object.entries(obj).forEach(([k, v]) => cacheStore.set(k, v))
            })
        },
        Session: { getActiveUser: () => ({ getEmail: () => 'lead@example.com' }) },
        PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k === 'ACCESS_CODE' ? accessCode : null) }) },
        ContentService: {
            MimeType: { JSON: 'json' },
            createTextOutput: text => ({ text, setMimeType() { return this; } })
        },
        HtmlService: {},
        Date, JSON, Number, String, Array, Object
    };
    vm.createContext(ctx);
    vm.runInContext(code, ctx);
    return { ctx, sheets };
}

test('Code.gs logScanEvents writes one row per event and skips retried duplicates', () => {
    const { ctx, sheets } = loadCodeGs();
    const evt = (id, action) => ({ id, time: 1763700000000, action, slp: '00884101', orderNumber: 'SO-1', toLane: 'S51' });

    const log = events => ctx.api({ fn: 'logScanEvents', args: [events], key: 'secret-1' });
    const first = log([evt('e1', 'SCAN'), evt('e2', 'MOVE')]);
    assert.equal(first.ok, true);
    assert.deepEqual([...first.loggedIds], ['e1', 'e2']);

    // Retry of e2 (response was lost) plus a new event
    const second = log([evt('e2', 'MOVE'), evt('e3', 'SHIP')]);
    assert.deepEqual([...second.loggedIds], ['e2', 'e3'], 'duplicate is confirmed so the page can drop it');

    const rows = sheets.get('Scan Log').rows;
    assert.equal(rows.length, 4, 'header + 3 events, no duplicate');
    assert.equal(rows[0][0], 'Timestamp');
    assert.deepEqual(rows.slice(1).map(r => r[12]), ['e1', 'e2', 'e3']);
    assert.equal(rows[1][2], '00884101', 'SLP kept as text');
    assert.equal(rows[1][11], 'lead@example.com');
});

test('Code.gs api() requires the access code and only exposes the three board functions', () => {
    const { ctx } = loadCodeGs();
    assert.equal(ctx.api({ fn: 'loadBoardState', args: [], key: 'wrong' }).unauthorized, true);
    assert.equal(ctx.api({ fn: 'loadBoardState', args: [] }).unauthorized, true);
    assert.equal(ctx.api({ fn: 'loadBoardState', args: [], key: 'secret-1' }).ok, true);
    assert.equal(ctx.api({ fn: 'getStateSheet_', args: [], key: 'secret-1' }).ok, false);

    const viaPost = JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify({ fn: 'loadBoardState', args: [], key: 'secret-1' }) } }).text);
    assert.equal(viaPost.ok, true, 'GitHub Pages POST reaches the same api()');

    const { ctx: unset } = loadCodeGs({ accessCode: null });
    const res = unset.api({ fn: 'loadBoardState', args: [], key: '' });
    assert.equal(res.ok, false);
    assert.match(res.error, /ACCESS_CODE/);
});

test('GitHub Pages copy syncs through CLOUD_API_URL with the access code', async () => {
    const posts = [];
    const fakeServer = createFakeAppsScript();
    const fetchImpl = async (url, opts) => {
        const req = JSON.parse(opts.body);
        posts.push({ url, contentType: opts.headers['Content-Type'], ...req });
        return { json: async () => fakeServer.respond(req.fn, req.args) };
    };
    const { run } = loadApp({ cloudApiUrl: 'https://script.google.com/macros/s/ABC/exec', fetchImpl });
    assert.equal(run('isAppsScriptAvailable()'), true);

    run(`addSlpToStaging({ slp: 'SLP-PAGES', orderNumber: 'SO-5', columnId: 'col-s51' })`);
    run('executeCloudSaveNow()');
    await new Promise(r => setTimeout(r, 10));

    const save = posts.find(p => p.fn === 'saveBoardState');
    assert.ok(save, 'board saved over fetch');
    assert.equal(save.url, 'https://script.google.com/macros/s/ABC/exec');
    assert.equal(save.key, 'test-code');
    assert.match(save.contentType, /^text\/plain/, 'text/plain avoids a CORS preflight');
    assert.ok(JSON.parse(save.args[0]).pallets.some(p => p.slp === 'SLP-PAGES'));
    assert.equal(run('lastCloudUpdatedAt') !== null, true);
});

test('no access code: the page waits instead of calling the server; a wrong code is cleared', () => {
    const { run, fake } = loadApp({ withAppsScript: true, accessCode: '' });
    run('executeCloudSaveNow()');
    assert.equal(fake.calls.length, 0, 'no request without a code');

    const second = loadApp({ withAppsScript: true, accessCode: 'old-code' });
    second.fake.responses.loadBoardState.push({ ok: false, unauthorized: true });
    second.run(`loadState({ isBackgroundPoll: true, silent: true })`);
    assert.equal(second.run(`safeStorageGet(ACCESS_CODE_KEY)`), '', 'wrong code forgotten so the device asks again');
});

/** Two devices whose google.script.run talks to one real Code.gs (fake sheet). */
function twoDevicesOnOneSheet({ legacyJson = null, legacyAt = '' } = {}) {
    const server = loadCodeGs({ accessCode: 'test-code' });
    if (legacyJson !== null) {
        const legacy = server.ctx.SpreadsheetApp.getActiveSpreadsheet().insertSheet('State');
        legacy.rows[0] = [legacyJson, legacyAt];
    }
    const pending = [];
    const googleFor = () => {
        const g = { script: {} };
        Object.defineProperty(g.script, 'run', {
            get() {
                let ok = () => {};
                const r = {
                    withSuccessHandler(f) { ok = f; return r; },
                    withFailureHandler() { return r; },
                    api(req) {
                        const res = JSON.parse(JSON.stringify(server.ctx.api(JSON.parse(JSON.stringify(req)))));
                        pending.push(() => ok(res));
                    }
                };
                return r;
            }
        });
        return g;
    };
    const A = loadApp({ withAppsScript: true, googleImpl: googleFor() });
    const B = loadApp({ withAppsScript: true, googleImpl: googleFor() });
    const settle = () => {
        for (let i = 0; i < 50 && (pending.length || true); i++) {
            while (pending.length) pending.shift()();
            A.flushTimers(); B.flushTimers();
            if (!pending.length) break;
        }
    };
    const slps = d => d.run('appState.pallets.map(p => p.slp).sort().join(",")');
    return { A, B, settle, slps, server };
}

test('two devices converge when the stored board has no timestamp (old State!A1 data)', () => {
    const legacyJson = JSON.stringify({
        columns: [{ id: 'col-s51', name: 'S51', capacity: 8 }, { id: 'col-s52', name: 'S52', capacity: 8 }],
        pallets: [pallet('old', 'SLP-OLD')], shippedPallets: []
    });
    const { A, B, settle, slps } = twoDevicesOnOneSheet({ legacyJson, legacyAt: '' });
    for (const d of [A, B]) { d.run('loadState({ isBackgroundPoll: false, silent: true })'); settle(); }

    A.run(`addSlpToStaging({ slp: 'SLP-FROM-A', orderNumber: 'SO-A', columnId: 'col-s51' })`); settle();
    B.run(`addSlpToStaging({ slp: 'SLP-FROM-B', orderNumber: 'SO-B', columnId: 'col-s52' })`); settle();
    for (let i = 0; i < 3; i++) for (const d of [A, B]) { d.run('loadState({ isBackgroundPoll: true, silent: true })'); settle(); }

    assert.equal(slps(A), 'SLP-FROM-A,SLP-FROM-B,SLP-OLD');
    assert.equal(slps(B), slps(A));
    assert.match(A.run('lastCloudUpdatedAt'), /^\d{4}-\d\d-\d\dT/, 'a real timestamp once a save lands');
});

test('a background load never overwrites scans the sheet has not accepted yet', () => {
    const { A, settle, slps } = twoDevicesOnOneSheet();
    A.run('loadState({ isBackgroundPoll: false, silent: true })'); settle();
    A.run(`lastCloudSaveFailed = true; appState.pallets.push(${JSON.stringify(pallet('unsaved', 'SLP-UNSAVED'))})`);
    A.run('loadState({ isBackgroundPoll: true, silent: true })'); settle();
    assert.ok(slps(A).includes('SLP-UNSAVED'), 'unsaved scan kept');
    assert.equal(A.run('lastCloudSaveFailed'), false, 'the retried save landed');
});
