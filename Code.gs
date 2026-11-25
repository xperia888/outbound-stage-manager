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

/** What each kind of key may call. */
const ROLE_FUNCTIONS_ = {
  floor: ['loadBoardState', 'saveBoardState', 'logScanEvents', 'listOrders', 'upsertOrders', 'setOrderStatus', 'orderProgress', 'intakeStatus',
    'listImportTemplates', 'saveImportTemplate', 'deleteImportTemplate', 'reportData'],
  cs: ['listOrders', 'upsertOrders', 'setOrderStatus', 'orderProgress', 'intakeStatus',
    'listImportTemplates', 'saveImportTemplate', 'deleteImportTemplate', 'reportData'],
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
  { key: 'createdBy', header: 'Created By', type: 'text' }
];
/** Fields a person or the WMS may set (the rest are kept by the server). */
const ORDER_INPUT_KEYS_ = ['customer', 'releasedAt', 'cartons', 'pallets', 'refType', 'reference', 'orderType',
  'carrier', 'scac', 'proBol', 'shipDate', 'destination', 'notes', 'enteredBy', 'picker', 'vrid'];
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
 *            carrier, scac, proBol, shipDate, destination, notes, enteredBy }]
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
  const mode = opts.mode === 'insertOnly' ? 'insertOnly' : 'upsert';
  const source = String(opts.source || (role === 'api' ? 'WMS API' : 'Manual')).slice(0, 40);
  // People must say who they are (for the reports); the WMS connection may leave it blank
  const batchUser = String(opts.enteredBy == null ? '' : opts.enteredBy).trim().slice(0, 80);
  if (role !== 'api' && !batchUser && list.some(o => !String((o && o.enteredBy) || '').trim())) {
    return { ok: false, needName: true, error: 'Enter your name before creating or importing orders' };
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, error: 'Busy — try again' };
  try {
    const sheet = getOrdersSheet_();
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
  if (!String(enteredBy || '').trim()) return { ok: false, needName: true, error: 'Enter your name before changing orders' };
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
