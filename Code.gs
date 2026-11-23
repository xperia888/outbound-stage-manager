/**
 * ONUS-ONT Outbound Pallet Staging Manager — Apps Script backend
 *
 * Serves the board (Index.html) and answers the page's cloud requests. Both links
 * reach the same sheet through api(request):
 *   - the Apps Script /exec link calls it with google.script.run.api(...)
 *   - the GitHub Pages link POSTs the same request to the /exec URL (doPost)
 * Each warehouse has its own board, Scan Log tab and access code (Script Properties):
 *   ONT   → ACCESS_CODE,       tabs "StateChunks" and "Scan Log"
 *   CHINO → ACCESS_CODE_CHINO, tabs "StateChunks CHINO" and "Scan Log CHINO"
 *   TEST  → no code, but only while Script Property TEST_MODE is "on";
 *           tabs "StateChunks TEST" and "Scan Log TEST" (for trying the app safely)
 * A request only reaches the warehouse whose code it carries.
 *
 * The board JSON is split across many cells (a single cell holds max 50,000
 * characters), so the board can grow without saves failing.
 *
 * Setup: in the Apps Script editor add an HTML file named "Index" containing
 * the page, paste this file as Code.gs, then Deploy > New deployment > Web app.
 */

/** Per-warehouse storage. ONT keeps the original tab names so existing data stays put. */
const WAREHOUSES_ = {
  ONT: { codeProperty: 'ACCESS_CODE', stateSheet: 'StateChunks', scanLogSheet: 'Scan Log', legacySheet: 'State' },
  CHINO: { codeProperty: 'ACCESS_CODE_CHINO', stateSheet: 'StateChunks CHINO', scanLogSheet: 'Scan Log CHINO', legacySheet: null },
  // Test board: no access code, open only while TEST_MODE is "on". Delete TEST_MODE to close it.
  TEST: { codeProperty: null, stateSheet: 'StateChunks TEST', scanLogSheet: 'Scan Log TEST', legacySheet: null }
};
let ACTIVE_WH_ = WAREHOUSES_.ONT; // set per request by api(); each request runs on its own
const CHUNK_SIZE = 40000;            // safely under the 50,000-char cell limit
const CHUNK_PREFIX = '~';            // keeps chunks from being read as formulas/numbers/dates
const SCAN_LOG_HEADERS = [
  'Timestamp', 'Action', 'SLP', 'Order', 'From Lane', 'To Lane', 'Stack',
  'Carrier', 'Destination', 'Dock', 'Device', 'User', 'Event ID'
];
const SCAN_LOG_MAX_BATCH = 500;

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('ONUS • Outbound Pallet Staging')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL); // allows Google Sites embed
}

/** POST endpoint used by the GitHub Pages copy of the app. */
function doPost(e) {
  let request = {};
  try {
    request = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    request = {};
  }
  return ContentService.createTextOutput(JSON.stringify(api(request)))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Single entry point for both links: { fn, args, key, warehouse }.
 * Only the functions listed here can be called, and only with that warehouse's access code.
 * Requests without a warehouse (older pages) are ONT.
 */
function api(request) {
  const req = request || {};
  const whId = String(req.warehouse || 'ONT').toUpperCase();
  if (!WAREHOUSES_[whId]) return { ok: false, error: 'Unknown warehouse: ' + whId };
  ACTIVE_WH_ = WAREHOUSES_[whId];

  if (!ACTIVE_WH_.codeProperty) {
    const testMode = String(PropertiesService.getScriptProperties().getProperty('TEST_MODE') || '').toLowerCase();
    if (testMode !== 'on') return { ok: false, error: 'Test mode is off (set Script Property TEST_MODE to "on")' };
    return runRequest_(req);
  }

  const expected = PropertiesService.getScriptProperties().getProperty(ACTIVE_WH_.codeProperty);
  if (!expected) {
    return { ok: false, error: 'Set ' + ACTIVE_WH_.codeProperty + ' in Apps Script → Project Settings → Script Properties' };
  }
  if (String(req.key || '') !== String(expected)) {
    return { ok: false, unauthorized: true, error: 'Wrong or missing access code' };
  }
  return runRequest_(req);
}

function runRequest_(req) {
  const args = Array.isArray(req.args) ? req.args : [];
  switch (req.fn) {
    case 'loadBoardState': return loadBoardState_();
    case 'saveBoardState': return saveBoardState_(args[0], args[1]);
    case 'logScanEvents': return logScanEvents_(args[0]);
    default: return { ok: false, error: 'Unknown request: ' + req.fn };
  }
}

function getStateSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(ACTIVE_WH_.stateSheet);
  if (!sheet) {
    sheet = ss.insertSheet(ACTIVE_WH_.stateSheet);
    sheet.getRange('A:A').setNumberFormat('@');
    sheet.getRange('B2').setNumberFormat('@');
    sheet.getRange('A1').setValue('updatedAt');
    sheet.getRange('B1').setValue('chunks');
  }
  return sheet;
}

/** Layout: B2 = updatedAt (ISO), C2 = chunk count, A3:A = chunks. */
/**
 * Version marker for a stored board that has no timestamp (e.g. old data in State!A1
 * with B1 empty). Without a stable marker every save looked like a conflict and
 * nothing was ever written.
 */
const UNVERSIONED_ = 'unversioned';

