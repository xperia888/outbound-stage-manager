const SHEET_NAME = 'State';

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('ONUS-ONT Outbound Pallet Staging Manager v2')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}


function loadBoardState() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }
  const raw = sheet.getRange('A1').getValue();
  const updatedAt = sheet.getRange('B1').getValue();
  return {
    ok: true,
    stateJson: raw ? String(raw) : null,
    updatedAt: updatedAt ? String(updatedAt) : null
  };
}

function saveBoardState(stateJson) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000); // Prevents simultaneous TC56 scan collisions
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName(SHEET_NAME);
    if (!sheet) {
      sheet = ss.insertSheet(SHEET_NAME);
    }
    const now = new Date().toISOString();
    sheet.getRange('A1').setValue(stateJson);
    sheet.getRange('B1').setValue(now);
    return { ok: true, updatedAt: now };
  } finally {
    lock.releaseLock();
  }
}
