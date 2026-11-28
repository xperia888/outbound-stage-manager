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
 * api({ fn: 'resolveWarehouse', key }) tells the page which warehouse a code opens.
 *
 * Order intake (intake.html) keeps one row per order in an "Orders" tab per warehouse
 * ("Orders", "Orders CHINO", "Orders TEST"). Who can reach it:
 *   - the floor access code (everything),
 *   - a customer-service code, CS_CODE / CS_CODE_CHINO (orders only, no board changes),
 *   - a WMS key, WMS_API_KEY / WMS_API_KEY_CHINO, for a WMS or middleware pushing orders
 *     (upsertOrders and listOrders only). See the README for the request format.
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
WAREHOUSES_.ONT.ordersSheet = 'Orders';
WAREHOUSES_.ONT.csCodeProperty = 'CS_CODE';
WAREHOUSES_.ONT.apiKeyProperty = 'WMS_API_KEY';
WAREHOUSES_.CHINO.ordersSheet = 'Orders CHINO';
WAREHOUSES_.CHINO.csCodeProperty = 'CS_CODE_CHINO';
WAREHOUSES_.CHINO.apiKeyProperty = 'WMS_API_KEY_CHINO';
WAREHOUSES_.TEST.ordersSheet = 'Orders TEST';
WAREHOUSES_.ONT.templatesSheet = 'Import Templates';
WAREHOUSES_.CHINO.templatesSheet = 'Import Templates CHINO';
WAREHOUSES_.TEST.templatesSheet = 'Import Templates TEST';
// WMS pull connector settings (Script Properties): <prefix>_CONFIG (JSON), <prefix>_SECRET (key / password), <prefix>_LAST
WAREHOUSES_.ONT.wmsPullPrefix = 'WMS_PULL';
WAREHOUSES_.CHINO.wmsPullPrefix = 'WMS_PULL_CHINO';
WAREHOUSES_.TEST.wmsPullPrefix = 'WMS_PULL_TEST';

/** What each kind of key may call. */
const ROLE_FUNCTIONS_ = {
  floor: ['loadBoardState', 'saveBoardState', 'logScanEvents', 'listOrders', 'upsertOrders', 'setOrderStatus', 'orderProgress', 'intakeStatus',
    'listImportTemplates', 'saveImportTemplate', 'deleteImportTemplate', 'reportData',
    'wmsPullGetConfig', 'wmsPullSaveConfig', 'wmsPullFetch', 'wmsFillPickers', 'wmsLogin', 'wmsSignOut'],
  cs: ['listOrders', 'upsertOrders', 'setOrderStatus', 'orderProgress', 'intakeStatus',
    'listImportTemplates', 'saveImportTemplate', 'deleteImportTemplate', 'reportData',
    'wmsPullGetConfig', 'wmsPullSaveConfig', 'wmsPullFetch', 'wmsFillPickers', 'wmsLogin', 'wmsSignOut'],
  api: ['listOrders', 'upsertOrders']
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

  // Which warehouse does this access code open? Lets the page pick the warehouse from the code.
  if (req.fn === 'resolveWarehouse') return resolveWarehouse_(req.key);

  const whId = String(req.warehouse || 'ONT').toUpperCase();
  if (!WAREHOUSES_[whId]) return { ok: false, error: 'Unknown warehouse: ' + whId };
  ACTIVE_WH_ = WAREHOUSES_[whId];

  if (!ACTIVE_WH_.codeProperty) {
    const testMode = String(PropertiesService.getScriptProperties().getProperty('TEST_MODE') || '').toLowerCase();
    if (testMode !== 'on') return { ok: false, error: 'Test mode is off (set Script Property TEST_MODE to "on")' };
    return runRequest_(req, 'floor');
  }

  const props = PropertiesService.getScriptProperties();
  const expected = props.getProperty(ACTIVE_WH_.codeProperty);
  if (!expected) {
    return { ok: false, error: 'Set ' + ACTIVE_WH_.codeProperty + ' in Apps Script → Project Settings → Script Properties' };
  }
  const role = roleForKey_(props, ACTIVE_WH_, req.key);
  if (!role) return { ok: false, unauthorized: true, error: 'Wrong or missing access code' };
  if (ROLE_FUNCTIONS_[role].indexOf(req.fn) === -1) {
    return { ok: false, unauthorized: true, forbidden: true, error: 'This code cannot do ' + req.fn };
  }
  return runRequest_(req, role);
}

/** floor / cs / api for a warehouse's floor code, CS code or WMS key; null if none match. */
function roleForKey_(props, wh, key) {
  const k = String(key || '');
  if (!k) return null;
  const match = prop => {
    if (!prop) return false;
    const v = props.getProperty(prop);
    return Boolean(v) && String(v) === k;
  };
  if (match(wh.codeProperty)) return 'floor';
  if (match(wh.csCodeProperty)) return 'cs';
  if (match(wh.apiKeyProperty)) return 'api';
  return null;
}

/** Returns the warehouse whose access code matches, or unauthorized. TEST is never matched by a code. */
function resolveWarehouse_(key) {
  const code = String(key || '');
  if (!code) return { ok: false, unauthorized: true, error: 'Missing access code' };
  const props = PropertiesService.getScriptProperties();
  const ids = Object.keys(WAREHOUSES_);
  for (let i = 0; i < ids.length; i++) {
    const wh = WAREHOUSES_[ids[i]];
    if (!wh.codeProperty) continue;
    const role = roleForKey_(props, wh, code);
    // The WMS key is for machines only and is never accepted as a sign-in code
    if (role === 'floor' || role === 'cs') return { ok: true, warehouse: ids[i], role: role };
  }
  return { ok: false, unauthorized: true, error: 'Access code not recognized' };
}

