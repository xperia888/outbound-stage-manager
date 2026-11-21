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
    sheet.getRange('A1').setValue('updatedAt');
    sheet.getRange('B1').setValue('chunks');
  }
  return sheet;
}

/** Layout: B2 = updatedAt (ISO), C2 = chunk count, A3:A = chunks. */
function loadBoardState() {
  try {
    const sheet = getStateSheet_();
    const updatedAt = String(sheet.getRange('B2').getValue() || '');
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
          updatedAt: legacyAt ? new Date(legacyAt).toISOString() : null
        };
      }
    }
    return { ok: true, stateJson: null, updatedAt: null };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

function saveBoardState(stateJson) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { ok: false, error: 'Busy — try again' };
  try {
    const json = String(stateJson || '');
    JSON.parse(json); // reject anything that isn't valid JSON

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
    sheet.getRange('B2:C2').setValues([[now, chunks.length]]);
    SpreadsheetApp.flush();
    return { ok: true, updatedAt: now };
  } catch (err) {
    return { ok: false, error: String(err) };
  } finally {
    lock.releaseLock();
  }
}
