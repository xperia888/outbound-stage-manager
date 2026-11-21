/**
 * ONUS-ONT Outbound Pallet Staging Manager — Apps Script backend
 *
 * Serves the board (Index.html) and provides the two functions the page calls
 * through google.script.run: loadBoardState() and saveBoardState(json).
 *
 * The board JSON is split across many cells (a single cell holds max 50,000
 * characters), so the board can grow without saves failing.
 *
 * Setup: in the Apps Script editor add an HTML file named "Index" containing
 * the page, paste this file as Code.gs, then Deploy > New deployment > Web app.
 */

const STATE_SHEET = 'StateChunks';   // new chunked storage
const LEGACY_SHEET = 'State';        // old single-cell storage (read once to migrate)
const CHUNK_SIZE = 40000;            // safely under the 50,000-char cell limit
const CHUNK_PREFIX = '~';            // keeps chunks from being read as formulas/numbers/dates
const SCAN_LOG_SHEET = 'Scan Log';
const SCAN_LOG_HEADERS = [
  'Timestamp', 'Action', 'SLP', 'Order', 'From Lane', 'To Lane', 'Stack',
  'Carrier', 'Destination', 'Dock', 'Device', 'User', 'Event ID'
];
const SCAN_LOG_MAX_BATCH = 500;

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('ONUS-ONT • Outbound Pallet Staging')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL); // allows Google Sites embed
}

function getStateSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(STATE_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(STATE_SHEET);
    sheet.getRange('A:A').setNumberFormat('@');
    sheet.getRange('B2').setNumberFormat('@');
    sheet.getRange('A1').setValue('updatedAt');
    sheet.getRange('B1').setValue('chunks');
  }
  return sheet;
}

/** Layout: B2 = updatedAt (ISO), C2 = chunk count, A3:A = chunks. */
/** Sheets may turn an ISO timestamp into a Date; always hand back the same ISO string. */
function toIsoString_(value) {
  if (!value) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function loadBoardState() {
  try {
    const sheet = getStateSheet_();
    const updatedAt = toIsoString_(sheet.getRange('B2').getValue());
    const count = Number(sheet.getRange('C2').getValue()) || 0;

    if (count > 0) {
      const values = sheet.getRange(3, 1, count, 1).getValues();
      const json = values.map(r => String(r[0]).replace(/^~/, '')).join('');
      return { ok: true, stateJson: json, updatedAt: updatedAt || null };
    }

    // One-time fallback to the old single-cell layout
    const legacy = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LEGACY_SHEET);
    if (legacy) {
      const raw = legacy.getRange('A1').getValue();
      const legacyAt = legacy.getRange('B1').getValue();
      if (raw) {
        return {
          ok: true,
          stateJson: String(raw),
          updatedAt: toIsoString_(legacyAt) || null
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
function saveBoardState(stateJson, baseUpdatedAt) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { ok: false, error: 'Busy — try again' };
  try {
    const json = String(stateJson || '');
    JSON.parse(json); // reject anything that isn't valid JSON

    if (typeof baseUpdatedAt === 'string') {
      const current = loadBoardState();
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

    const now = new Date().toISOString();
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
  let sheet = ss.getSheetByName(SCAN_LOG_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(SCAN_LOG_SHEET);
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
function logScanEvents(events) {
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
