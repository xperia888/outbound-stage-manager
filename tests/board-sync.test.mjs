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
        if (fn === 'resolveWarehouse') return (responses.resolveWarehouse || []).shift() || { ok: false, unauthorized: true };
        return { ok: false, error: 'unknown' };
    };
    const makeRunner = () => {
        let onSuccess = () => {};
        const runner = {
            withSuccessHandler(fn) { onSuccess = fn; return runner; },
            withFailureHandler() { return runner; },
            api(request) {
                const { fn, args, key, warehouse } = JSON.parse(JSON.stringify(request));
                calls.push({ fn, args, key, warehouse });
                onSuccess(respond(fn, args));
            }
        };
        return runner;
    };
    const google = { script: {} };
    Object.defineProperty(google.script, 'run', { get: makeRunner });
    return { google, calls, responses, respond };
}

function loadApp({ withAppsScript = false, accessCode = 'test-code', cloudApiUrl = '', fetchImpl = null, googleImpl = null, search = '' } = {}) {
    const timers = [];
    const longTimers = []; // e.g. the 25 s request time limit: only fired when a test asks
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
        setTimeout: (fn, ms) => { (ms >= 20000 ? longTimers : timers).push({ fn, ms }); return timers.length + longTimers.length; },
        clearTimeout: () => {},
        setInterval: () => 0,
        requestAnimationFrame: () => 0,
        innerWidth: 1280,
        name: '',
        addEventListener() {},
        JSON, Math, Date, Map, Set, Array, Object, String, Number, Boolean, Promise, Error, URL, URLSearchParams
    };
    ctx.window = ctx;
    if (accessCode) {
        ctx.localStorage.setItem('outbound_access_code_v2', accessCode);
        ctx.localStorage.setItem('outbound_access_code_v2_chino', accessCode);
    }
    if (search) ctx.location = { search, href: `https://example.test/${search}` };
    if (fetchImpl) ctx.fetch = fetchImpl;
    const fake = createFakeAppsScript();
    if (withAppsScript) ctx.google = googleImpl || fake.google;
    vm.createContext(ctx);
    // Tests never talk to the real sheet: CLOUD_API_URL is blank unless a test sets one
    const script = appScript.replace(/const CLOUD_API_URL = '[^']*';/, `const CLOUD_API_URL = ${JSON.stringify(cloudApiUrl)};`);
    vm.runInContext(script, ctx);
    const run = code => vm.runInContext(code, ctx);
    const flushTimers = () => { while (timers.length) timers.shift().fn(); };
    const fireLongTimers = () => { const due = longTimers.splice(0); due.forEach(t => t.fn()); };
    return { ctx, run, flushTimers, fireLongTimers, fake };
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

