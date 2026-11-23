// Runs the real Code.gs against an in-memory spreadsheet and answers like the /exec web app.
// POST /exec  → api(request)        GET /dump → every sheet's rows (for checking results)
import http from 'node:http';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const CODE_GS = process.argv[2] || new URL('../../Code.gs', import.meta.url).pathname;
const PORT = Number(process.argv[3] || 8790);
const PROPS = { ACCESS_CODE: 'ont-e2e', ACCESS_CODE_CHINO: 'chino-e2e', TEST_MODE: process.env.TEST_MODE || null };

const sheets = new Map(); // name -> rows[][]
function makeSheet(name) {
    const rows = [];
    const range = (r, c, nr = 1, nc = 1) => ({
        setValues(v) { v.forEach((row, i) => { const t = (rows[r - 1 + i] = rows[r - 1 + i] || []); row.forEach((x, j) => { t[c - 1 + j] = x; }); }); return this; },
        setValue(v) { (rows[r - 1] = rows[r - 1] || [])[c - 1] = v; return this; },
        getValue() { return (rows[r - 1] || [])[c - 1] ?? ''; },
        getValues() { return Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => (rows[r - 1 + i] || [])[c - 1 + j] ?? '')); },
        setNumberFormat() { return this; }, setFontWeight() { return this; },
        clearContent() { for (let i = 0; i < nr; i++) if (rows[r - 1 + i]) rows[r - 1 + i][c - 1] = ''; return this; }
    });
    const sheet = {
        rows,
        getLastRow: () => rows.length,
        setFrozenRows() {},
        getRange(a, c, nr, nc) {
            if (typeof a !== 'string') return range(a, c, nr, nc);
            const m = /^([A-Z])(\d+)(?::([A-Z])(\d+))?$/.exec(a);
            if (!m) return range(1, 1);
            const col = m[1].charCodeAt(0) - 64;
            return range(Number(m[2]), col, 1, m[3] ? m[3].charCodeAt(0) - 64 - col + 1 : 1);
        }
    };
    sheets.set(name, sheet);
    return sheet;
}

const cache = new Map();
const ctx = {
    SpreadsheetApp: {
        getActiveSpreadsheet: () => ({ getSheetByName: n => sheets.get(n) || null, insertSheet: n => makeSheet(n) }),
        flush() {}
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    CacheService: {
        getScriptCache: () => ({
            getAll: ks => Object.fromEntries(ks.filter(k => cache.has(k)).map(k => [k, '1'])),
            putAll: o => Object.keys(o).forEach(k => cache.set(k, '1'))
        })
    },
    Session: { getActiveUser: () => ({ getEmail: () => '' }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => PROPS[k] ?? null }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: t => ({ t, setMimeType() { return this; } }) },
    HtmlService: {},
    Date, JSON, Number, String, Array, Object
};
vm.createContext(ctx);
vm.runInContext(readFileSync(CODE_GS, 'utf8'), ctx);

const requestLog = [];
http.createServer((req, res) => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
    if (req.method === 'GET' && req.url.startsWith('/dump')) {
        const out = {};
        sheets.forEach((s, name) => { out[name] = s.rows.map(r => (r || []).map(v => (v instanceof Date ? v.toISOString() : v))); });
        res.writeHead(200, cors); res.end(JSON.stringify({ sheets: out, requests: requestLog }));
        return;
    }
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
        let result;
        try {
            const parsed = JSON.parse(body || '{}');
            result = JSON.parse(ctx.doPost({ postData: { contents: body } }).t);
            requestLog.push({ fn: parsed.fn, warehouse: parsed.warehouse || 'ONT', ok: !!result.ok, conflict: !!result.conflict, unauthorized: !!result.unauthorized, error: result.error || '' });
        } catch (e) {
            result = { ok: false, error: String(e) };
        }
        res.writeHead(200, cors); res.end(JSON.stringify(result));
    });
}).listen(PORT, '127.0.0.1', () => console.log('fake apps script on', PORT));
