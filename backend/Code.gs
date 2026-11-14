/**
 * Potluck signup backend: Google Apps Script + Google Sheet.
 * Setup (one time, ~5 minutes):
 * 1. Add a "Signups" tab to the Sheet with header row:
 *    id | name | dish | course | needOven | allergies | servings | createdAt
 * 2. Extensions > Apps Script, paste this file, save.
 * 3. Deploy > New deployment > Web app. Execute as: Me; access: Anyone.
 * 4. Paste the /exec URL into the app's Settings > Apps Script URL.
 * The frontend POSTs JSON with an `action` field; GET ?action=list returns signups.
 */

const SHEET_NAME = 'Signups';
const HEADERS = ['id', 'name', 'dish', 'course', 'needOven', 'allergies', 'servings', 'createdAt'];

function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  }
  return sh;
}

function rowToSignup_(row) {
  const s = {};
  HEADERS.forEach((h, i) => { s[h] = row[i]; });
  s.needOven = s.needOven === true || s.needOven === 'TRUE';
  s.servings = Number(s.servings) || 0;
  return s;
}

function list_() {
  const sh = sheet_();
  const values = sh.getDataRange().getValues();
  const rows = values.slice(1).filter((r) => r[0]);
  return rows.map(rowToSignup_);
}

function findRow_(id) {
  const sh = sheet_();
  const values = sh.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]) === String(id)) return i + 1;
  }
  return -1;
}

function doGet(e) {
  return ContentService
    .createTextOutput(JSON.stringify({ signups: list_() }))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const sh = sheet_();

    if (body.action === 'add') {
      const s = body.signup;
      sh.appendRow(HEADERS.map((h) => s[h] === undefined ? '' : s[h]));
    } else if (body.action === 'update') {
      const row = findRow_(body.id);
      if (row === -1) throw new Error('Signup not found: ' + body.id);
      const current = rowToSignup_(sh.getRange(row, 1, 1, HEADERS.length).getValues()[0]);
      const next = Object.assign({}, current, body.patch);
      sh.getRange(row, 1, 1, HEADERS.length).setValues([HEADERS.map((h) => next[h])]);
    } else if (body.action === 'remove') {
      const row = findRow_(body.id);
      if (row === -1) throw new Error('Signup not found: ' + body.id);
      sh.deleteRow(row);
    } else {
      throw new Error('Unknown action: ' + body.action);
    }
    return ContentService
      .createTextOutput(JSON.stringify({ ok: true, signups: list_() }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: String(err && err.message || err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