/** Sheets may turn an ISO timestamp into a Date; always hand back the same ISO string. */
function toIsoString_(value) {
  if (!value) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function loadBoardState_() {
  try {
    const sheet = getStateSheet_();
    const updatedAt = toIsoString_(sheet.getRange('B2').getValue());
    const count = Number(sheet.getRange('C2').getValue()) || 0;

    if (count > 0) {
      const values = sheet.getRange(3, 1, count, 1).getValues();
      const json = values.map(r => String(r[0]).replace(/^~/, '')).join('');
      return { ok: true, stateJson: json, updatedAt: updatedAt || UNVERSIONED_ };
    }

    // One-time fallback to the old single-cell layout
    const legacy = ACTIVE_WH_.legacySheet
      ? SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ACTIVE_WH_.legacySheet)
      : null;
    if (legacy) {
      const raw = legacy.getRange('A1').getValue();
      const legacyAt = legacy.getRange('B1').getValue();
      if (raw) {
        return {
          ok: true,
          stateJson: String(raw),
          updatedAt: toIsoString_(legacyAt) || UNVERSIONED_
        };
      }
    }
    return { ok: true, stateJson: null, updatedAt: null };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/**
 * Saves the board. If baseUpdatedAt is passed (the cloud version the device last saw)
 * and another device has saved since then, nothing is written: the current cloud board
 * is returned with conflict: true so the device can merge and save again.
 * An empty baseUpdatedAt means "never synced" and conflicts with any existing board.
 */
function saveBoardState_(stateJson, baseUpdatedAt) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { ok: false, error: 'Busy — try again' };
  try {
    const json = String(stateJson || '');
    JSON.parse(json); // reject anything that isn't valid JSON

    if (typeof baseUpdatedAt === 'string') {
      const current = loadBoardState_();
      if (!current.ok) return current;
      if (current.stateJson && current.updatedAt !== baseUpdatedAt) {
        return { ok: false, conflict: true, stateJson: current.stateJson, updatedAt: current.updatedAt };
      }
    }

    const chunks = [];
    for (let i = 0; i < json.length; i += CHUNK_SIZE) {
      chunks.push([CHUNK_PREFIX + json.slice(i, i + CHUNK_SIZE)]);
    }

    const sheet = getStateSheet_();
    const oldCount = Number(sheet.getRange('C2').getValue()) || 0;

    if (chunks.length > 0) {
      const range = sheet.getRange(3, 1, chunks.length, 1);
      range.setNumberFormat('@');
      range.setValues(chunks);
    }
    if (oldCount > chunks.length) {
      sheet.getRange(3 + chunks.length, 1, oldCount - chunks.length, 1).clearContent();
    }

    // Each save gets a strictly newer timestamp, so devices can always tell versions apart
    let nowMs = Date.now();
    const prevMs = Date.parse(toIsoString_(sheet.getRange('B2').getValue()));
    if (!isNaN(prevMs) && nowMs <= prevMs) nowMs = prevMs + 1;
    const now = new Date(nowMs).toISOString();
    sheet.getRange('B2').setNumberFormat('@');
    sheet.getRange('B2:C2').setValues([[now, chunks.length]]);
    SpreadsheetApp.flush();
    return { ok: true, updatedAt: now };
  } catch (err) {
    return { ok: false, error: String(err) };
  } finally {
    lock.releaseLock();
  }
}

function getScanLogSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(ACTIVE_WH_.scanLogSheet);
  if (!sheet) {
    sheet = ss.insertSheet(ACTIVE_WH_.scanLogSheet);
    sheet.getRange(1, 1, 1, SCAN_LOG_HEADERS.length).setValues([SCAN_LOG_HEADERS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    sheet.getRange('A:A').setNumberFormat('yyyy-mm-dd hh:mm:ss');
    sheet.getRange('B:M').setNumberFormat('@'); // keep SLP/order codes as text (no lost leading zeros)
  }
  return sheet;
}

/**
 * Appends one row per scan/move/ship event to the "Scan Log" tab.
 * Events already logged (same Event ID, e.g. a retry after a dropped connection)
 * are skipped. Returns the IDs the page can now forget.
 */
function logScanEvents_(events) {
  const list = Array.isArray(events) ? events.slice(0, SCAN_LOG_MAX_BATCH) : [];
  if (list.length === 0) return { ok: true, loggedIds: [] };

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { ok: false, error: 'Busy — try again' };
  try {
    const cache = CacheService.getScriptCache();
    const ids = list.map(e => String((e && e.id) || '')).filter(Boolean);
    const seen = cache.getAll(ids.map(id => 'scanlog:' + id));
    let user = '';
    try { user = Session.getActiveUser().getEmail() || ''; } catch (err) { /* not available for this deployment */ }

    const rows = [];
    const newIds = [];
    list.forEach(e => {
      const id = String((e && e.id) || '');
      if (!id || seen['scanlog:' + id] || newIds.indexOf(id) !== -1) return;
      newIds.push(id);
      rows.push([
        new Date(Number(e.time) || Date.now()),
        String(e.action || ''),
        String(e.slp || ''),
        String(e.orderNumber || ''),
        String(e.fromLane || ''),
        String(e.toLane || ''),
        e.doubleStacked ? '2x' : '1x',
        String(e.carrier || ''),
        String(e.destination || ''),
        String(e.dockNumber || ''),
        String(e.device || ''),
        String(e.user || user),
        id
      ]);
    });

    if (rows.length > 0) {
      const sheet = getScanLogSheet_();
      const start = sheet.getLastRow() + 1;
      sheet.getRange(start, 2, rows.length, SCAN_LOG_HEADERS.length - 1).setNumberFormat('@');
      sheet.getRange(start, 1, rows.length, SCAN_LOG_HEADERS.length).setValues(rows);
      const marks = {};
      newIds.forEach(id => { marks['scanlog:' + id] = '1'; });
      cache.putAll(marks, 21600); // remember for 6 hours (cache maximum)
      SpreadsheetApp.flush();
    }
    return { ok: true, loggedIds: ids };
  } catch (err) {
    return { ok: false, error: String(err) };
  } finally {
    lock.releaseLock();
  }
}