function runRequest_(req, role) {
  const args = Array.isArray(req.args) ? req.args : [];
  switch (req.fn) {
    case 'loadBoardState': return loadBoardState_();
    case 'saveBoardState': return saveBoardState_(args[0], args[1]);
    case 'logScanEvents': return logScanEvents_(args[0]);
    case 'listOrders': return listOrders_(args[0]);
    case 'upsertOrders': return upsertOrders_(args[0], args[1], role);
    case 'wmsPullGetConfig': return wmsPullGetConfig_();
    case 'wmsPullSaveConfig': return wmsPullSaveConfig_(args[0], args[1], args[2]);
    case 'wmsPullFetch': return wmsPullFetch_(args[0]);
    case 'wmsFillPickers': return wmsFillPickers_(args[0]);
    case 'wmsLogin': return wmsLogin_(args[0], args[1]);
    case 'wmsSignOut': return wmsSignOut_();
    case 'setOrderStatus': return setOrderStatus_(args[0], args[1], args[2]);
    case 'orderProgress': return orderProgress_();
    case 'intakeStatus': return intakeStatus_(role);
    case 'listImportTemplates': return listImportTemplates_();
    case 'saveImportTemplate': return saveImportTemplate_(args[0], args[1], args[2]);
    case 'deleteImportTemplate': return deleteImportTemplate_(args[0]);
    case 'reportData': return reportData_(args[0]);
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
    try { syncFloorToOrders_(boardProgress_(JSON.parse(json))); } catch (err) { /* the board save itself succeeded */ }
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


// =====================================================================================
// Order intake: one row per order in the warehouse's "Orders" tab
// =====================================================================================

/** Sheet columns, in order. `key` is the field name used by the page and the API. */
const ORDER_FIELDS_ = [
  { key: 'orderNumber', header: 'Order #', type: 'text' },
  { key: 'customer', header: 'Customer', type: 'text' },
  { key: 'releasedAt', header: 'Released to Warehouse', type: 'datetime' },
  { key: 'cartons', header: 'Cartons', type: 'int' },
  { key: 'pallets', header: 'Pallets', type: 'int' },
  { key: 'refType', header: 'Reference Type', type: 'text' },
  { key: 'reference', header: 'Reference', type: 'text' },
  { key: 'orderType', header: 'Order Type', type: 'text' },
  { key: 'carrier', header: 'Carrier', type: 'text' },
  { key: 'scac', header: 'SCAC', type: 'text' },
  { key: 'proBol', header: 'PRO / BOL', type: 'text' },
  { key: 'shipDate', header: 'Ship / Appt Date', type: 'text' },
  { key: 'destination', header: 'Destination', type: 'text' },
  { key: 'notes', header: 'Notes', type: 'text' },
  { key: 'status', header: 'Status', type: 'text' },
  { key: 'source', header: 'Source', type: 'text' },
  { key: 'enteredBy', header: 'Entered By', type: 'text' },
  { key: 'createdAt', header: 'Created', type: 'datetime' },
  { key: 'updatedAt', header: 'Updated', type: 'datetime' },
  // Added later: kept at the end so rows already in the sheet stay lined up
  { key: 'picker', header: 'Picker', type: 'text' },
  { key: 'vrid', header: 'VRID', type: 'text' },
  // Written by the server from the staging board (matched by Order #); not set by people or the WMS
  { key: 'stageLanes', header: 'Stage Lanes', type: 'text' },
  { key: 'dock', header: 'Dock', type: 'text' },
  { key: 'palletsOnFloor', header: 'Pallets On Floor', type: 'int' },
  { key: 'palletsShipped', header: 'Pallets Shipped', type: 'int' },
  { key: 'floorUpdatedAt', header: 'Floor Updated', type: 'datetime' },
  // Who first entered the order (set once, on create; "Entered By" is whoever saved it last)
  { key: 'createdBy', header: 'Created By', type: 'text' },
  // When the order is picked and ready to stage / ship (YYYY-MM-DD)
  { key: 'readyDate', header: 'Order Ready Date', type: 'text' },
  // CS hand-out window, e.g. "8:30am-10:00am" (Released to Warehouse holds the date + window start)
  { key: 'releaseWindow', header: 'Release Window', type: 'text' }
];
/** Fields a person or the WMS may set (the rest are kept by the server). */
const ORDER_INPUT_KEYS_ = ['customer', 'releasedAt', 'cartons', 'pallets', 'refType', 'reference', 'orderType',
  'carrier', 'scac', 'proBol', 'shipDate', 'destination', 'notes', 'enteredBy', 'picker', 'vrid', 'readyDate', 'releaseWindow'];
const ORDER_STATUSES_ = ['Released', 'Cancelled'];
const ORDERS_MAX_BATCH_ = 2000;

/** Same rule as the staging app: trimmed, upper case. */
function normalizeOrderNumber_(raw) {
  return String(raw == null ? '' : raw).trim().toUpperCase();
}

function getOrdersSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(ACTIVE_WH_.ordersSheet);
  if (!sheet) {
    sheet = ss.insertSheet(ACTIVE_WH_.ordersSheet);
    sheet.getRange(1, 1, 1, ORDER_FIELDS_.length).setValues([ORDER_FIELDS_.map(f => f.header)]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  } else {
    // A tab made before new columns were added: add the missing headers at the end
    const head = sheet.getRange(1, 1, 1, ORDER_FIELDS_.length).getValues()[0];
    const missing = ORDER_FIELDS_.some((f, i) => String(head[i] || '') !== f.header);
    if (missing) {
      sheet.getRange(1, 1, 1, ORDER_FIELDS_.length).setValues([ORDER_FIELDS_.map(f => f.header)]).setFontWeight('bold');
    }
  }
  return sheet;
}

function formatOrderColumns_(sheet, startRow, count) {
  if (count <= 0) return;
  ORDER_FIELDS_.forEach((f, i) => {
    const fmt = f.type === 'datetime' ? 'yyyy-mm-dd hh:mm' : f.type === 'int' ? '0' : '@';
    sheet.getRange(startRow, i + 1, count, 1).setNumberFormat(fmt);
  });
}

function readOrderRows_(sheet) {
  const last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet.getRange(2, 1, last - 1, ORDER_FIELDS_.length).getValues();
}

function rowToOrder_(row) {
  const o = {};
  ORDER_FIELDS_.forEach((f, i) => {
    const v = row[i];
    if (f.type === 'datetime') o[f.key] = v instanceof Date ? v.toISOString() : (v ? String(v) : '');
    else if (f.type === 'int') o[f.key] = v === '' || v == null ? null : Number(v);
    else o[f.key] = v == null ? '' : String(v);
  });
  return o;
}

/** Turns one incoming value into what is stored, or throws a readable message. */
function cleanOrderValue_(field, value) {
  if (value == null) return '';
  if (field.type === 'int') {
    if (String(value).trim() === '') return '';
    const n = Number(String(value).replace(/,/g, '').trim());
    if (!isFinite(n) || n < 0 || Math.floor(n) !== n) throw new Error(field.header + ' must be a whole number');
    if (n > 100000) throw new Error(field.header + ' looks too large');
    return n;
  }
  if (field.type === 'datetime') {
    if (String(value).trim() === '') return '';
    const d = value instanceof Date ? value : new Date(String(value));
    if (isNaN(d.getTime())) throw new Error(field.header + ' is not a date/time');
    return d;
  }
  return String(value).trim().slice(0, 500);
}

/**
 * Adds or updates orders by Order #.
 * orders: [{ orderNumber, customer, releasedAt, cartons, pallets, refType, reference, orderType,
 *            carrier, scac, proBol, shipDate, readyDate, destination, notes, enteredBy }]
 * options.mode: 'upsert' (default) adds new orders and updates existing ones;
 *               'insertOnly' skips orders that already exist.
 * Only the fields present on an order are changed, so an import that has no Carrier
 * column leaves carriers already entered alone. New orders default to Released, now.
 */
function upsertOrders_(orders, options, role) {
  const list = Array.isArray(orders) ? orders : [];
  if (list.length === 0) return { ok: true, inserted: 0, updated: 0, skipped: 0, errors: [] };
  if (list.length > ORDERS_MAX_BATCH_) return { ok: false, error: 'Send at most ' + ORDERS_MAX_BATCH_ + ' orders per request' };
  const opts = options || {};
  // Orders pulled from the WMS only ever ADD new orders: existing orders are never changed
  const fromWmsPull = Boolean(opts.wmsPull);
  const mode = fromWmsPull || opts.mode === 'insertOnly' ? 'insertOnly' : 'upsert';
  const source = String(fromWmsPull ? 'WMS pull' : (opts.source || (role === 'api' ? 'WMS API' : 'Manual'))).slice(0, 40);
  // People must say who they are (for the reports); the WMS connection may leave it blank
  const batchUser = String(opts.enteredBy == null ? '' : opts.enteredBy).trim().slice(0, 80);
  if (role !== 'api' && !batchUser && list.some(o => !String((o && o.enteredBy) || '').trim())) {
    return { ok: false, needName: true, error: 'Name is required' };
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, error: 'Busy — try again' };
  try {
    const sheet = getOrdersSheet_();
    if (fromWmsPull) backupOrdersSheet_(sheet);
    const rows = readOrderRows_(sheet);
    const index = {};
    rows.forEach((r, i) => { const k = normalizeOrderNumber_(r[0]); if (k) index[k] = i; });
    const col = {};
    ORDER_FIELDS_.forEach((f, i) => { col[f.key] = i; });

    const now = new Date();
    const added = [];
    const changedRows = {};
    const errors = [];
    let updated = 0, skipped = 0;
    const seenInBatch = {};

    list.forEach((input, n) => {
      const o = input || {};
      const orderNumber = normalizeOrderNumber_(o.orderNumber);
      try {
        if (!orderNumber) throw new Error('Order # is missing');
        if (seenInBatch[orderNumber] != null) throw new Error('Order # appears twice in this batch (first at #' + (seenInBatch[orderNumber] + 1) + ')');
        seenInBatch[orderNumber] = n;

        const values = {};
        ORDER_INPUT_KEYS_.forEach(key => {
          if (!Object.prototype.hasOwnProperty.call(o, key) || o[key] === undefined) return;
          values[key] = cleanOrderValue_(ORDER_FIELDS_[col[key]], o[key]);
        });
        if (!values.enteredBy && batchUser) values.enteredBy = batchUser;
        if (o.status !== undefined && o.status !== '') {
          const st = ORDER_STATUSES_.find(x => x.toLowerCase() === String(o.status).trim().toLowerCase());
          if (!st) throw new Error('Status must be Released or Cancelled');
          values.status = st;
        }

        const existing = index[orderNumber];
        if (existing != null) {
          if (mode === 'insertOnly') { skipped++; return; }
          const row = rows[existing];
          Object.keys(values).forEach(key => { row[col[key]] = values[key]; });
          row[col.updatedAt] = now;
          if (!row[col.source]) row[col.source] = source;
          changedRows[existing] = true;
          updated++;
        } else {
          if (!values.customer) throw new Error('Customer is missing');
          const row = ORDER_FIELDS_.map(() => '');
          Object.keys(values).forEach(key => { row[col[key]] = values[key]; });
          row[col.orderNumber] = orderNumber;
          if (!row[col.releasedAt]) row[col.releasedAt] = now;
          if (!row[col.status]) row[col.status] = 'Released';
          row[col.source] = source;
          row[col.createdAt] = now;
          row[col.updatedAt] = now;
          row[col.createdBy] = values.enteredBy || '';
          index[orderNumber] = rows.length + added.length;
          added.push(row);
        }
      } catch (err) {
        errors.push({ index: n, orderNumber: orderNumber, error: String(err && err.message || err) });
      }
    });

    // Rewrite changed rows (one write per row) and append new ones in a single write
    Object.keys(changedRows).forEach(i => {
      const r = Number(i);
      sheet.getRange(r + 2, 1, 1, ORDER_FIELDS_.length).setValues([rows[r]]);
    });
    if (added.length) {
      const start = Math.max(sheet.getLastRow(), 1) + 1;
      formatOrderColumns_(sheet, start, added.length);
      sheet.getRange(start, 1, added.length, ORDER_FIELDS_.length).setValues(added);
    }
    SpreadsheetApp.flush();
    if (added.length) {
      // Orders entered after the floor already staged them get their lanes right away
      try {
        const board = loadBoardState_();
        if (board.ok && board.stateJson) syncFloorToOrders_(boardProgress_(JSON.parse(board.stateJson)));
      } catch (err) { /* the orders are saved either way */ }
    }
    return { ok: true, inserted: added.length, updated: updated, skipped: skipped, errors: errors };
  } catch (err) {
    return { ok: false, error: String(err) };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Orders, newest release first. options.days: only orders released in the last N days
 * (default 30, 0 = all). options.since: ISO time, only orders updated after it (for the WMS).
 */
function listOrders_(options) {
  try {
    const opts = options || {};
    const days = opts.days == null ? 30 : Number(opts.days) || 0;
    const fromMs = days > 0 ? Date.now() - days * 86400000 : 0;
    const sinceMs = opts.since ? Date.parse(String(opts.since)) : NaN;
    const orders = readOrderRows_(getOrdersSheet_())
      .filter(r => normalizeOrderNumber_(r[0]))
      .map(rowToOrder_)
      .filter(o => {
        // Released, or changed, within the window
        if (fromMs && !(Date.parse(o.releasedAt) >= fromMs) && !(Date.parse(o.updatedAt) >= fromMs)) return false;
        if (!isNaN(sinceMs) && !(Date.parse(o.updatedAt) > sinceMs)) return false;
        return true;
      })
      .sort((a, b) => (Date.parse(b.releasedAt) || 0) - (Date.parse(a.releasedAt) || 0));
    return { ok: true, orders: orders.slice(0, 5000), total: orders.length };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/** Cancel or re-release an order. Rows are never deleted, so the history stays. */
function setOrderStatus_(orderNumber, status, enteredBy) {
  const ord = normalizeOrderNumber_(orderNumber);
  const st = ORDER_STATUSES_.find(x => x.toLowerCase() === String(status || '').toLowerCase());
  if (!ord) return { ok: false, error: 'Order # is missing' };
  if (!st) return { ok: false, error: 'Status must be Released or Cancelled' };
  if (!String(enteredBy || '').trim()) return { ok: false, needName: true, error: 'Name is required' };
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { ok: false, error: 'Busy — try again' };
  try {
    const sheet = getOrdersSheet_();
    const rows = readOrderRows_(sheet);
    const i = rows.findIndex(r => normalizeOrderNumber_(r[0]) === ord);
    if (i === -1) return { ok: false, error: 'Order ' + ord + ' not found' };
    const statusCol = ORDER_FIELDS_.findIndex(f => f.key === 'status');
    const updatedCol = ORDER_FIELDS_.findIndex(f => f.key === 'updatedAt');
    const byCol = ORDER_FIELDS_.findIndex(f => f.key === 'enteredBy');
    rows[i][statusCol] = st;
    rows[i][updatedCol] = new Date();
    if (enteredBy) rows[i][byCol] = String(enteredBy).slice(0, 80);
    sheet.getRange(i + 2, 1, 1, ORDER_FIELDS_.length).setValues([rows[i]]);
    SpreadsheetApp.flush();
    return { ok: true, order: rowToOrder_(rows[i]) };
  } catch (err) {
    return { ok: false, error: String(err) };
  } finally {
    lock.releaseLock();
  }
}

/**
 * What the floor has done with each order, read from the staging board (read only):
 * { ORDER: { staged, atDock, docks, lanes, shipped, firstStagedAt, lastShippedAt } }
 */
function orderProgress_() {
  try {
    const board = loadBoardState_();
    if (!board.ok) return board;
    let state = {};
    try { state = board.stateJson ? JSON.parse(board.stateJson) : {}; } catch (e) { state = {}; }
    const out = boardProgress_(state);
    // Keep the Orders tab's floor columns current too (skipped if another request is busy)
    const lock = LockService.getScriptLock();
    if (lock.tryLock(3000)) {
      try { syncFloorToOrders_(out); } catch (err) { /* reading progress still works */ } finally { lock.releaseLock(); }
    }
    return { ok: true, progress: out, boardUpdatedAt: board.updatedAt || null };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/** Per order on a board: { ORDER: { staged, atDock, docks, lanes, shipped, firstStagedAt, lastShippedAt } } */
function boardProgress_(state) {
  const st = state || {};
  const lanes = {};
  (Array.isArray(st.columns) ? st.columns : []).forEach(c => { if (c && c.id) lanes[c.id] = c.name; });
  const out = {};
  const get = ord => (out[ord] = out[ord] || { staged: 0, atDock: 0, docks: [], lanes: [], shipped: 0, firstStagedAt: null, lastShippedAt: null });
  (Array.isArray(st.pallets) ? st.pallets : []).forEach(p => {
    const ord = normalizeOrderNumber_(p && p.orderNumber);
    if (!ord) return;
    const e = get(ord);
    e.staged++;
    if (p.dockNumber) { e.atDock++; if (e.docks.indexOf(p.dockNumber) === -1) e.docks.push(p.dockNumber); }
    const lane = lanes[p.columnId];
    if (lane && e.lanes.indexOf(lane) === -1) e.lanes.push(lane);
    const t = Number(p.createdAt) || 0;
    if (t && (!e.firstStagedAt || t < e.firstStagedAt)) e.firstStagedAt = t;
  });
  (Array.isArray(st.shippedPallets) ? st.shippedPallets : []).forEach(s => {
    const ord = normalizeOrderNumber_(s && s.orderNumber);
    if (!ord) return;
    const e = get(ord);
    e.shipped++;
    const t = Number(s.shippedAt) || 0;
    if (t && (!e.lastShippedAt || t > e.lastShippedAt)) e.lastShippedAt = t;
  });
  Object.keys(out).forEach(k => {
    out[k].lanes.sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
    out[k].docks.sort();
  });
  return out;
}

/**
 * Writes where each order is on the floor into the Orders tab (Stage Lanes, Dock, Pallets On Floor,
 * Pallets Shipped, Floor Updated), matching by Order #. Only runs if the warehouse has an Orders tab,
 * and only writes when something changed. Once an order has fully shipped its last lanes are kept.
 */
function syncFloorToOrders_(progress) {
  if (!ACTIVE_WH_.ordersSheet) return 0;
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ACTIVE_WH_.ordersSheet);
  if (!sheet || sheet.getLastRow() < 2) return 0;
  getOrdersSheet_(); // adds the floor headers to an older tab
  const rows = readOrderRows_(sheet);
  const col = {};
  ORDER_FIELDS_.forEach((f, i) => { col[f.key] = i; });
  const first = col.stageLanes, width = col.floorUpdatedAt - col.stageLanes + 1;
  const now = new Date();
  let changed = 0;
  const block = rows.map(r => {
    const cur = r.slice(first, first + width);
    const ord = normalizeOrderNumber_(r[0]);
    const p = ord ? progress[ord] : null;
    if (!p) {
      // Not on the board (any more): clear live counts, keep the last lanes for history
      const next = [cur[0], '', cur[2] === '' ? '' : 0, cur[3], cur[4]];
      if (String(cur[1]) !== '' || (cur[2] !== '' && Number(cur[2]) !== 0)) { next[4] = now; changed++; return next; }
      return cur;
    }
    const lanes = p.lanes.length ? p.lanes.join(', ') : String(cur[0] || '');
    const dock = p.docks.map(d => String(d).replace(/^DOCK-?0*(?=\d)/i, 'D')).join(', ');
    const next = [lanes, dock, p.staged, p.shipped, cur[4]];
    const same = String(cur[0]) === lanes && String(cur[1]) === dock && Number(cur[2]) === p.staged && cur[2] !== ''
      && Number(cur[3]) === p.shipped && cur[3] !== '';
    if (same) return cur;
    next[4] = now;
    changed++;
    return next;
  });
  if (changed) {
    sheet.getRange(2, first + 1, block.length, width).setValues(block);
    SpreadsheetApp.flush();
  }
  return changed;
}

/** For the portal's API page: is a WMS key / CS code set? (Never returns the values.) */
function intakeStatus_(role) {
  const props = PropertiesService.getScriptProperties();
  const has = p => Boolean(p && props.getProperty(p));
  return {
    ok: true,
    role: role,
    csCodeProperty: ACTIVE_WH_.csCodeProperty || null,
    csCodeSet: has(ACTIVE_WH_.csCodeProperty),
    apiKeyProperty: ACTIVE_WH_.apiKeyProperty || null,
    apiKeySet: has(ACTIVE_WH_.apiKeyProperty)
  };
}


// =====================================================================================
// Import templates: saved column matchings for the portal's import, shared by everyone
// Tab "Import Templates": Name | Template (JSON) | Updated | Updated By
// =====================================================================================
const TEMPLATE_HEADERS_ = ['Name', 'Template', 'Updated', 'Updated By'];
const TEMPLATE_MAX_CHARS_ = 30000;

function getTemplatesSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(ACTIVE_WH_.templatesSheet);
  if (!sheet) {
    sheet = ss.insertSheet(ACTIVE_WH_.templatesSheet);
    sheet.getRange(1, 1, 1, TEMPLATE_HEADERS_.length).setValues([TEMPLATE_HEADERS_]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function readTemplateRows_(sheet) {
  const last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet.getRange(2, 1, last - 1, TEMPLATE_HEADERS_.length).getValues();
}

function cleanTemplateName_(name) {
  return String(name == null ? '' : name).replace(/\s+/g, ' ').trim().slice(0, 60);
}

function listImportTemplates_() {
  try {
    const templates = [];
    readTemplateRows_(getTemplatesSheet_()).forEach(r => {
      const name = cleanTemplateName_(r[0]);
      if (!name) return;
      let template = null;
      try { template = JSON.parse(String(r[1] || '{}')); } catch (e) { template = null; }
      if (!template) return;
      templates.push({
        name: name,
        template: template,
        updatedAt: r[2] instanceof Date ? r[2].toISOString() : String(r[2] || ''),
        updatedBy: String(r[3] || '')
      });
    });
    templates.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    return { ok: true, templates: templates };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/** Adds a template, or replaces the one with the same name (case-insensitive). */
function saveImportTemplate_(name, template, updatedBy) {
  const clean = cleanTemplateName_(name);
  if (!clean) return { ok: false, error: 'Give the template a name' };
  let json = '';
  try { json = JSON.stringify(template || {}); } catch (e) { return { ok: false, error: 'Template is not valid' }; }
  if (json.length > TEMPLATE_MAX_CHARS_) return { ok: false, error: 'Template is too large' };
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { ok: false, error: 'Busy — try again' };
  try {
    const sheet = getTemplatesSheet_();
    const rows = readTemplateRows_(sheet);
    const i = rows.findIndex(r => cleanTemplateName_(r[0]).toLowerCase() === clean.toLowerCase());
    const row = [clean, json, new Date(), String(updatedBy || '').slice(0, 80)];
    if (i === -1) {
      const start = Math.max(sheet.getLastRow(), 1) + 1;
      sheet.getRange(start, 1, 1, 2).setNumberFormat('@');
      sheet.getRange(start, 1, 1, TEMPLATE_HEADERS_.length).setValues([row]);
    } else {
      sheet.getRange(i + 2, 1, 1, TEMPLATE_HEADERS_.length).setValues([row]);
    }
    SpreadsheetApp.flush();
    return { ok: true, name: clean, replaced: i !== -1 };
  } catch (err) {
    return { ok: false, error: String(err) };
  } finally {
    lock.releaseLock();
  }
}

/** Removes a template (the row is cleared and the rows below move up). */
function deleteImportTemplate_(name) {
  const clean = cleanTemplateName_(name);
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { ok: false, error: 'Busy — try again' };
  try {
    const sheet = getTemplatesSheet_();
    const rows = readTemplateRows_(sheet);
    const keep = rows.filter(r => cleanTemplateName_(r[0]).toLowerCase() !== clean.toLowerCase() && cleanTemplateName_(r[0]));
    if (keep.length === rows.filter(r => cleanTemplateName_(r[0])).length) return { ok: false, error: 'Template "' + clean + '" not found' };
    if (rows.length) sheet.getRange(2, 1, rows.length, TEMPLATE_HEADERS_.length).clearContent();
    if (keep.length) sheet.getRange(2, 1, keep.length, TEMPLATE_HEADERS_.length).setValues(keep);
    SpreadsheetApp.flush();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  } finally {
    lock.releaseLock();
  }
}


// =====================================================================================
// Reports: intake orders + the Scan Log (every scan / move / dock / ship) + the live board
// =====================================================================================
const REPORT_MAX_LOG_ROWS_ = 60000;

/**
 * options: { from, to } ISO times (the page sends its own local day boundaries).
 * Returns per-order floor history from the Scan Log, activity counts inside the range,
 * the intake orders that matter for the range, and floor orders that are not in intake.
 */
function reportData_(options) {
  try {
    const opts = options || {};
    const fromMs = Date.parse(String(opts.from || '')) || 0;
    const toMs = Date.parse(String(opts.to || '')) || Date.now();
    if (toMs <= fromMs) return { ok: false, error: 'The end of the range must be after the start' };

    // --- Scan Log → per order
    const floor = {};
    const activity = { SCAN: 0, MOVE: 0, CONSOLIDATE: 0, DOCK: 0, SHIP: 0, REMOVE: 0 };
    const hourly = {};
    const get = ord => (floor[ord] = floor[ord] || {
      firstScanAt: null, lastScanAt: null, firstDockAt: null, firstShipAt: null, lastShipAt: null,
      scanned: {}, shipped: {}, removed: {}, lanes: {}, docks: {},
      scannedInRange: 0, shippedInRange: 0, carrier: ''
    });
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const logSheet = ss.getSheetByName(ACTIVE_WH_.scanLogSheet);
    if (logSheet && logSheet.getLastRow() > 1) {
      const last = logSheet.getLastRow();
      const start = Math.max(2, last - REPORT_MAX_LOG_ROWS_ + 1);
      const rows = logSheet.getRange(start, 1, last - start + 1, SCAN_LOG_HEADERS.length).getValues();
      rows.forEach(r => {
        const t = r[0] instanceof Date ? r[0].getTime() : Date.parse(String(r[0] || ''));
        const action = String(r[1] || '').toUpperCase();
        const slp = String(r[2] || '');
        const ord = normalizeOrderNumber_(r[3]);
        if (!t || !ord) return;
        const e = get(ord);
        const inRange = t >= fromMs && t < toMs;
        if (inRange && activity[action] != null) {
          activity[action]++;
          const h = new Date(t).getHours();
          hourly[h] = hourly[h] || { SCAN: 0, SHIP: 0 };
          if (action === 'SCAN' || action === 'SHIP') hourly[h][action]++;
        }
        if (r[7] && !e.carrier) e.carrier = String(r[7]);
        if (action === 'SCAN') {
          e.scanned[slp] = true;
          if (!e.firstScanAt || t < e.firstScanAt) e.firstScanAt = t;
          if (!e.lastScanAt || t > e.lastScanAt) e.lastScanAt = t;
          if (r[5]) e.lanes[String(r[5])] = true;
          if (inRange) e.scannedInRange++;
        } else if (action === 'MOVE' || action === 'CONSOLIDATE') {
          if (r[5]) e.lanes[String(r[5])] = true;
        } else if (action === 'DOCK') {
          if (!e.firstDockAt || t < e.firstDockAt) e.firstDockAt = t;
          if (r[5]) e.docks[String(r[5])] = true;
        } else if (action === 'SHIP') {
          e.shipped[slp] = true;
          if (!e.firstShipAt || t < e.firstShipAt) e.firstShipAt = t;
          if (!e.lastShipAt || t > e.lastShipAt) e.lastShipAt = t;
          if (r[9]) e.docks[String(r[9])] = true;
          if (inRange) e.shippedInRange++;
        } else if (action === 'REMOVE') {
          e.removed[slp] = true;
        }
      });
    }
    const floorOut = {};
    Object.keys(floor).forEach(ord => {
      const e = floor[ord];
      floorOut[ord] = {
        firstScanAt: e.firstScanAt, lastScanAt: e.lastScanAt, firstDockAt: e.firstDockAt,
        firstShipAt: e.firstShipAt, lastShipAt: e.lastShipAt,
        scanned: Object.keys(e.scanned).length, shipped: Object.keys(e.shipped).length, removed: Object.keys(e.removed).length,
        lanes: Object.keys(e.lanes).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
        docks: Object.keys(e.docks).sort(),
        scannedInRange: e.scannedInRange, shippedInRange: e.shippedInRange, carrier: e.carrier
      };
    });

    // --- Live board
    let progress = {};
    const board = loadBoardState_();
    if (board.ok && board.stateJson) {
      try { progress = boardProgress_(JSON.parse(board.stateJson)); } catch (e) { progress = {}; }
    }

    // --- Intake orders that matter: released before the range ends, and either released in the range,
    //     active in the range, or still open at its end
    const orders = [];
    const known = {};
    const ordersSheet = ss.getSheetByName(ACTIVE_WH_.ordersSheet);
    if (ordersSheet) {
      readOrderRows_(ordersSheet).filter(r => normalizeOrderNumber_(r[0])).map(rowToOrder_).forEach(o => {
        const ord = normalizeOrderNumber_(o.orderNumber);
        known[ord] = true;
        const rel = Date.parse(o.releasedAt) || 0;
        const f = floorOut[ord];
        const p = progress[ord];
        const activeInRange = f && (f.scannedInRange || f.shippedInRange);
        const open = o.status !== 'Cancelled' && (!f || !f.lastShipAt || (p && p.staged > 0)) && rel < toMs;
        if ((rel >= fromMs && rel < toMs) || activeInRange || open) orders.push(o);
      });
    }
    const floorOnly = Object.keys(Object.assign({}, floorOut, progress)).filter(ord => !known[ord]).map(ord => {
      const f = floorOut[ord] || {};
      const p = progress[ord] || {};
      return {
        orderNumber: ord, onFloor: p.staged || 0, lanes: (p.lanes && p.lanes.length ? p.lanes : f.lanes) || [],
        scannedInRange: f.scannedInRange || 0, shippedInRange: f.shippedInRange || 0, lastActivityAt: f.lastShipAt || f.lastScanAt || p.firstStagedAt || null
      };
    }).filter(x => x.onFloor || x.scannedInRange || x.shippedInRange);

    // Send only what the report needs
    const wanted = {};
    orders.forEach(o => { wanted[normalizeOrderNumber_(o.orderNumber)] = true; });
    floorOnly.forEach(x => { wanted[x.orderNumber] = true; });
    const pick = src => { const out = {}; Object.keys(src).forEach(k => { if (wanted[k]) out[k] = src[k]; }); return out; };

    return { ok: true, from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), generatedAt: new Date().toISOString(),
      orders: orders, floor: pick(floorOut), progress: pick(progress), activity: activity, hourly: hourly, floorOnly: floorOnly };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}


// =====================================================================================
// WMS pull connector: Apps Script fetches orders from the WMS API (the browser can't, and
// this keeps the key off the page). Settings are kept in Script Properties; the key /
// password is write-only (never sent back). Pulled orders go through the portal's import
// matching and are imported "add new only": orders already in Order Intake are never changed.
// =====================================================================================
const WMS_PULL_MAX_RECORDS_ = 5000;
const WMS_PULL_MAX_PAGES_ = 50;
const WMS_PULL_BATCH_ = 5;   // order pages asked for at the same time
const WMS_PULL_KEEP_BACKUPS_ = 3;
const WMS_PULL_FIELDS_ = ['name', 'url', 'method', 'body', 'auth', 'headerName', 'username', 'queryName', 'tokenUrl', 'clientId', 'scope',
  'extraHeaders', 'listPath', 'paging', 'pageParam', 'sizeParam', 'pageSize', 'firstPage', 'maxPages', 'lookbackDays', 'skipField', 'skipValues',
  // Picker from pick tasks (same sign-in): task list address + body, and the fields that link them
  'loginUrl', 'loginBody', 'tokenPath',
  'taskUrl', 'taskBody', 'taskPageSize', 'taskType', 'taskGroupField', 'groupField', 'pickerField', 'pickerIdField', 'orderKeyField', 'whNo'];

function wmsPullProps_() {
  const props = PropertiesService.getScriptProperties();
  const prefix = ACTIVE_WH_.wmsPullPrefix || 'WMS_PULL';
  return { props: props, config: prefix + '_CONFIG', secret: prefix + '_SECRET', last: prefix + '_LAST', token: prefix + '_TOKEN' };
}

function readWmsPullConfig_() {
  const p = wmsPullProps_();
  let cfg = {};
  try { cfg = JSON.parse(p.props.getProperty(p.config) || '{}') || {}; } catch (e) { cfg = {}; }
  return cfg;
}

function wmsPullGetConfig_() {
  const p = wmsPullProps_();
  return {
    ok: true,
    config: readWmsPullConfig_(),
    hasSecret: Boolean(p.props.getProperty(p.secret)),
    lastPullAt: p.props.getProperty(p.last) || '',
    login: (s => (s ? { user: s.user, at: s.at, expires: s.expires } : null))(wmsLoginSession_())
  };
}

/** Saves the settings. secret: a new key / password (blank = keep the saved one); options.clearSecret removes it. */
function wmsPullSaveConfig_(config, secret, options) {
  const c = config || {};
  const clean = {};
  WMS_PULL_FIELDS_.forEach(k => { if (c[k] != null && c[k] !== '') clean[k] = String(c[k]).slice(0, k === 'body' || k === 'extraHeaders' ? 4000 : 500); });
  if (clean.url && !/^https:\/\//i.test(clean.url)) return { ok: false, error: 'The API address must start with https://' };
  if (clean.tokenUrl && !/^https:\/\//i.test(clean.tokenUrl)) return { ok: false, error: 'The token address must start with https://' };
  if (clean.loginUrl && !/^https:\/\//i.test(clean.loginUrl)) return { ok: false, error: 'The WMS login address must start with https://' };
  const p = wmsPullProps_();
  const before = readWmsPullConfig_();
  p.props.setProperty(p.config, JSON.stringify(clean));
  const sec = secret == null || clean.auth === 'login' ? '' : String(secret);   // WMS login: the password is never stored
  if (options && options.clearSecret) p.props.deleteProperty(p.secret);
  else if (sec.trim()) p.props.setProperty(p.secret, sec.trim());
  // Keep a WMS sign-in while the same account signs in at the same address; anything else drops the saved token
  const keepLogin = clean.auth === 'login' && before.auth === 'login' && clean.loginUrl === before.loginUrl
    && String(clean.username || '').trim() === String(before.username || '').trim();
  if (!keepLogin) { try { p.props.deleteProperty(p.token); } catch (e) { /* no cached token */ } }
  return wmsPullGetConfig_();
}

/** {{from}} {{to}} (yyyy-MM-dd), {{fromIso}} {{toIso}} {{now}} in the URL / body: from = lookbackDays ago. */
function wmsPullFill_(text, cfg) {
  const days = Math.max(0, Math.min(365, Number(cfg.lookbackDays) || 7));
  const now = new Date();
  const from = new Date(now.getTime() - days * 86400000);
  const ymd = d => d.toISOString().slice(0, 10);
  return String(text || '')
    .replace(/\{\{from\}\}/g, ymd(from)).replace(/\{\{to\}\}/g, ymd(now))
    .replace(/\{\{fromIso\}\}/g, from.toISOString()).replace(/\{\{toIso\}\}/g, now.toISOString())
    .replace(/\{\{now\}\}/g, now.toISOString());
}

function wmsPullHeaders_(cfg, secret) {
  const headers = { Accept: 'application/json' };
  String(cfg.extraHeaders || '').split(/\r?\n/).forEach(line => {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  });
  const auth = cfg.auth || 'none';
  if (auth === 'header') headers[cfg.headerName || 'X-API-Key'] = secret;
  else if (auth === 'bearer') headers.Authorization = 'Bearer ' + secret;
  else if (auth === 'basic') headers.Authorization = 'Basic ' + Utilities.base64Encode(String(cfg.username || '') + ':' + secret);
  else if (auth === 'oauth2') headers.Authorization = 'Bearer ' + wmsPullOAuthToken_(cfg, secret);
  else if (auth === 'login') {
    const sess = wmsLoginSession_();
    if (!sess) throw new Error('Sign in to the WMS first (API Connector → Sign in to WMS)');
    headers.Authorization = 'Bearer ' + sess.token;
  }
  return headers;
}

/**
 * WMS login API (POST {BASE}/api/login {username, password, client}): exchanges the user's WMS username + password
 * for a Bearer token. The password is passed straight to the WMS and never stored or logged; only the token is
 * kept (Script Properties, server side — never sent to the browser). A 401 later = token expired → sign in again.
 * Failed sign-ins are limited (5 per 15 minutes) so a wrong password can't lock the WMS account.
 */
const WMS_LOGIN_MAX_FAILS_ = 5;
const WMS_LOGIN_FAIL_WINDOW_MS_ = 15 * 60000;

function wmsLogin_(username, password) {
  const cfg = readWmsPullConfig_();
  const p = wmsPullProps_();
  const user = String(username || '').trim();
  const pw = password == null ? '' : String(password);
  if (!cfg.loginUrl) return { ok: false, error: 'Enter and save the WMS login address first' };
  if (!user || !pw) return { ok: false, error: 'Enter the WMS username and password' };
  const failKey = p.config.replace('_CONFIG', '_LOGIN_FAILS');
  let fails = { n: 0, since: Date.now() };
  try { fails = JSON.parse(p.props.getProperty(failKey) || 'null') || fails; } catch (e) { /* new window */ }
  if (Date.now() - fails.since > WMS_LOGIN_FAIL_WINDOW_MS_) fails = { n: 0, since: Date.now() };
  if (fails.n >= WMS_LOGIN_MAX_FAILS_) {
    return { ok: false, error: 'Too many failed WMS sign-ins — wait ' + Math.ceil((fails.since + WMS_LOGIN_FAIL_WINDOW_MS_ - Date.now()) / 60000) + ' minute(s) so the WMS account is not locked' };
  }
  const fail = err => {
    fails.n++;
    p.props.setProperty(failKey, JSON.stringify(fails));
    return { ok: false, error: err };
  };
  const jsonText = v => JSON.stringify(String(v)).slice(1, -1);   // safe inside a JSON string
  const body = String(cfg.loginBody || '{"username":"{{username}}","password":"{{password}}","client":"web_client"}')
    .replace(/\{\{username\}\}/g, jsonText(user)).replace(/\{\{password\}\}/g, jsonText(pw));
  let resp;
  try {
    resp = UrlFetchApp.fetch(cfg.loginUrl, { method: 'post', contentType: 'application/json', payload: body,
      headers: { Accept: 'application/json' }, muteHttpExceptions: true, followRedirects: true });
  } catch (e) {
    return { ok: false, error: 'Cannot reach the WMS login: ' + String(e && e.message || e).slice(0, 160) };
  }
  const code = resp.getResponseCode();
  let data = null;
  try { data = JSON.parse(resp.getContentText()); } catch (e) { data = null; }
  // The WMS's own message, if any (message → msg → errorMessage)
  const msg = data && typeof data === 'object' ? (data.message || data.msg || data.errorMessage || '') : '';
  const said = msg ? ': ' + String(msg).slice(0, 160) : '';
  if ([400, 401, 403, 422].indexOf(code) !== -1 || (code < 300 && data && data.success === false)) {
    return fail('The WMS sign-in failed' + (code >= 400 ? ' (HTTP ' + code + ')' : '') + said + '. Check the username and password.');
  }
  if (code >= 500) return { ok: false, error: 'The WMS server had an error at sign-in (HTTP ' + code + ')' + said };
  if (code >= 400) return { ok: false, error: 'The WMS sign-in answered HTTP ' + code + said };
  if (data == null) return { ok: false, error: 'The WMS sign-in did not answer with JSON' };
  const token = wmsFindToken_(data, cfg.tokenPath);
  if (!token) {
    // Field names only — never their values
    const names = [];
    const walk = (o, pre, d) => { if (!o || typeof o !== 'object' || d > 3) return; Object.keys(o).forEach(k => { names.push(pre + k); walk(o[k], pre + k + '.', d + 1); }); };
    walk(data, '', 0);
    return { ok: false, error: 'Signed in, but no token was found. The answer has these fields: ' + names.slice(0, 40).join(', ') + ' — enter which one holds the token in "Where the token is".' };
  }
  const ttl = Number(wmsFindKey_(data, ['expires_in', 'expiresIn'])) || 0;
  p.props.setProperty(p.token, JSON.stringify({ token: token, user: user, at: Date.now(), expires: ttl ? Date.now() + ttl * 1000 : 0 }));
  p.props.deleteProperty(failKey);
  // Remember who signed in (not the password)
  cfg.username = user;
  p.props.setProperty(p.config, JSON.stringify(cfg));
  return wmsPullGetConfig_();
}

function wmsSignOut_() {
  const p = wmsPullProps_();
  p.props.deleteProperty(p.token);
  return wmsPullGetConfig_();
}

/** The saved WMS sign-in, or null (none / expired). */
function wmsLoginSession_() {
  const p = wmsPullProps_();
  try {
    const s = JSON.parse(p.props.getProperty(p.token) || 'null');
    if (s && s.token && s.user && (!s.expires || s.expires > Date.now() + 30000)) return s;
  } catch (e) { /* none */ }
  return null;
}

function wmsFindKey_(o, names, depth) {
  if (!o || typeof o !== 'object' || (depth || 0) > 4) return null;
  for (const n of names) if (o[n] != null && typeof o[n] !== 'object') return o[n];
  for (const k of Object.keys(o)) { const f = wmsFindKey_(o[k], names, (depth || 0) + 1); if (f != null) return f; }
  return null;
}

/**
 * The token in the login answer: tokenPath if given, else the first non-empty string at the paths the
 * WMS login spec lists (in its order), else "data" itself when it is a long string. A leading "Bearer " is removed.
 */
const WMS_TOKEN_PATHS_ = ['token', 'access_token', 'accessToken', 'jwt', 'id_token', 'data.token', 'data.access_token',
  'data.accessToken', 'data.jwt', 'result.token', 'result.access_token', 'result.accessToken', 'data.user.token'];
function wmsFindToken_(data, tokenPath) {
  const at = path => {
    let node = data;
    String(path).split('.').filter(Boolean).forEach(k => { node = node == null || typeof node !== 'object' ? null : node[k]; });
    return typeof node === 'string' && node.trim() ? node.trim() : null;
  };
  let t = tokenPath ? at(tokenPath) : null;
  if (!t && !tokenPath) {
    for (const path of WMS_TOKEN_PATHS_) { t = at(path); if (t) break; }
    if (!t && data && typeof data.data === 'string' && data.data.length >= 20) t = data.data.trim();
  }
  return t ? t.replace(/^Bearer\s+/i, '') : null;
}

/** OAuth2 client credentials: client id + secret → access token (kept until it expires). */
function wmsPullOAuthToken_(cfg, secret) {
  const p = wmsPullProps_();
  try {
    const saved = JSON.parse(p.props.getProperty(p.token) || 'null');
    if (saved && saved.token && saved.expires > Date.now() + 60000) return saved.token;
  } catch (e) { /* fetch a new one */ }
  if (!cfg.tokenUrl) throw new Error('Enter the token address for OAuth2');
  const resp = UrlFetchApp.fetch(cfg.tokenUrl, {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    payload: 'grant_type=client_credentials' + (cfg.scope ? '&scope=' + encodeURIComponent(cfg.scope) : ''),
    headers: { Authorization: 'Basic ' + Utilities.base64Encode(String(cfg.clientId || '') + ':' + secret), Accept: 'application/json' },
    muteHttpExceptions: true
  });
  const code = resp.getResponseCode();
  if (code >= 400) throw new Error('The token request was refused (HTTP ' + code + '). Check the client ID and secret.');
  let data;
  try { data = JSON.parse(resp.getContentText()); } catch (e) { throw new Error('The token address did not answer with JSON'); }
  const token = data.access_token || data.accessToken || data.token;
  if (!token) throw new Error('No access token in the token answer');
  p.props.setProperty(p.token, JSON.stringify({ token: token, expires: Date.now() + (Number(data.expires_in) || 3000) * 1000 }));
  return token;
}

/** The array of orders inside the answer: listPath ("data.orders"), or the answer itself, or its first list. */
function wmsPullList_(data, listPath) {
  let node = data;
  if (listPath) {
    String(listPath).split('.').filter(Boolean).forEach(k => { node = node == null ? null : node[k]; });
    if (!Array.isArray(node)) throw new Error('Nothing is a list at "' + listPath + '" in the WMS answer');
    return node;
  }
  if (Array.isArray(node)) return node;
  const find = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 2) return null;
    for (const k of Object.keys(o)) if (Array.isArray(o[k]) && o[k].some(x => x && typeof x === 'object')) return o[k];
    for (const k of Object.keys(o)) { const f = find(o[k], depth + 1); if (f) return f; }
    return null;
  };
  const found = find(node, 0);
  if (!found) throw new Error('No list of orders found in the WMS answer — enter where the orders are (e.g. data.orders)');
  return found;
}

/** One WMS record → flat columns: "shipTo.city", "lines[].qty (total)", "lines[0].sku"; lists of values are joined. */
function wmsPullFlatten_(rec) {
  const out = {};
  const put = (k, v) => { if (Object.keys(out).length < 300) out[k] = v; };
  const walk = (v, key, depth) => {
    if (v == null) { if (key) put(key, ''); return; }
    if (Array.isArray(v)) {
      if (!v.some(x => x && typeof x === 'object')) { put(key, v.join(', ')); return; }
      put(key + '[] (count)', v.length);
      const objs = v.filter(x => x && typeof x === 'object' && !Array.isArray(x));
      const keys = {};
      objs.forEach(o => Object.keys(o).forEach(k => { keys[k] = true; }));
      Object.keys(keys).forEach(k => {
        const nums = objs.map(o => o[k]).filter(x => typeof x === 'number' || (typeof x === 'string' && x.trim() !== '' && !isNaN(Number(x))));
        if (nums.length) put(key + '[].' + k + ' (total)', nums.reduce((a, b) => a + Number(b), 0));
        if (depth < 3 && objs[0] && objs[0][k] != null && typeof objs[0][k] !== 'object') put(key + '[0].' + k, objs[0][k]);
      });
      return;
    }
    if (typeof v === 'object') {
      if (depth >= 3) { put(key, JSON.stringify(v).slice(0, 200)); return; }
      Object.keys(v).forEach(k => walk(v[k], key ? key + '.' + k : k, depth + 1));
      return;
    }
    put(key, v);
  };
  walk(rec, '', 0);
  return out;
}

function wmsPullRequest_(url, cfg, secret, bodyText) {
  return wmsPullRequestAll_([wmsPullBuild_(url, cfg, secret, bodyText)], cfg)[0];
}

/** One WMS request, ready for UrlFetchApp.fetch / fetchAll. */
function wmsPullBuild_(url, cfg, secret, bodyText) {
  const method = String(cfg.method || 'GET').toLowerCase() === 'post' ? 'post' : 'get';
  let fullUrl = url;
  if (cfg.auth === 'query') fullUrl += (fullUrl.indexOf('?') === -1 ? '?' : '&') + encodeURIComponent(cfg.queryName || 'api_key') + '=' + encodeURIComponent(secret);
  const opt = { url: fullUrl, method: method, headers: wmsPullHeaders_(cfg, secret), muteHttpExceptions: true, followRedirects: true };
  if (method === 'post' && (bodyText || cfg.body)) { opt.payload = bodyText || wmsPullFill_(cfg.body, cfg); opt.contentType = 'application/json'; }
  return opt;
}

/** Sends several WMS requests at the same time (UrlFetchApp.fetchAll) and reads each answer. */
function wmsPullRequestAll_(reqs, cfg) {
  const resps = reqs.length > 1 && typeof UrlFetchApp.fetchAll === 'function'
    ? UrlFetchApp.fetchAll(reqs)
    : reqs.map(r => UrlFetchApp.fetch(r.url, Object.assign({}, r, { url: undefined })));
  return resps.map(resp => wmsPullParse_(resp, cfg));
}

function wmsPullParse_(resp, cfg) {
  const code = resp.getResponseCode();
  if (code === 401 && cfg.auth === 'login') {
    // Token expired: drop it and ask for a new sign-in (the password is never kept, so no silent re-login)
    wmsSignOut_();
    throw new Error('The WMS sign-in has expired — press "Sign in to WMS" again');
  }
  const text = resp.getContentText();
  if (code === 401 || code === 403) throw new Error('The WMS refused the sign-in (HTTP ' + code + '). Check the key / password and the sign-in type.');
  if (code >= 400) throw new Error('The WMS answered HTTP ' + code + ': ' + String(text || '').replace(/\s+/g, ' ').slice(0, 200));
  try { return JSON.parse(text); } catch (e) { throw new Error('The WMS did not answer with JSON: ' + String(text || '').replace(/\s+/g, ' ').slice(0, 120)); }
}

/**
 * Reads orders from the WMS (read-only — nothing is saved here). options.test = first page only.
 * Returns flat records for the portal's import matching.
 */
function wmsPullFetch_(options) {
  const opts = options || {};
  const cfg = readWmsPullConfig_();
  if (!cfg.url) return { ok: false, error: 'Enter and save the WMS API address first' };
  const p = wmsPullProps_();
  const secret = p.props.getProperty(p.secret) || '';
  if (!['none', 'login'].includes(cfg.auth || 'none') && !secret) return { ok: false, error: 'Enter and save the API key / password first' };
  try {
    const t0 = Date.now();
    const got = wmsPullRecords_(cfg, secret, Object.assign({}, opts, { extra: cfg.taskUrl ? [wmsTaskFirstRequest_(cfg, secret)] : [] }));
    const t1 = Date.now();
    // Only the chosen warehouse (wh_no). A pull needs one chosen; Test connection lists the warehouses it saw.
    const wh = wmsByWarehouse_(cfg, got.records);
    got.warehouses = wh.warehouses;
    if (wh.hasField && !cfg.whNo && !opts.test) {
      return { ok: false, needWarehouse: true, warehouses: wh.warehouses, error: 'Choose the WMS warehouse (wh_no) before pulling orders' };
    }
    got.records = wh.records;
    got.otherWarehouse = wh.otherWarehouse;
    const pick = cfg.taskUrl ? wmsAddPickers_(cfg, secret, got.records, got.extraAnswers[0]) : null;
    got.seconds = { wms: Math.round((t1 - t0) / 100) / 10, total: Math.round((Date.now() - t0) / 100) / 10 };
    delete got.extraAnswers;
    // Released to Warehouse = the committed date. Not committed yet → not released: comes in on a later pull.
    // Committed = it has a pick list (SPK…) and, when the task API is set, a picking task for it.
    const plField = cfg.groupField || 'pickinglist_no_byproduct';
    // This WMS uses pick lists if any record has the field (some answers leave the field out when it's empty)
    const usesPickLists = Boolean(pick) || got.records.some(r => plField in r);
    const before = got.records.length;
    got.records = got.records.filter(r => (pick ? r.__committed : true) && (!usesPickLists || wmsPickList_(r, plField)));
    got.notCommitted = before - got.records.length;
    if (pick) pick.notCommitted = got.notCommitted;
    const parcel = wmsOrderNumbers_(cfg, got.records, wmsExistingOrderNumbers_());
    got.records = parcel.records;
    got.parcel = parcel.stats;
    const keys = [];
    const seen = {};
    got.records.forEach(r => Object.keys(r).forEach(k => { if (!seen[k]) { seen[k] = true; keys.push(k); } }));
    if (!opts.test) p.props.setProperty(p.last, new Date().toISOString());
    return Object.assign({ ok: true, keys: keys, pickers: pick }, got);
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

/** The order's pick list number, or '' when it has none: missing, blank, or a placeholder such as "-", "N/A", "null", "0". */
function wmsPickList_(r, plField) {
  const v = String(r[plField] == null ? '' : r[plField]).trim();
  if (!/[a-z0-9]/i.test(v) || /^(null|none|n\/?a|undefined|0+)$/i.test(v)) return '';
  return v;
}

/**
 * Keeps only the records of the chosen WMS warehouse (wh_no). Returns { records, warehouses: {wh_no: count} } —
 * the counts are of everything read, so the page can offer the warehouses the WMS sent.
 */
function wmsByWarehouse_(cfg, records) {
  const warehouses = {};
  let hasField = false;
  records.forEach(r => {
    if ('wh_no' in r) hasField = true;
    const w = String(r.wh_no == null ? '' : r.wh_no).trim();
    if (w) warehouses[w] = (warehouses[w] || 0) + 1;
  });
  const want = String(cfg.whNo || '').trim().toUpperCase();
  if (!hasField || !want) return { records: records, warehouses: warehouses, hasField: hasField, otherWarehouse: 0 };
  const kept = records.filter(r => String(r.wh_no == null ? '' : r.wh_no).trim().toUpperCase() === want);
  return { records: kept, warehouses: warehouses, hasField: true, otherWarehouse: records.length - kept.length };
}

/** UPS / FedEx / USPS / DHL (not "… Freight") — same rule as the staging page's small parcel lanes. */
// SCAC codes of small parcel services (UPS, FedEx, USPS, DHL); freight ones (UPGF, FXFE, FXNL, …) are not here
const WMS_PARCEL_SCACS_ = ['UPSN', 'UPSS', 'UPSC', 'FDEG', 'FDXG', 'FDXE', 'FDE', 'FEDX', 'FXSP', 'USPS', 'DHL', 'DHLC', 'DHLG', 'DHLE'];
function wmsIsSmallParcel_(r) {
  // Drop ship orders go out as small parcel, even when the WMS has no carrier on them yet
  if (/^drop[\s_-]*ship/i.test(String(r.outbound_type == null ? '' : r.outbound_type).trim())) return true;
  return ['carrier_name', 'ship_method', 'delivery_service', 'delivery_service_code', 'scac'].some(k => {
    const raw = String(r[k] == null ? '' : r[k]).trim();
    if (!raw) return false;
    // "UPS_GROUND", "FedEx-2Day", "usps.priority": split on anything that isn't a letter or digit
    const c = raw.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
    if (/freight|\bltl\b/.test(c)) return false;
    if (/\bups\b|fed ?ex|\busps\b|postal|\bdhl\b/.test(c)) return true;
    return WMS_PARCEL_SCACS_.indexOf(raw.toUpperCase()) !== -1;
  });
}

function wmsExistingOrderNumbers_() {
  const have = {};
  try {
    if (!SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ACTIVE_WH_.ordersSheet)) return have;   // reading never creates the tab
    const sheet = getOrdersSheet_();
    const col = ORDER_FIELDS_.findIndex(f => f.key === 'orderNumber');
    readOrderRows_(sheet).forEach(r => { const k = normalizeOrderNumber_(r[col]); if (k) have[k] = true; });
  } catch (e) { /* no Orders tab yet */ }
  return have;
}

/**
 * Adds order_number to each record — what Order Intake uses as the Order #:
 *  - regular orders: the DN number (outbound_no)
 *  - small parcel (UPS / FedEx / USPS / DHL): the pick list number (SPK…, pickinglist_no_byproduct), so CS can follow
 *    the picking. DNs on the same pick list become ONE order: cartons + pallets added up, the DNs listed in parcel_dns.
 * Small parcel orders without a pick list yet (not committed in the WMS) are left for a later pull, and a pick list
 * whose DN is already in Order Intake is left out, so the same shipment is never entered twice.
 */
function wmsOrderNumbers_(cfg, records, existing) {
  const dnField = cfg.orderKeyField || 'outbound_no';
  const plField = cfg.groupField || 'pickinglist_no_byproduct';
  const stats = { parcelOrders: 0, parcelDns: 0, waitingForPickList: 0, alreadyAsDn: 0 };
  const has = existing || {};
  const out = [];
  const groups = {};
  records.forEach(r => {
    const dn = String(r[dnField] == null ? '' : r[dnField]).trim();
    if (!(plField in r) || !wmsIsSmallParcel_(r)) { r.order_number = dn; out.push(r); return; }
    const pl = wmsPickList_(r, plField);
    if (!pl) { stats.waitingForPickList++; return; }
    if (!groups[pl]) { groups[pl] = []; out.push({ __group: pl }); }
    groups[pl].push(r);
  });
  const num = v => Number(String(v == null ? '' : v).replace(/,/g, '')) || 0;
  const uniq = (list, k) => list.map(r => String(r[k] == null ? '' : r[k]).trim()).filter((v, i, a) => v && a.indexOf(v) === i);
  const result = [];
  out.forEach(r => {
    if (!r.__group) { result.push(r); return; }
    const list = groups[r.__group];
    const dns = uniq(list, dnField);
    if (dns.some(d => has[normalizeOrderNumber_(d)])) { stats.alreadyAsDn++; return; }
    const m = Object.assign({}, list[0]);
    m.order_number = r.__group;
    m.parcel_dns = list.length > 1 || dns.length ? 'DNs: ' + dns.join(', ') : '';
    m.ttl_box = list.reduce((t, x) => t + num(x.ttl_box), 0);
    m.ttl_pallet = list.reduce((t, x) => t + num(x.ttl_pallet), 0);
    ['po_no', 'outbound_note', 'bol_no'].forEach(k => { if (k in m) m[k] = uniq(list, k).join(', '); });
    const dates = uniq(list, 'ship_no_later').sort();
    if (dates.length) m.ship_no_later = dates[0];   // the earliest ship-by date
    stats.parcelOrders++;
    stats.parcelDns += list.length;
    result.push(m);
  });
  return { records: result, stats: stats };
}

/** Reads the outbound records (all pages); options.test = first page; options.noSkip = keep the leave-out records too. */
function wmsPullRecords_(cfg, secret, opts) {
    const base = wmsPullFill_(cfg.url, cfg);
    const paging = cfg.paging || 'none';
    const size = Math.max(1, Math.min(1000, Number(cfg.pageSize) || 100));
    const maxPages = opts.test ? 1 : Math.max(1, Math.min(WMS_PULL_MAX_PAGES_, Number(cfg.maxPages) || 10));
    const first = cfg.firstPage === '0' || cfg.firstPage === 0 ? 0 : 1;
    const records = [];
    const seenRec = {};
    let pages = 0, more = false, skippedByRule = 0;
    // Records to leave out, e.g. outbound_status = SHIPPED, CANCELLED
    const skipField = opts.noSkip ? '' : String(cfg.skipField || '').trim();
    const skipValues = String(cfg.skipValues || '').split(',').map(v => v.trim().toUpperCase()).filter(Boolean);
    let bodyObj = null;
    if (paging === 'rows') {
      try { bodyObj = JSON.parse(wmsPullFill_(cfg.body || '{}', cfg)); } catch (e) { throw new Error('The request body is not valid JSON'); }
    }
    const pageRequest = i => {
      let url = base;
      let bodyText = null;
      if (paging === 'rows') {
        // AG Grid style: startRow / endRow in the POST body
        bodyText = JSON.stringify(Object.assign({}, bodyObj, { startRow: i * size, endRow: (i + 1) * size }));
      } else if (paging !== 'none') {
        const add = (k, v) => { url += (url.indexOf('?') === -1 ? '?' : '&') + encodeURIComponent(k) + '=' + encodeURIComponent(v); };
        if (paging === 'page') add(cfg.pageParam || 'page', first + i);
        else add(cfg.pageParam || 'offset', i * size);
        if (cfg.sizeParam) add(cfg.sizeParam, size);
      }
      return wmsPullBuild_(url, cfg, secret, bodyText);
    };
    // Pages are asked for a few at a time (in parallel); extra requests (the pick tasks) go with the first batch
    const batch = paging === 'none' ? 1 : WMS_PULL_BATCH_;
    const extra = opts.extra || [];
    let extraAnswers = [];
    let done = false;
    for (let i = 0; i < maxPages && !done; i += batch) {
      const idx = [];
      for (let j = i; j < Math.min(maxPages, i + batch); j++) idx.push(j);
      const reqs = idx.map(pageRequest).concat(i === 0 ? extra : []);
      const answers = wmsPullRequestAll_(reqs, cfg);
      if (i === 0) extraAnswers = answers.slice(idx.length);
      for (let n = 0; n < idx.length; n++) {
        const list = wmsPullList_(answers[n], cfg.listPath);
        pages++;
        let fresh = 0;
        list.forEach(r => {
          const sig = JSON.stringify(r);
          if (seenRec[sig]) return;          // a WMS that ignores paging sends the same rows again
          seenRec[sig] = true;
          fresh++;
          const flat = r && typeof r === 'object' ? wmsPullFlatten_(r) : { value: r };
          if (skipField && skipValues.indexOf(String(flat[skipField] == null ? '' : flat[skipField]).trim().toUpperCase()) !== -1) { skippedByRule++; return; }
          if (records.length < WMS_PULL_MAX_RECORDS_) records.push(flat);
        });
        // 'rows' paging: the WMS gives no total, so keep going until a page is empty (or repeats)
        if (paging === 'none' || list.length === 0 || fresh === 0 || (paging !== 'rows' && list.length < size) || records.length >= WMS_PULL_MAX_RECORDS_) { done = true; break; }
        if (idx[n] === maxPages - 1) more = true;
      }
    }
    return { records: records, pages: pages, skippedByRule: skippedByRule, truncated: records.length >= WMS_PULL_MAX_RECORDS_, morePages: more, extraAnswers: extraAnswers };
}

/**
 * Picking tasks → picker per pick list. Returns { byGroup: { group_no: { picker, pickerId, status, taskId } | { conflict: n } }, tasks }.
 * Only tasks of taskType (PICKING). Two tasks on one pick list = a data problem: no picker is chosen for it.
 */
function wmsTaskFirstRequest_(cfg, secret) {
  const size = Math.max(1, Math.min(50000, Number(cfg.taskPageSize) || 50000));
  let body;
  try { body = JSON.parse(wmsPullFill_(cfg.taskBody || '{}', cfg)); } catch (e) { throw new Error('The task request body is not valid JSON'); }
  body.startRow = 0;
  body.endRow = size;
  return wmsPullBuild_(cfg.taskUrl, Object.assign({}, cfg, { method: 'POST', listPath: '' }), secret, JSON.stringify(body));
}

function wmsPickTasks_(cfg, secret, firstAnswer) {
  const size = Math.max(1, Math.min(50000, Number(cfg.taskPageSize) || 50000));
  const type = String(cfg.taskType || 'PICKING').toUpperCase();
  const gField = cfg.taskGroupField || 'group_no', pField = cfg.pickerField || 'assigned_to', idField = cfg.pickerIdField || 'assigned_to_id';
  let body;
  try { body = JSON.parse(wmsPullFill_(cfg.taskBody || '{}', cfg)); } catch (e) { throw new Error('The task request body is not valid JSON'); }
  const taskCfg = Object.assign({}, cfg, { method: 'POST', listPath: '' });
  const byGroup = {};
  let total = 0;
  for (let i = 0; i < 20; i++) {
    body.startRow = i * size;
    body.endRow = (i + 1) * size;
    const answer = i === 0 && firstAnswer !== undefined ? firstAnswer : wmsPullRequest_(cfg.taskUrl, taskCfg, secret, JSON.stringify(body));
    const list = wmsPullList_(answer, '');
    list.forEach(t => {
      if (!t || String(t.type || '').toUpperCase() !== type) return;   // only picking tasks
      if (cfg.whNo && t.wh_no != null && String(t.wh_no).trim().toUpperCase() !== String(cfg.whNo).trim().toUpperCase()) return;   // another warehouse
      total++;
      const g = String(t[gField] == null ? '' : t[gField]).trim();
      if (!g) return;
      const cur = byGroup[g];
      // The picking task is created when the order is committed: its created_at = the committed time (kept as the WMS gives it)
      const created = t.created_at == null ? '' : String(t.created_at).trim();
      const earlier = (a, b) => (!a ? b : !b ? a : ((Date.parse(b) || Infinity) < (Date.parse(a) || Infinity) ? b : a));
      if (cur) { byGroup[g] = { conflict: (cur.conflict || 1) + 1, createdAt: earlier(cur.createdAt, created) }; return; }
      byGroup[g] = { picker: t[pField] == null ? '' : String(t[pField]).trim(), pickerId: t[idField] == null ? '' : String(t[idField]), status: t.status || '', taskId: t.task_id == null ? '' : String(t.task_id), createdAt: created };
    });
    if (list.length < size) break;   // a full page means there may be more
  }
  return { byGroup: byGroup, tasks: total };
}

/** Adds picker_id / picker_name / picking_task_id / picking_task_status (+ picker_exception) to each outbound record
 *  by pick list (pickinglist_no_byproduct = group_no). The original fields are kept as they are. */
function wmsAddPickers_(cfg, secret, records, firstTaskAnswer) {
  const t = wmsPickTasks_(cfg, secret, firstTaskAnswer);
  const gField = cfg.groupField || 'pickinglist_no_byproduct';
  const out = { tasks: t.tasks, matched: 0, noTask: 0, noPicker: 0, conflicts: 0 };
  records.forEach(r => {
    const g = wmsPickList_(r, gField);   // '' for a missing or placeholder pick list: no task can match it
    const task = g ? t.byGroup[g] : null;
    // Field names from the "Outbound & Picker Data Integration Rules"; empty when there is no single matching task
    r.picker_id = ''; r.picker_name = ''; r.picking_task_id = ''; r.picking_task_status = ''; r.picker_exception = ''; r.committed_at = '';
    Object.defineProperty(r, '__committed', { value: Boolean(task), enumerable: false });   // has a picking task = committed
    if (!task) { out.noTask++; return; }
    r.committed_at = task.createdAt || '';
    if (task.conflict) { out.conflicts++; r.picker_exception = task.conflict + ' PICKING tasks share pick list ' + g + ' — none was chosen'; return; }
    r.picker_name = task.picker; r.picker_id = task.pickerId; r.picking_task_status = task.status; r.picking_task_id = task.taskId;
    if (task.picker) out.matched++; else out.noPicker++;
  });
  return out;
}

/**
 * Fills the Picker on orders already in Order Intake — ONLY where Picker is blank, and nothing else.
 * options.apply = false → just lists what would be filled. Picks come from the WMS: order (orderKeyField,
 * e.g. outbound_no) → pick list → its one picking task's assigned_to.
 */
function wmsFillPickers_(options) {
  const opts = options || {};
  const cfg = readWmsPullConfig_();
  if (!cfg.url || !cfg.taskUrl) return { ok: false, error: 'Enter and save the WMS API and the task API addresses first' };
  const p = wmsPullProps_();
  const secret = p.props.getProperty(p.secret) || '';
  if (!['none', 'login'].includes(cfg.auth || 'none') && !secret) return { ok: false, error: 'Enter and save the API key / password first' };
  let got, stats;
  try {
    got = wmsPullRecords_(cfg, secret, { noSkip: true, extra: [wmsTaskFirstRequest_(cfg, secret)] });
    const wh = wmsByWarehouse_(cfg, got.records);
    if (wh.hasField && !cfg.whNo) return { ok: false, needWarehouse: true, warehouses: wh.warehouses, error: 'Choose the WMS warehouse (wh_no) first' };
    got.records = wh.records;
    stats = wmsAddPickers_(cfg, secret, got.records, got.extraAnswers[0]);
    got.records = wmsOrderNumbers_(cfg, got.records, {}).records;   // SPK… for small parcel, DN otherwise
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
  const pickerByOrder = {};
  got.records.forEach(r => {
    const k = normalizeOrderNumber_(r.order_number);
    if (k && r.picker_name) pickerByOrder[k] = String(r.picker_name).slice(0, 80);
  });
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, error: 'Busy — try again' };
  try {
    const sheet = getOrdersSheet_();
    const rows = readOrderRows_(sheet);
    const col = {};
    ORDER_FIELDS_.forEach((f, i) => { col[f.key] = i; });
    const fills = [];
    let alreadySet = 0, notFound = 0;
    rows.forEach((r, i) => {
      const ord = normalizeOrderNumber_(r[col.orderNumber]);
      if (!ord) return;
      const picker = pickerByOrder[ord];
      if (!picker) { notFound++; return; }
      if (String(r[col.picker] || '').trim()) { alreadySet++; return; }   // never overwrite a picker
      fills.push({ row: i, orderNumber: ord, picker: picker });
    });
    if (opts.apply && fills.length) {
      if (typeof sheet.getRange === 'function') {
        fills.forEach(f => sheet.getRange(f.row + 2, col.picker + 1).setValue(f.picker));   // only the Picker cell
        SpreadsheetApp.flush();
      }
    }
    return {
      ok: true, applied: Boolean(opts.apply), fills: fills.map(f => ({ orderNumber: f.orderNumber, picker: f.picker })),
      alreadySet: alreadySet, notFound: notFound, wmsRecords: got.records.length, pickers: stats
    };
  } finally {
    lock.releaseLock();
  }
}

/** Before a WMS pull adds orders: copy of the Orders tab ("Orders backup 2026-11-27 14:50"); the newest 3 are kept. */
function backupOrdersSheet_(sheet) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    if (!sheet || typeof sheet.copyTo !== 'function' || typeof ss.getSheets !== 'function') return;
    const base = ACTIVE_WH_.ordersSheet + ' backup ';
    const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone ? Session.getScriptTimeZone() : 'America/Los_Angeles', 'yyyy-MM-dd HH:mm:ss');
    const copy = sheet.copyTo(ss);
    copy.setName(base + stamp);
    const old = ss.getSheets().filter(s => s.getName().indexOf(base) === 0).sort((a, b) => (a.getName() < b.getName() ? 1 : -1));
    old.slice(WMS_PULL_KEEP_BACKUPS_).forEach(s => ss.deleteSheet(s));
  } catch (e) {
    // A failed backup never blocks the import (it only adds rows), but say so in the log
    console.warn('Orders backup before WMS pull failed: ' + e);
  }
}