function loadCodeGs({ accessCode = 'secret-1', chinoCode = null, testMode = null, extraProps = {} } = {}) {
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
        PropertiesService: {
            getScriptProperties: () => ({
                getProperty: k => (k in extraProps ? extraProps[k] : k === 'ACCESS_CODE' ? accessCode : k === 'ACCESS_CODE_CHINO' ? chinoCode : k === 'TEST_MODE' ? testMode : null)
            })
        },
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
function twoDevicesOnOneSheet({ legacyJson = null, legacyAt = '', searchA = '', searchB = '', chinoCode = null } = {}) {
    const server = loadCodeGs({ accessCode: 'test-code', chinoCode });
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
    const A = loadApp({ withAppsScript: true, googleImpl: googleFor(), search: searchA });
    const B = loadApp({ withAppsScript: true, googleImpl: googleFor(), search: searchB });
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

test('no access code: the page asks with its own box, never the browser pop-up', () => {
    const { ctx, run } = loadApp({ withAppsScript: true, accessCode: '' });
    let promptCalls = 0;
    ctx.prompt = () => { promptCalls++; return 'x'; };
    let boxShown = 0;
    run('showAccessCodeBox = () => {}'); // DOM-free stub; count calls through a wrapper below
    ctx.__countBox = () => { boxShown++; };
    run('showAccessCodeBox = () => __countBox()');
    run('loadState({ isBackgroundPoll: false, silent: true })');
    assert.equal(promptCalls, 0);
    assert.equal(boxShown, 1);
});

test('data from an older, different app version in the sheet is replaced, and devices then converge', () => {
    // What the old ONT/CHINO page left in State!A1
    const oldFormat = JSON.stringify({ version: 'v2', facility: 'ONUS-ONT', updatedAt: 1763751769161, detail: 'Staged 4 pallets' });
    const { A, B, settle, slps } = twoDevicesOnOneSheet({ legacyJson: oldFormat, legacyAt: '2026-11-21T19:02:49.161Z' });

    A.run('loadState({ isBackgroundPoll: false, silent: true })'); settle();
    assert.equal(A.run('lastCloudSaveFailed'), false, 'first device replaced the unreadable data');
    assert.match(A.run('lastCloudUpdatedAt'), /^2026|^\d{4}-/, 'real timestamp after the save');

    B.run('loadState({ isBackgroundPoll: false, silent: true })'); settle();
    A.run(`addSlpToStaging({ slp: 'SLP-FROM-A', orderNumber: 'SO-A', columnId: 'col-s52' })`); settle();
    B.run(`addSlpToStaging({ slp: 'SLP-FROM-B', orderNumber: 'SO-B', columnId: 'col-s54' })`); settle();
    for (let i = 0; i < 3; i++) for (const d of [A, B]) { d.run('loadState({ isBackgroundPoll: true, silent: true })'); settle(); }

    assert.ok(slps(A).includes('SLP-FROM-A') && slps(A).includes('SLP-FROM-B'));
    assert.equal(slps(B), slps(A));
    assert.equal(A.run('lastCloudSaveFailed') || B.run('lastCloudSaveFailed'), false);
});

test('Code.gs: each warehouse needs its own access code and has its own tabs', () => {
    const { ctx, sheets } = loadCodeGs({ accessCode: 'ont-code', chinoCode: 'chino-code' });
    const call = (warehouse, key, fn, args = []) => ctx.api({ fn, args, key, warehouse });

    assert.equal(call('CHINO', 'ont-code', 'loadBoardState').unauthorized, true, 'ONT code cannot open CHINO');
    assert.equal(call('ONT', 'chino-code', 'loadBoardState').unauthorized, true, 'CHINO code cannot open ONT');
    assert.equal(call('CHINO', 'chino-code', 'loadBoardState').ok, true);
    assert.equal(ctx.api({ fn: 'loadBoardState', args: [], key: 'ont-code' }).ok, true, 'no warehouse = ONT (older pages)');
    assert.equal(call('NOWHERE', 'ont-code', 'loadBoardState').ok, false);

    const board = JSON.stringify({ columns: [], pallets: [{ id: 'c1', slp: 'SLP-CHINO' }], shippedPallets: [] });
    assert.equal(call('CHINO', 'chino-code', 'saveBoardState', [board, '']).ok, true);
    assert.equal(call('ONT', 'ont-code', 'loadBoardState').stateJson, null, 'ONT board untouched');
    assert.match(call('CHINO', 'chino-code', 'loadBoardState').stateJson, /SLP-CHINO/);
    assert.ok(sheets.has('StateChunks CHINO'), 'CHINO board saved in its own tab');

    call('CHINO', 'chino-code', 'logScanEvents', [[{ id: 'ev1', action: 'SCAN', slp: 'SLP-CHINO' }]]);
    assert.ok(sheets.has('Scan Log CHINO') && !sheets.has('Scan Log'));

    const { ctx: noChino } = loadCodeGs({ accessCode: 'ont-code', chinoCode: null });
    assert.match(noChino.api({ fn: 'loadBoardState', args: [], key: 'x', warehouse: 'CHINO' }).error, /ACCESS_CODE_CHINO/);
});

test('page: ?wh=CHINO opens the Chino board with its own storage and code', () => {
    const { run, fake } = loadApp({ withAppsScript: true, search: '?wh=chino' });
    assert.equal(run('WAREHOUSE_ID'), 'CHINO');
    assert.equal(run('WAREHOUSE_NAME'), 'ONUS-CHINO');
    assert.equal(run('STORAGE_KEY'), 'outbound_pallet_staging_v2_chino');
    assert.equal(run('ACCESS_CODE_KEY'), 'outbound_access_code_v2_chino');
    run('loadState({ isBackgroundPoll: false, silent: true })');
    assert.ok(fake.calls.some(c => c.fn === 'loadBoardState'));
    assert.ok(fake.calls.every(c => c.warehouse === 'CHINO'), 'every request is tagged CHINO');

    const ont = loadApp({ withAppsScript: true });
    assert.equal(ont.run('WAREHOUSE_ID'), 'ONT', 'default stays ONT');
    assert.equal(ont.run('STORAGE_KEY'), 'outbound_pallet_staging_v2', 'ONT keeps its original storage');
});

test('an ONT device and a CHINO device never see each other\'s pallets', () => {
    const { A, B, settle, slps } = twoDevicesOnOneSheet({ searchA: '', searchB: '?wh=CHINO', chinoCode: 'test-code' });
    for (const d of [A, B]) { d.run('loadState({ isBackgroundPoll: false, silent: true })'); settle(); }
    A.run(`addSlpToStaging({ slp: 'SLP-ONT-1', orderNumber: 'SO-1', columnId: 'col-s52' })`); settle();
    B.run(`addSlpToStaging({ slp: 'SLP-CHINO-1', orderNumber: 'SO-2', columnId: 'col-s52' })`); settle();
    for (let i = 0; i < 2; i++) for (const d of [A, B]) { d.run('loadState({ isBackgroundPoll: true, silent: true })'); settle(); }
    assert.ok(slps(A).includes('SLP-ONT-1') && !slps(A).includes('SLP-CHINO-1'));
    assert.ok(slps(B).includes('SLP-CHINO-1') && !slps(B).includes('SLP-ONT-1'));
});

test('Code.gs TEST board: closed unless TEST_MODE is on, and only writes its own tabs', () => {
    const closed = loadCodeGs({ accessCode: 'ont-code', testMode: null });
    const res = closed.ctx.api({ fn: 'loadBoardState', args: [], warehouse: 'TEST' });
    assert.equal(res.ok, false);
    assert.match(res.error, /TEST_MODE/);
    assert.ok(!res.unauthorized, 'not treated as a wrong code');

    const { ctx, sheets } = loadCodeGs({ accessCode: 'ont-code', testMode: 'on' });
    const board = JSON.stringify({ columns: [], pallets: [{ id: 't1', slp: 'SLP-TEST' }], shippedPallets: [] });
    assert.equal(ctx.api({ fn: 'saveBoardState', args: [board, ''], warehouse: 'TEST' }).ok, true, 'no code needed');
    ctx.api({ fn: 'logScanEvents', args: [[{ id: 't-ev', action: 'SCAN', slp: 'SLP-TEST' }]], warehouse: 'TEST' });
    assert.ok(sheets.has('StateChunks TEST') && sheets.has('Scan Log TEST'));
    assert.equal(ctx.api({ fn: 'loadBoardState', args: [], key: 'ont-code' }).stateJson, null, 'ONT untouched');
    assert.equal(ctx.api({ fn: 'loadBoardState', args: [], key: 'wrong', warehouse: 'ONT' }).unauthorized, true, 'ONT still needs its code');
});

test('page ?wh=TEST syncs without asking for a code', () => {
    const { run, fake } = loadApp({ withAppsScript: true, accessCode: '', search: '?wh=TEST' });
    let boxShown = 0;
    run('showAccessCodeBox = () => {}');
    run('loadState({ isBackgroundPoll: false, silent: true })');
    assert.equal(run('WAREHOUSE_NAME'), 'ONUS-TEST');
    assert.ok(fake.calls.length > 0 && fake.calls.every(c => c.warehouse === 'TEST'));
    assert.equal(boxShown, 0);
});


test('over-capacity check counts floor spots (2x pairs = 1 spot) and ignores pallets already in the lane', () => {
    const { run } = loadApp();
    run(`appState.columns = [{ id: 'L1', name: 'L1', capacity: 2 }, { id: 'L2', name: 'L2', capacity: 8 }];
         appState.pallets = [${JSON.stringify(pallet('a', 'SLP-A', { columnId: 'L1' }))}, ${JSON.stringify(pallet('b', 'SLP-B', { columnId: 'L1' }))}];`);
    assert.equal(run(`getOverCapacityInfo('L1', [{ doubleStacked: false }])?.after`), 3, 'third single pallet → 3 of 2');
    assert.equal(run(`getOverCapacityInfo('L2', [{ doubleStacked: false }])`), null, 'fits');
    assert.equal(run(`getOverCapacityInfo('L1', [appState.pallets[0]])`), null, 'a pallet already in the lane is not counted twice');
    run(`appState.pallets = [${JSON.stringify(pallet('c', 'SLP-C', { columnId: 'L1', doubleStacked: true }))}, ${JSON.stringify(pallet('d', 'SLP-D', { columnId: 'L1' }))}];`);
    assert.equal(run(`getOverCapacityInfo('L1', [{ doubleStacked: true }])`), null, '2x pallet pairs with the existing 2x → still 2 spots');
    assert.equal(run(`getOverCapacityInfo('L1', [{ doubleStacked: false }])?.after`), 3);
});

test('quick add into a full lane asks first; "Put it anyway" adds it, cancel does not', () => {
    const { run, ctx } = loadApp();
    run(`appState.columns = [{ id: 'L1', name: 'L1', capacity: 1 }];
         appState.pallets = [${JSON.stringify(pallet('a', 'SLP-A', { columnId: 'L1' }))}];`);
    const fields = { 'quick-scan-location': { value: 'L1' }, 'quick-order-input': { value: 'SO-9', focus() {} }, 'quick-pallet-count': { value: '1', focus() {} }, 'quick-doublestack-chk': { checked: false } };
    ctx.document.getElementById = id => fields[id] || null;
    run(`openConfirmModal = (title, message, onConfirm, okLabel, okColor, onCancel) => { globalThis.__confirm = { title, message, onConfirm, onCancel }; }`);

    run(`handleQuickScanSubmit({ preventDefault() {} })`);
    assert.match(run('__confirm.message'), /L1 would use 2 of 1 floor spots/);
    assert.equal(run(`appState.pallets.some(p => p.orderNumber === 'SO-9')`), false, 'nothing added before answering');
    run('__confirm.onCancel()');
    assert.equal(run(`appState.pallets.some(p => p.orderNumber === 'SO-9')`), false, 'cancel → not added');

    run(`handleQuickScanSubmit({ preventDefault() {} })`);
    run('__confirm.onConfirm()');
    assert.equal(run(`appState.pallets.find(p => p.orderNumber === 'SO-9')?.columnId`), 'L1', '"Put it anyway" → added');
    assert.equal(fields['quick-order-input'].value, '', 'order box cleared for the next shipment');
});

test('shipment: order number + pallet count creates that many pallets, labelled ORDER-01…', () => {
    const { run } = loadApp();
    run(`appState.columns = [{ id: 'L1', name: 'S51', capacity: 8 }, { id: 'L2', name: 'S52', capacity: 8 }];
         appState.pallets = []; appState.shippedPallets = [{ id: 'x', slp: 'SO-41200-02', orderNumber: 'SO-41200' }];`);
    run(`requestAddShipment({ orderNumber: 'so-41200', count: '5', columnId: 'L1', carrier: 'Saia' })`);
    const labels = JSON.parse(run(`JSON.stringify(appState.pallets.map(p => p.slp))`));
    assert.deepEqual(labels, ['SO-41200-03', 'SO-41200-04', 'SO-41200-05', 'SO-41200-06', 'SO-41200-07'], 'numbering continues after shipped pallets');
    assert.equal(run(`appState.pallets.every(p => p.columnId === 'L1' && p.carrier === 'Saia' && p.orderNumber === 'SO-41200')`), true);
    run(`requestAddShipment({ orderNumber: 'SO-41200', count: '2', columnId: 'L1' })`);
    assert.equal(run(`appState.pallets.filter(p => p.columnId === 'L1').length`), 7);
    assert.equal(run(`appState.pallets[6].slp`), 'SO-41200-09');
    assert.equal(run(`appState.pallets[6].carrier`), 'Saia', 'later pallets inherit the carrier');
    assert.equal(run(`requestAddShipment({ orderNumber: '', count: '3', columnId: 'L1' })`), false, 'order number required');
    assert.equal(run(`requestAddShipment({ orderNumber: 'SO-1', count: '0', columnId: 'L1' })`), false, 'count required');
    assert.equal(run(`appState.pallets.length`), 7);
});

test('shipment too big for the lane → offer to spread over the next lanes (skipping lanes with other orders)', () => {
    const { run } = loadApp();
    run(`appState.columns = [{ id: 'c53', name: 'S53', capacity: 8 }, { id: 'c51', name: 'S51', capacity: 8 },
                             { id: 'c52', name: 'S52', capacity: 8 }, { id: 'c54', name: 'S54', capacity: 4 }, { id: 'c55', name: 'S55', capacity: 8 }];
         appState.pallets = [${JSON.stringify(pallet('o1', 'SO-7-01', { columnId: 'c51', orderNumber: 'SO-7' }))},
                             ${JSON.stringify(pallet('o2', 'SO-7-02', { columnId: 'c51', orderNumber: 'SO-7' }))},
                             ${JSON.stringify(pallet('x1', 'X-01', { columnId: 'c53', orderNumber: 'SO-OTHER' }))}];
         openConfirmModal = (title, message, onConfirm, okLabel) => { globalThis.__confirm = { title, message, onConfirm, okLabel }; };`);
    run(`requestAddShipment({ orderNumber: 'SO-7', count: '12', columnId: 'c51' })`);
    assert.equal(run('__confirm.title'), 'S51 has room for 6 of 12 pallets');
    assert.equal(run('__confirm.message'), 'Spread SO-7 over S51 (6), S52 (6)?', 'next lanes in number order');
    assert.equal(run('__confirm.okLabel'), 'Spread over lanes');
    assert.equal(run('appState.pallets.length'), 3, 'nothing added before answering');
    run('__confirm.onConfirm()');
    assert.equal(run(`appState.pallets.filter(p => p.columnId === 'c51').length`), 8);
    assert.equal(run(`appState.pallets.filter(p => p.columnId === 'c52').length`), 6);

    // S53 holds another order → skipped while lanes with room for only this order remain
    run(`requestAddShipment({ orderNumber: 'SO-7', count: '8', columnId: 'c52' })`);
    assert.equal(run('__confirm.message'), 'Spread SO-7 over S52 (2), S54 (4), S55 (2)?');

    // 2x pallets: 2 per floor spot
    run(`appState.pallets = []; globalThis.__confirm = null;`);
    run(`requestAddShipment({ orderNumber: 'SO-8', count: '16', columnId: 'c51', doubleStacked: true })`);
    assert.equal(run('__confirm'), null, '16 double-stacked pallets fit in 8 spots');
    assert.equal(run(`appState.pallets.filter(p => p.columnId === 'c51' && p.doubleStacked).length`), 16);
});

test('merge: same generated label from two devices keeps both pallets; a real SLP twice keeps one', () => {
    const { run } = loadApp();
    const a = [pallet('id-a1', 'SO-5-01', { orderNumber: 'SO-5' }), pallet('id-a2', 'SO-5-02', { orderNumber: 'SO-5' })];
    const b = [pallet('id-b1', 'SO-5-01', { orderNumber: 'SO-5' }), pallet('id-b2', 'SO-5-02', { orderNumber: 'SO-5' }), pallet('id-b3', 'SO-5-03', { orderNumber: 'SO-5' })];
    const dupSlp = [pallet('x1', 'SLP-884101', { orderNumber: 'SO-6' }), pallet('x2', 'SLP-884101', { orderNumber: 'SO-6' })];
    const ab = JSON.parse(run(`JSON.stringify(resolveDuplicatePalletLabels(${JSON.stringify([...a, ...b, ...dupSlp])}))`));
    const ba = JSON.parse(run(`JSON.stringify(resolveDuplicatePalletLabels(${JSON.stringify([...b, ...a, ...dupSlp])}))`));
    const labels = list => Object.fromEntries(list.map(p => [p.id, p.slp]));
    assert.equal(ab.filter(p => p.orderNumber === 'SO-5').length, 5, 'all 5 pallets kept');
    assert.equal(new Set(ab.map(p => p.slp)).size, ab.length, 'labels are unique');
    assert.deepEqual(labels(ab), labels(ba), 'every device ends up with the same labels');
    assert.equal(ab.filter(p => p.slp === 'SLP-884101').length, 1, 'a real barcode scanned twice is kept once');
});

test('built-in demo pallets never come back: new devices start empty and merges drop them', () => {
    const { run } = loadApp();
    assert.equal(run('createInitialDemoState().pallets.length'), 0);
    const demo = pallet('plt-demo-1', 'SLP-884101', { orderNumber: 'SO-40118' });
    const real = pallet('p-1', 'SO-1-01', { orderNumber: 'SO-1' });
    const merged = JSON.parse(run(`JSON.stringify(mergeBoardStates(null, { ...appState, pallets: [${JSON.stringify(demo)}] }, { ...appState, pallets: [${JSON.stringify(real)}] }))`));
    assert.deepEqual(merged.pallets.map(p => p.id), ['p-1']);
});

test('board: lanes in number order; search shows only lanes with a match', () => {
    const { run, ctx } = loadApp();
    const board = { innerHTML: '', className: '', style: {}, classList: { add() {}, remove() {} } };
    const realGet = ctx.document.getElementById;
    ctx.document.getElementById = id => (id === 'staging-board' ? board : realGet(id));
    run(`appState.columns = [{ id: 'c62', name: 'S62', capacity: 8 }, { id: 'c30', name: 'S30', capacity: 8 }, { id: 'c51', name: 'S51', capacity: 8 }, { id: 'c5', name: 'S5', capacity: 8 }];
         appState.pallets = [${JSON.stringify(pallet('a', 'SO-1-01', { columnId: 'c51', orderNumber: 'SO-1', carrier: 'Saia' }))},
                             ${JSON.stringify(pallet('b', 'SO-2-01', { columnId: 'c62', orderNumber: 'SO-2', carrier: 'Estes Express' }))}];
         searchQuery = ''; selectedCarrierFilter = ''; renderBoard();`);
    assert.deepEqual(JSON.parse(run('JSON.stringify(appState.columns.map(c => c.name))')), ['S5', 'S30', 'S51', 'S62']);
    run(`const zoneCols = appState.columns.slice(); appState.columns = [{ id: 'w1', name: 'W05.100', capacity: 4 }, { id: 'n1', name: 'N09.12', capacity: 12 },
         { id: 'w2', name: 'W05.89', capacity: 4 }, ...zoneCols, { id: 'n2', name: 'N09.5', capacity: 4 }, { id: 'w3', name: 'W06.61', capacity: 4 }];
         sortColumnsByLaneNumber(appState.columns);`);
    assert.deepEqual(JSON.parse(run('JSON.stringify(appState.columns.map(c => c.name))')),
        ['S5', 'S30', 'S51', 'S62', 'N09.5', 'N09.12', 'W05.89', 'W05.100', 'W06.61'], 'S lanes first, then zones in order');
    run(`appState.columns = appState.columns.filter(c => /^S/.test(c.name));`);
    const lanesIn = () => [...board.innerHTML.matchAll(/id="lane-card-([^"]+)"/g)].map(m => m[1]);
    assert.deepEqual(lanesIn(), ['c5', 'c30', 'c51', 'c62']);
    run(`searchQuery = 'estes'; renderBoard();`);
    assert.deepEqual(lanesIn(), ['c62'], 'carrier search → only that lane');
    run(`searchQuery = 'so-1'; renderBoard();`);
    assert.deepEqual(lanesIn(), ['c51'], 'order search → only that lane');
    run(`searchQuery = 's30'; renderBoard();`);
    assert.deepEqual(lanesIn(), ['c30'], 'lane name still finds the (empty) lane');
    run(`searchQuery = 'nothing-here'; renderBoard();`);
    assert.match(board.innerHTML, /No lane has a pallet matching/);
});

test('delete order: asks first, then removes only that order (not shipped) and logs REMOVE', () => {
    const { run } = loadApp();
    run(`appState.columns = [{ id: 'c51', name: 'S51', capacity: 8 }, { id: 'c52', name: 'S52', capacity: 8 }];
         appState.pallets = [${JSON.stringify(pallet('a', 'SO-1-01', { columnId: 'c51', orderNumber: 'SO-1' }))},
                             ${JSON.stringify(pallet('b', 'SO-1-02', { columnId: 'c52', orderNumber: 'SO-1' }))},
                             ${JSON.stringify(pallet('c', 'SO-2-01', { columnId: 'c51', orderNumber: 'SO-2' }))}];
         appState.shippedPallets = [];
         globalThis.__logged = []; logScanEvent = (action, p) => __logged.push(action + ':' + p.slp);
         openConfirmModal = (title, message, onConfirm, okLabel) => { globalThis.__confirm = { title, message, onConfirm, okLabel }; };`);
    run(`confirmDeleteWholeOrder('so-1')`);
    assert.equal(run('__confirm.title'), 'Delete Order SO-1?');
    assert.match(run('__confirm.message'), /all 2 pallet\(s\) of SO-1 from S51, S52/);
    assert.equal(run('appState.pallets.length'), 3, 'nothing removed before confirming');
    run('__confirm.onConfirm()');
    assert.deepEqual(JSON.parse(run('JSON.stringify(appState.pallets.map(p => p.slp))')), ['SO-2-01']);
    assert.equal(run('appState.shippedPallets.length'), 0, 'not logged as shipped');
    assert.deepEqual(JSON.parse(run('JSON.stringify(__logged)')), ['REMOVE:SO-1-01', 'REMOVE:SO-1-02']);
});

test('order picker: lists released intake orders with pallets left, oldest first; carrier comes from intake', () => {
    const { run } = loadApp();
    run(`appState.columns = [{ id: 'c51', name: 'S51', capacity: 8 }, { id: 'c52', name: 'S52', capacity: 8 }];
         appState.pallets = [${JSON.stringify(pallet('a', 'DN1-01', { columnId: 'c51', orderNumber: 'DN1' }))},
                             ${JSON.stringify(pallet('b', 'DN1-02', { columnId: 'c51', orderNumber: 'DN1' }))},
                             ${JSON.stringify(pallet('c', 'DN3-01', { columnId: 'c52', orderNumber: 'DN3' }))}];
         appState.shippedPallets = [{ id: 's', slp: 'DN1-03', orderNumber: 'DN1', shippedAt: 1 }];
         intakeOrders = [
            { orderNumber: 'dn1', customer: 'Acme', pallets: 6, carrier: 'Saia', destination: 'Phoenix', status: 'Released', releasedAt: '2026-11-24T10:00:00Z' },
            { orderNumber: 'DN2', customer: 'Beta', pallets: 2, carrier: 'Estes Express', status: 'Released', releasedAt: '2026-11-24T08:00:00Z' },
            { orderNumber: 'DN3', customer: 'Done', pallets: 1, status: 'Released', releasedAt: '2026-11-24T07:00:00Z' },
            { orderNumber: 'DN4', customer: 'No count', pallets: null, status: 'Released', releasedAt: '2026-11-24T09:00:00Z' },
            { orderNumber: 'DN5', customer: 'Gone', pallets: 3, status: 'Cancelled', releasedAt: '2026-11-24T06:00:00Z' }
         ];
         intakeOrdersLoadedAt = Date.now();`);
    const list = JSON.parse(run('JSON.stringify(availableIntakeOrders().map(o => [o.orderNumber, o.remaining]))'));
    assert.deepEqual(list, [['DN2', 2], ['DN4', null], ['DN1', 3]], 'fully staged and cancelled orders are left out');

    run(`openConfirmModal = (t, m, ok) => ok();`);
    run(`requestAddShipment({ orderNumber: 'DN2', count: '2', columnId: 'c52' })`);
    assert.equal(run(`appState.pallets.filter(p => p.orderNumber === 'DN2' && p.carrier === 'Estes Express').length`), 2);
    assert.deepEqual(JSON.parse(run('JSON.stringify(availableIntakeOrders().map(o => o.orderNumber))')), ['DN4', 'DN1'], 'DN2 drops off once staged');
    run(`requestAddShipment({ orderNumber: 'DN1', count: '1', columnId: 'c51', carrier: 'Own carrier' })`);
    assert.equal(run(`appState.pallets.filter(p => p.orderNumber === 'DN1').pop().carrier`), 'Own carrier', 'a carrier typed on the floor wins');
});

test('Code.gs resolveWarehouse: the code says which warehouse it opens', () => {
    const { ctx } = loadCodeGs({ accessCode: 'ont-code', chinoCode: 'chino-code', testMode: 'on' });
    const r = key => JSON.parse(JSON.stringify(ctx.api({ fn: 'resolveWarehouse', key })));
    assert.deepEqual(r('ont-code'), { ok: true, warehouse: 'ONT', role: 'floor' });
    assert.deepEqual(r('chino-code'), { ok: true, warehouse: 'CHINO', role: 'floor' });
    assert.equal(r('nope').unauthorized, true);
    assert.equal(r('').unauthorized, true);
    assert.equal(r('test-mode').unauthorized, true, 'TEST is never chosen by a code');
});

test('page: entering the Chino code on the ONT page saves it for Chino and switches warehouse', () => {
    const { run, ctx, fake } = loadApp({ withAppsScript: true, accessCode: '' });
    fake.responses.resolveWarehouse = [{ ok: true, warehouse: 'CHINO' }];
    run(`switchWarehouse = id => { globalThis.__switchedTo = id; }; showToast = () => {};`);
    const calls = [];
    run(`resolveWarehouseFromCode('chino-code', { onWarehouse: id => openWarehouseWithCode(id, 'chino-code'), onRejected() {}, onOffline() {} })`);
    assert.equal(run('__switchedTo'), 'CHINO');
    assert.equal(ctx.localStorage.getItem('outbound_access_code_v2_chino'), 'chino-code', 'code saved for Chino');
    assert.equal(ctx.localStorage.getItem('outbound_access_code_v2') || '', '', 'not saved as the ONT code');
    const lookup = fake.calls.find(c => c.fn === 'resolveWarehouse');
    assert.equal(lookup.key, 'chino-code');
});

test('page: an unknown code is rejected in the box and nothing is saved', () => {
    const { run, ctx, fake } = loadApp({ withAppsScript: true, accessCode: '' });
    fake.responses.resolveWarehouse = [{ ok: false, unauthorized: true }];
    run(`resolveWarehouseFromCode('bad', { onWarehouse() { globalThis.__r = 'opened'; }, onRejected() { globalThis.__r = 'rejected'; }, onOffline() { globalThis.__r = 'offline'; } })`);
    assert.equal(run('__r'), 'rejected');
    assert.equal(ctx.localStorage.getItem('outbound_access_code_v2') || '', '');
});

test('page: an older server without the lookup uses the code for the warehouse on screen', () => {
    const { run, fake } = loadApp({ withAppsScript: true, accessCode: '' });
    fake.responses.resolveWarehouse = [{ ok: false, error: 'Unknown request: resolveWarehouse' }];
    run(`resolveWarehouseFromCode('x', { onWarehouse: id => { globalThis.__r = id; }, onRejected() {}, onOffline() {} })`);
    assert.equal(run('__r'), 'ONT');
});

test('a request Google never answers times out, and syncing recovers instead of staying stuck', () => {
    // google.script.run that never calls back (a stalled request)
    const hanging = { script: {} };
    Object.defineProperty(hanging.script, 'run', {
        get() { const r = { withSuccessHandler() { return r; }, withFailureHandler() { return r; }, api() { /* never answers */ } }; return r; }
    });
    const { run, fireLongTimers } = loadApp({ withAppsScript: true, googleImpl: hanging });
    run('loadState({ isBackgroundPoll: false, silent: true })');
    assert.equal(run('isCloudLoadInFlight'), true, 'waiting on the stalled request');
    fireLongTimers(); // 25 s pass
    assert.equal(run('isCloudLoadInFlight'), false, 'time limit released the load');

    run('executeCloudSaveNow()');
    assert.equal(run('isCloudSaveInFlight'), true);
    fireLongTimers();
    assert.equal(run('isCloudSaveInFlight'), false, 'time limit released the save');
    assert.equal(run('lastCloudSaveFailed'), true, 'reported as a failed save, so it is retried');
});

test('a late answer after the time limit is ignored (no double handling)', () => {
    let answer = null;
    const slow = { script: {} };
    Object.defineProperty(slow.script, 'run', {
        get() { let ok = () => {}; const r = { withSuccessHandler(f) { ok = f; return r; }, withFailureHandler() { return r; }, api() { answer = ok; } }; return r; }
    });
    const { run, fireLongTimers } = loadApp({ withAppsScript: true, googleImpl: slow });
    run(`globalThis.__calls = 0; callCloud('loadBoardState', [], () => { __calls++; }, () => { __calls += 10; })`);
    fireLongTimers();
    answer({ ok: true });
    assert.equal(run('__calls'), 10, 'only the timeout was handled');
});

test('merge keeps docks and carriers added on either device', () => {
    const { run } = loadApp();
    const base = { columns: [], pallets: [], shippedPallets: [], docks: ['DOCK-01', 'DOCK-02'], carriers: ['FedEx'] };
    const local = { ...base, docks: ['DOCK-01', 'DOCK-02', 'DOCK-13'], carriers: ['FedEx', 'Saia'] };
    const remote = { ...base, docks: ['DOCK-01', 'DOCK-02', 'DOCK-14'], carriers: ['FedEx'] };
    const m = run(`JSON.stringify(mergeBoardStates(${JSON.stringify(base)}, ${JSON.stringify(local)}, ${JSON.stringify(remote)}))`);
    const merged = JSON.parse(m);
    assert.deepEqual(merged.docks, ['DOCK-01', 'DOCK-02', 'DOCK-14', 'DOCK-13']);
    assert.deepEqual(merged.carriers, ['FedEx', 'Saia']);

    const removed = JSON.parse(run(`JSON.stringify(mergeBoardStates(${JSON.stringify(base)}, ${JSON.stringify({ ...base, docks: ['DOCK-01'] })}, ${JSON.stringify(remote)}))`));
    assert.deepEqual(removed.docks, ['DOCK-01', 'DOCK-14'], 'a dock removed on this device stays removed');

    const noBase = JSON.parse(run(`JSON.stringify(mergeBoardStates(null, ${JSON.stringify(local)}, ${JSON.stringify(remote)}))`));
    assert.ok(noBase.docks.includes('DOCK-13') && noBase.docks.includes('DOCK-14'), 'never-synced device: keep both sides');
});


// ---------------------------------------------------------------------------------------------
// Order intake (Orders tab)
// ---------------------------------------------------------------------------------------------
function intakeGs({ autoName = true } = {}) {
    const gs = loadCodeGs({ extraProps: { CS_CODE: 'cs-1', WMS_API_KEY: 'wms-key-1', CS_CODE_CHINO: 'cs-chino', ACCESS_CODE_CHINO: 'chino-1' } });
    if (autoName) {
        // The page always sends the user's name; tests that don't care about names get "Tester"
        const api = gs.ctx.api;
        gs.ctx.api = req => (req.fn === 'upsertOrders'
            ? api({ ...req, args: [req.args[0], { enteredBy: 'Tester', ...(req.args[1] || {}) }] })
            : api(req));
    }
    return gs;
}

test('orders: Order Ready Date is saved, updated and listed', () => {
    const { ctx } = intakeGs();
    const call = (fn, args, key = 'cs-1') => JSON.parse(JSON.stringify(ctx.api({ fn, key, args })));
    assert.equal(call('upsertOrders', [[{ orderNumber: 'R1', customer: 'Acme', readyDate: '2026-11-27', shipDate: '2026-11-28' }]]).inserted, 1);
    assert.equal(call('listOrders', []).orders.find(o => o.orderNumber === 'R1').readyDate, '2026-11-27');
    call('upsertOrders', [[{ orderNumber: 'R1', readyDate: '2026-11-29' }]], 'wms-key-1');
    const r1 = call('listOrders', []).orders.find(o => o.orderNumber === 'R1');
    assert.equal(r1.readyDate, '2026-11-29', 'the WMS can update it too');
    assert.equal(r1.shipDate, '2026-11-28', 'other fields kept');
});

test('orders: a name is required to create, import or cancel; Created By is kept from the first save', () => {
    const { ctx } = intakeGs({ autoName: false });
    const call = (fn, args, key = 'cs-1') => JSON.parse(JSON.stringify(ctx.api({ fn, key, args })));
    const noName = call('upsertOrders', [[{ orderNumber: 'N1', customer: 'Acme' }]]);
    assert.equal(noName.ok, false);
    assert.equal(noName.needName, true);
    assert.equal(call('upsertOrders', [[{ orderNumber: 'N1', customer: 'Acme', enteredBy: '  ' }], { enteredBy: '' }]).needName, true, 'blank names do not count');
    assert.equal(call('upsertOrders', [[{ orderNumber: 'N1', customer: 'Acme' }], { enteredBy: 'Amy' }]).inserted, 1, 'batch-level name');
    assert.equal(call('upsertOrders', [[{ orderNumber: 'N2', customer: 'Acme', enteredBy: 'Bo' }]]).inserted, 1, 'per-order name');
    assert.equal(call('upsertOrders', [[{ orderNumber: 'N1', pallets: 4 }], { enteredBy: 'Cy' }]).updated, 1);
    assert.equal(call('upsertOrders', [[{ orderNumber: 'W1', customer: 'Feed' }]], 'wms-key-1').inserted, 1, 'the WMS key needs no name');
    assert.equal(call('setOrderStatus', ['N2', 'Cancelled', '']).needName, true);
    const list = call('listOrders', []).orders;
    const n1 = list.find(o => o.orderNumber === 'N1');
    assert.equal(n1.createdBy, 'Amy', 'created by the first person');
    assert.equal(n1.enteredBy, 'Cy', 'entered by the last person to save');
    assert.equal(list.find(o => o.orderNumber === 'N2').createdBy, 'Bo');
    assert.equal(list.find(o => o.orderNumber === 'W1').createdBy, '');
});

test('orders: CS code and WMS key reach only the order functions; WMS key is not a sign-in code', () => {
    const { ctx } = intakeGs();
    const call = (fn, key, args = [], warehouse) => ctx.api({ fn, key, args, warehouse });
    assert.equal(call('listOrders', 'cs-1').ok, true);
    assert.equal(call('loadBoardState', 'cs-1').unauthorized, true, 'CS code cannot read the board');
    assert.equal(call('saveBoardState', 'cs-1', ['{}', null]).unauthorized, true);
    assert.equal(call('orderProgress', 'cs-1').ok, true);
    assert.equal(call('upsertOrders', 'wms-key-1', [[{ orderNumber: 'A1', customer: 'Acme' }]]).ok, true);
    assert.equal(call('orderProgress', 'wms-key-1').unauthorized, true, 'WMS key only pushes/lists orders');
    assert.equal(call('listOrders', 'cs-1', [], 'CHINO').unauthorized, true, 'ONT CS code does not open Chino');
    assert.equal(call('listOrders', 'cs-chino', [], 'CHINO').ok, true);
    assert.equal(call('listOrders', 'secret-1').ok, true, 'floor code can do everything');
    const r = JSON.parse(JSON.stringify(ctx.api({ fn: 'resolveWarehouse', key: 'cs-chino' })));
    assert.deepEqual(r, { ok: true, warehouse: 'CHINO', role: 'cs' });
    assert.equal(ctx.api({ fn: 'resolveWarehouse', key: 'wms-key-1' }).ok, false);
});

test('orders: upsert adds, updates only the fields sent, validates, and keeps history on cancel', () => {
    const { ctx, sheets } = intakeGs();
    const call = (fn, args) => JSON.parse(JSON.stringify(ctx.api({ fn, key: 'cs-1', args })));
    const first = call('upsertOrders', [[
        { orderNumber: ' dn2611190307 ', customer: 'Acme Corp', cartons: '1,200', pallets: 16, refType: 'ARN#', reference: 'ARN-889', orderType: 'LTL', carrier: 'Saia', enteredBy: 'Amy' },
        { orderNumber: 'DN2', customer: 'Beta', releasedAt: '2026-11-24T15:30:00Z', pallets: 'x' },
        { orderNumber: '', customer: 'No number' },
        { orderNumber: 'DN3', cartons: 5 }
    ], { source: 'Manual' }]);
    assert.equal(first.inserted, 1);
    assert.deepEqual(first.errors.map(e => e.error), ['Pallets must be a whole number', 'Order # is missing', 'Customer is missing']);

    // WMS import of the same order with only some columns: carrier stays, pallets updated
    const second = call('upsertOrders', [[{ orderNumber: 'DN2611190307', pallets: 18, cartons: '' }], { source: 'WMS import' }]);
    assert.deepEqual([second.inserted, second.updated], [0, 1]);
    const skip = call('upsertOrders', [[{ orderNumber: 'DN2611190307', pallets: 1 }], { mode: 'insertOnly' }]);
    assert.equal(skip.skipped, 1);

    let o = call('listOrders', [{ days: 0 }]).orders[0];
    assert.equal(o.orderNumber, 'DN2611190307');
    assert.equal(o.pallets, 18);
    assert.equal(o.cartons, null, 'blank sent → cleared');
    assert.equal(o.carrier, 'Saia', 'not sent → kept');
    assert.equal(o.status, 'Released');
    assert.equal(o.source, 'Manual');
    assert.ok(o.releasedAt, 'release time defaults to now');

    assert.equal(call('setOrderStatus', ['dn2611190307', 'cancelled', 'Amy']).order.status, 'Cancelled');
    o = call('listOrders', [{ days: 0 }]).orders[0];
    assert.equal(o.status, 'Cancelled');
    const rows = sheets.get('Orders').rows;
    assert.equal(rows.length, 2, 'header + 1 order, nothing deleted');
    assert.equal(rows[0][0], 'Order #');
    assert.equal(call('upsertOrders', [[{ orderNumber: 'A', customer: 'x' }, { orderNumber: 'a', customer: 'y' }]]).errors[0].error.startsWith('Order # appears twice'), true);
});

test('orders: Picker and VRID are saved; an older Orders tab gets the new headers added at the end', () => {
    const { ctx, sheets } = intakeGs();
    const call = (fn, args) => JSON.parse(JSON.stringify(ctx.api({ fn, key: 'cs-1', args })));
    // An Orders tab created before Picker/VRID existed (19 columns)
    const oldHeaders = ['Order #', 'Customer', 'Released to Warehouse', 'Cartons', 'Pallets', 'Reference Type', 'Reference', 'Order Type',
        'Carrier', 'SCAC', 'PRO / BOL', 'Ship / Appt Date', 'Destination', 'Notes', 'Status', 'Source', 'Entered By', 'Created', 'Updated'];
    const ss = ctx.SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.insertSheet('Orders');
    sheet.getRange(1, 1, 1, oldHeaders.length).setValues([oldHeaders]);
    sheet.getRange(2, 1, 1, oldHeaders.length).setValues([['OLD-1', 'Old Co', '', 3, 2, '', '', '', 'Saia', '', '', '', '', '', 'Released', 'Manual', '', '', '']]);
    const r = call('upsertOrders', [[{ orderNumber: 'NEW-1', customer: 'New Co', picker: 'Jose', vrid: '115XYZ7AB' }, { orderNumber: 'OLD-1', vrid: 'VR-9' }]]);
    assert.deepEqual([r.inserted, r.updated], [1, 1]);
    const rows = sheets.get('Orders').rows;
    assert.deepEqual(rows[0].slice(19, 21), ['Picker', 'VRID']);
    assert.equal(rows[1][8], 'Saia', 'old row stays lined up');
    const list = call('listOrders', [{ days: 0 }]).orders;
    assert.equal(list.find(o => o.orderNumber === 'NEW-1').picker, 'Jose');
    assert.equal(list.find(o => o.orderNumber === 'OLD-1').vrid, 'VR-9');
});

test('import templates: saved per warehouse, replaced by name, listed A→Z, deleted; WMS key cannot use them', () => {
    const { ctx } = intakeGs();
    const call = (fn, args, key = 'cs-1', warehouse) => JSON.parse(JSON.stringify(ctx.api({ fn, key, args, warehouse })));
    const t1 = { mapping: { orderNumber: ['Delivery No'], destination: ['City', 'State'] }, defaults: { refType: 'ARN#' }, headerRow: 3, sheetName: 'Orders' };
    assert.equal(call('saveImportTemplate', ['  Amazon   VRID report ', t1, 'Amy']).name, 'Amazon VRID report');
    assert.equal(call('saveImportTemplate', ['Daily WMS', { mapping: { orderNumber: ['Order'] } }, 'Bo']).ok, true);
    const again = call('saveImportTemplate', ['amazon vrid REPORT', Object.assign({}, t1, { headerRow: 1 }), 'Amy']);
    assert.equal(again.replaced, true, 'same name (any case) replaces');
    let list = call('listImportTemplates', []).templates;
    assert.deepEqual(list.map(x => x.name), ['amazon vrid REPORT', 'Daily WMS']);
    assert.equal(list[0].template.headerRow, 1);
    assert.deepEqual(list[0].template.mapping.destination, ['City', 'State']);
    assert.equal(list[0].updatedBy, 'Amy');
    assert.equal(call('saveImportTemplate', ['', {}]).ok, false, 'name required');
    assert.equal(call('listImportTemplates', [], 'cs-chino', 'CHINO').templates.length, 0, 'Chino has its own templates');
    assert.equal(call('listImportTemplates', [], 'wms-key-1').unauthorized, true);
    assert.equal(call('deleteImportTemplate', ['Daily wms']).ok, true);
    list = call('listImportTemplates', []).templates;
    assert.deepEqual(list.map(x => x.name), ['amazon vrid REPORT']);
    assert.equal(call('deleteImportTemplate', ['nope']).ok, false);
});

test('orders: stage lanes from the board are written into the Orders tab by Order #', () => {
    const { ctx, sheets } = intakeGs();
    const call = (fn, args, key = 'cs-1') => JSON.parse(JSON.stringify(ctx.api({ fn, key, args })));
    const save = state => ctx.api({ fn: 'saveBoardState', key: 'secret-1', args: [JSON.stringify(state), null] });
    // No Orders tab yet: saving the board must not create one
    save({ columns: [], pallets: [] });
    assert.equal(sheets.has('Orders'), false);

    call('upsertOrders', [[{ orderNumber: 'DN1', customer: 'A' }, { orderNumber: 'DN2', customer: 'B' }]]);
    const cols = [{ id: 'c52', name: 'S52' }, { id: 'c51', name: 'S51' }, { id: 'w', name: 'W05.90' }];
    save({ columns: cols, pallets: [
        { id: 'p1', orderNumber: 'dn1', columnId: 'c52', dockNumber: 'DOCK-03' },
        { id: 'p2', orderNumber: 'DN1', columnId: 'c51', dockNumber: '' },
        { id: 'p3', orderNumber: 'DN1', columnId: 'w', dockNumber: '' }
    ], shippedPallets: [] });
    let o = Object.fromEntries(call('listOrders', [{ days: 0 }]).orders.map(x => [x.orderNumber, x]));
    assert.equal(o.DN1.stageLanes, 'S51, S52, W05.90');
    assert.equal(o.DN1.dock, 'D3');
    assert.equal(o.DN1.palletsOnFloor, 3);
    assert.equal(o.DN1.palletsShipped, 0);
    assert.ok(o.DN1.floorUpdatedAt);
    assert.equal(o.DN2.stageLanes, '', 'not on the floor');
    assert.equal(o.DN2.palletsOnFloor, null);

    // Everything ships: lanes kept for history, counts updated
    save({ columns: cols, pallets: [], shippedPallets: [{ id: 's1', orderNumber: 'DN1' }, { id: 's2', orderNumber: 'DN1' }, { id: 's3', orderNumber: 'DN1' }] });
    o = Object.fromEntries(call('listOrders', [{ days: 0 }]).orders.map(x => [x.orderNumber, x]));
    assert.deepEqual([o.DN1.stageLanes, o.DN1.dock, o.DN1.palletsOnFloor, o.DN1.palletsShipped], ['S51, S52, W05.90', '', 0, 3]);

    // An order entered after the floor already staged it gets its lanes right away
    save({ columns: cols, pallets: [{ id: 'p9', orderNumber: 'DN9', columnId: 'c51' }], shippedPallets: [] });
    call('upsertOrders', [[{ orderNumber: 'DN9', customer: 'Late entry' }]]);
    o = Object.fromEntries(call('listOrders', [{ days: 0 }]).orders.map(x => [x.orderNumber, x]));
    assert.equal(o.DN9.stageLanes, 'S51');
    assert.deepEqual(sheets.get('Orders').rows[0].slice(-7), ['Stage Lanes', 'Dock', 'Pallets On Floor', 'Pallets Shipped', 'Floor Updated', 'Created By', 'Order Ready Date']);
});

test('reports: floor history from the Scan Log per order, activity in range, floor orders missing from intake', () => {
    const { ctx } = intakeGs();
    const call = (fn, args, key = 'cs-1') => JSON.parse(JSON.stringify(ctx.api({ fn, key, args })));
    const day = Date.parse('2026-11-24T08:00:00Z');
    const H = 3600000;
    call('upsertOrders', [[
        { orderNumber: 'DN1', customer: 'Acme', pallets: 2, releasedAt: new Date(day).toISOString() },
        { orderNumber: 'DN2', customer: 'Beta', pallets: 3, releasedAt: new Date(day + 2 * H).toISOString() },
        { orderNumber: 'OLD', customer: 'Gone', pallets: 1, releasedAt: new Date(day - 30 * 24 * H).toISOString() }
    ]]);
    const ev = (id, h, action, slp, ord, toLane = '', dock = '') => ({ id, time: day + h * H, action, slp, orderNumber: ord, toLane, dockNumber: dock });
    ctx.api({ fn: 'logScanEvents', key: 'secret-1', args: [[
        ev('e1', 1, 'SCAN', 'DN1-01', 'DN1', 'S51'), ev('e2', 1, 'SCAN', 'DN1-02', 'DN1', 'S51'),
        ev('e3', 3, 'MOVE', 'DN1-02', 'DN1', 'S52'), ev('e4', 4, 'DOCK', 'DN1-01', 'DN1', 'DOCK-03'),
        ev('e5', 5, 'SHIP', 'DN1-01', 'DN1', '', 'DOCK-03'), ev('e6', 5.5, 'SHIP', 'DN1-02', 'DN1', '', 'DOCK-03'),
        ev('e7', 6, 'SCAN', 'DN2-01', 'DN2', 'S53'),
        ev('e8', 6, 'SCAN', 'X-01', 'DN9', 'W06.74'),
        ev('e9', -48, 'SCAN', 'OLD-01', 'OLD', 'S60'), ev('e10', -47, 'SHIP', 'OLD-01', 'OLD')
    ]] });
    ctx.api({ fn: 'saveBoardState', key: 'secret-1', args: [JSON.stringify({ columns: [{ id: 'c', name: 'S53' }, { id: 'w', name: 'W06.74' }],
        pallets: [{ id: 'a', orderNumber: 'DN2', columnId: 'c' }, { id: 'b', orderNumber: 'DN9', columnId: 'w' }] }), null] });

    const r = call('reportData', [{ from: new Date(day).toISOString(), to: new Date(day + 24 * H).toISOString() }]);
    assert.equal(r.ok, true);
    assert.deepEqual(r.orders.map(o => o.orderNumber).sort(), ['DN1', 'DN2'], 'old shipped order left out');
    const f = r.floor.DN1;
    assert.deepEqual([f.scanned, f.shipped, f.firstScanAt, f.firstDockAt, f.lastShipAt], [2, 2, day + H, day + 4 * H, day + 5.5 * H]);
    assert.deepEqual(f.lanes, ['S51', 'S52']);
    assert.deepEqual(f.docks, ['DOCK-03']);
    assert.equal(r.activity.SCAN, 4);
    assert.equal(r.activity.SHIP, 2);
    assert.equal(r.progress.DN2.staged, 1);
    assert.deepEqual(r.floorOnly.map(x => [x.orderNumber, x.onFloor, x.lanes.join()]), [['DN9', 1, 'W06.74']]);
    assert.equal(call('reportData', [{ from: '2026-11-25T00:00:00Z', to: '2026-11-24T00:00:00Z' }]).ok, false);
    assert.equal(call('reportData', [{}], 'wms-key-1').unauthorized, true);
});

test('orders: progress counts staged, at dock and shipped pallets per order from the board', () => {
    const { ctx } = intakeGs();
    const state = {
        columns: [{ id: 'c1', name: 'S51' }, { id: 'c2', name: 'S52' }],
        pallets: [
            { id: 'p1', orderNumber: 'dn9', columnId: 'c1', dockNumber: 'DOCK-03', createdAt: 100 },
            { id: 'p2', orderNumber: 'DN9', columnId: 'c2', dockNumber: '', createdAt: 50 },
            { id: 'p3', orderNumber: 'DN8', columnId: 'c1', dockNumber: '', createdAt: 70 }
        ],
        shippedPallets: [{ id: 's1', orderNumber: 'DN9', shippedAt: 500 }]
    };
    ctx.api({ fn: 'saveBoardState', key: 'secret-1', args: [JSON.stringify(state), null] });
    const p = JSON.parse(JSON.stringify(ctx.api({ fn: 'orderProgress', key: 'cs-1' }))).progress;
    assert.deepEqual(p.DN9, { staged: 2, atDock: 1, docks: ['DOCK-03'], lanes: ['S51', 'S52'], shipped: 1, firstStagedAt: 50, lastShippedAt: 500 });
    assert.equal(p.DN8.staged, 1);
});
