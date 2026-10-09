/**
 * 노트 앱 클라우드 서버 (구글 Apps Script)
 *
 * 하는 일
 *  - 노트를 구글 드라이브에 저장하고, 구글 시트에 목록을 적는다.
 *  - 페이지 그림을 드라이브의 글자 인식(OCR)으로 읽어 시트에 적고, 손글씨 검색에 쓴다.
 *  - 관리자(나)는 모든 노트를 보고, 학생은 자기 노트만 올리고 내려받는다.
 *
 * 이 코드는 고칠 필요가 없습니다. 비밀번호와 반 목록은 시트의 '설정' 탭에서 바꿉니다.
 * 설치 방법: https://shineonyou1274.github.io/goodnotes/setup.html
 */

const DEFAULT_APP_URL = 'https://shineonyou1274.github.io/goodnotes/';
const SETTINGS_SHEET = '설정';
const CLASS_START_ROW = 6; // '설정' 탭에서 반 목록이 시작하는 줄
const ROOT_FOLDER = '노트 앱 저장소';
const NOTES_SHEET = '노트';
const TEXT_SHEET = '페이지 글자';
const NOTE_HEADERS = ['노트 ID', '제목', '반', '이름', '소유자', '수정 시각', '쪽 수', '노트 파일', 'PDF', '인식된 글자'];
const TEXT_HEADERS = ['노트 ID', '쪽', '페이지 ID', '인식된 글자', '인식 시각'];
const C = { id: 0, title: 1, cls: 2, name: 3, owner: 4, updated: 5, pages: 6, file: 7, pdf: 8, text: 9 };

function doGet() {
  return out_({ ok: true, app: 'goodnotes-web', message: '노트 앱 서버가 동작 중입니다.' });
}

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    const who = authorize_(req);
    const fn = ACTIONS[req.action];
    if (!fn) throw new Error('알 수 없는 요청입니다: ' + req.action);
    return out_(Object.assign({ ok: true }, fn(req, who)));
  } catch (err) {
    return out_({ ok: false, error: String((err && err.message) || err) });
  }
}

const ACTIONS = {
  ping: (req, who) => {
    let classes;
    if (who.role === 'owner') {
      // 관리자에게만 반 목록(초대 링크용)을 알려 주고, 시트의 초대 링크도 채운다
      const st = settings_();
      classes = Object.keys(st.classes).map((code) => ({ code: code, name: st.classes[code] }));
      // 앱이 실제로 접속한 주소로 시트의 링크를 채운다 (가장 정확한 주소)
      try { refreshLinks_(req.selfUrl); } catch (e) { /* 링크 채우기는 실패해도 된다 */ }
    }
    return { role: who.role, name: who.name, className: who.cls, classes: classes };
  },
  list: listNotes_,
  upload: uploadNote_,
  ocr: ocrPages_,
  download: downloadNote_,
  search: searchText_,
  remove: removeNote_,
};

/* ---------- 권한 ---------- */
function authorize_(req) {
  const st = settings_();
  if (req.key !== undefined) {
    if (st.key.length < 8) throw new Error("시트 '설정' 탭의 관리자 비밀번호를 8자 이상으로 적어 주세요.");
    if (String(req.key) !== st.key) throw new Error('비밀번호가 맞지 않습니다.');
    return { role: 'owner', owner: 'owner', name: '관리자', cls: '' };
  }
  if (!Object.keys(st.classes).length) throw new Error("이 저장소는 학생 참여를 받지 않습니다. (시트 '설정' 탭에 반이 없음)");
  const code = String(req.classCode || '').trim();
  if (!Object.prototype.hasOwnProperty.call(st.classes, code)) throw new Error('수업 코드가 맞지 않습니다.');
  if (!req.token || String(req.token).length < 16) throw new Error('기기 정보가 올바르지 않습니다.');
  const name = String(req.name || '').trim().slice(0, 40);
  if (!name) throw new Error('이름을 입력하세요.');
  return { role: 'student', owner: hash_(req.token), name, cls: st.classes[code] || code };
}

/* ---------- '설정' 탭 ---------- */
function randomText_(n) {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < n; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}

function settingsSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('이 스크립트는 구글 시트의 [확장 프로그램 → Apps Script]에서 만들어야 합니다.');
  let sh = ss.getSheetByName(SETTINGS_SHEET);
  if (sh) {
    // 예전 버전의 긴 설명은 짧게 바꾼다
    if (String(sh.getRange(1, 3).getValue()).indexOf('← 노트 앱에서') === 0) writeHelp_(sh);
    return sh;
  }
  sh = ss.insertSheet(SETTINGS_SHEET, 0);
  sh.getRange(1, 1, 5, 2).setValues([
    ['관리자 비밀번호', randomText_(10)],
    ['노트 앱 주소', DEFAULT_APP_URL],
    ['관리자 연결 링크', ''],
    ['', ''],
    ['반 이름', '수업 코드'],
  ]);
  writeHelp_(sh);
  sh.getRange(1, 1, 3, 1).setFontWeight('bold');
  sh.getRange(5, 1, 1, 3).setFontWeight('bold').setBackground('#eef2fd');
  sh.getRange(1, 2).setBackground('#fff6d6');
  sh.getRange(1, 3, 3, 1).setFontColor('#6e6e73');
  sh.getRange(4, 1).setFontColor('#3a6df0');
  sh.setColumnWidth(1, 170);
  sh.setColumnWidth(2, 220);
  sh.setColumnWidth(3, 520);
  return sh;
}

// '설정' 탭의 짧은 설명
function writeHelp_(sh) {
  sh.getRange(1, 3, 3, 1).setValues([
    ['← 8자 이상. 학생에게 비밀'],
    ['← 그대로 두세요'],
    ['← 앱에서 연결하면 자동으로 채워짐'],
  ]);
  sh.getRange(4, 1).setValue('↓ 반 이름만 쓰세요 (예: 2학년 3반). 코드와 링크는 자동');
  sh.getRange(5, 3).setValue('학생 초대 링크');
}

// 비밀번호와 반 목록을 읽는다. 수업 코드가 빈 반에는 코드를 새로 만들어 적는다.
function settings_() {
  const sh = settingsSheet_();
  const last = Math.max(sh.getLastRow(), CLASS_START_ROW);
  const v = sh.getRange(1, 1, last, 3).getValues();
  const classes = {};
  for (let i = CLASS_START_ROW - 1; i < v.length; i++) {
    const name = String(v[i][0] || '').trim();
    if (!name) continue;
    let code = String(v[i][1] || '').trim();
    if (!code || classes[code]) {
      code = randomText_(6);
      sh.getRange(i + 1, 2).setValue(code);
      v[i][1] = code;
    }
    classes[code] = name;
  }
  return {
    key: String(v[0][1] || '').trim(),
    appUrl: String(v[1][1] || '').trim() || DEFAULT_APP_URL,
    classes: classes,
    sheet: sh,
    values: v,
  };
}

// '설정' 탭에 웹 앱 주소와 반별 초대 링크를 채운다.
// 배포가 여러 개면 ScriptApp이 옛 주소를 돌려줄 때가 있어서, 노트 앱이 접속한 주소를 먼저 쓴다.
function refreshLinks_(fromApp) {
  const st = settings_();
  const props = PropertiesService.getScriptProperties();
  const valid = (u) => /^https:\/\/script\.google\.com\/.*\/exec$/.test(String(u || ''));
  let webUrl = '';
  if (valid(fromApp)) {
    webUrl = String(fromApp);
    props.setProperty('webUrl', webUrl);
  } else {
    webUrl = props.getProperty('webUrl') || '';
    if (!valid(webUrl)) {
      try { webUrl = ScriptApp.getService().getUrl() || ''; } catch (e) { webUrl = ''; }
    }
  }
  if (!valid(webUrl)) return false;
  const sh = st.sheet;
  const base = st.appUrl.replace(/#.*$/, '');
  const adminLink = base + '#/join?u=' + encodeURIComponent(webUrl);
  if (st.values[2][1] !== adminLink) sh.getRange(3, 2).setValue(adminLink);
  for (let i = CLASS_START_ROW - 1; i < st.values.length; i++) {
    const code = String(st.values[i][1] || '').trim();
    const name = String(st.values[i][0] || '').trim();
    const link = name && code ? base + '#/join?u=' + encodeURIComponent(webUrl) + '&c=' + encodeURIComponent(code) : '';
    if (st.values[i][2] !== link) sh.getRange(i + 1, 3).setValue(link);
  }
  return true;
}

// 시트를 열면 '노트 앱' 메뉴를 보여 준다
function onOpen() {
  SpreadsheetApp.getUi().createMenu('노트 앱')
    .addItem('초대 링크 만들기', '초대링크만들기')
    .addItem('설치 확인', '설치확인')
    .addToUi();
}

// '설정' 탭에 반 이름을 적으면 수업 코드를 바로 채운다
function onEdit(e) {
  try {
    const sh = e.range.getSheet();
    if (sh.getName() !== SETTINGS_SHEET || e.range.getRow() < CLASS_START_ROW) return;
    settings_();
  } catch (err) { /* 무시 */ }
}

function 초대링크만들기() {
  const ok = refreshLinks_();
  const msg = ok
    ? "'설정' 탭의 C열에 반별 초대 링크를 채웠습니다. 링크를 그 반 학생들에게 보내 주세요."
    : '먼저 [배포 → 새 배포]로 웹 앱을 배포한 뒤 다시 눌러 주세요.';
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { Logger.log(msg); }
}

function hash_(s) {
  const d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8);
  return Utilities.base64EncodeWebSafe(d).slice(0, 22);
}

function canSee_(who, row) {
  return who.role === 'owner' || row[C.owner] === who.owner;
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------- 시트·폴더 ---------- */
function sheet_(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('이 스크립트는 구글 시트의 [확장 프로그램 → Apps Script]에서 만들어야 합니다.');
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(headers);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#eef2fd');
  }
  return sh;
}

function notesSheet_() { return sheet_(NOTES_SHEET, NOTE_HEADERS); }
function textSheet_() { return sheet_(TEXT_SHEET, TEXT_HEADERS); }

function rows_(sh) {
  const last = sh.getLastRow();
  if (last < 2) return [];
  const width = sh.getLastColumn();
  return sh.getRange(2, 1, last - 1, width).getValues().map((r, i) => ({ r: r, row: i + 2 }));
}

function findNote_(id) {
  return rows_(notesSheet_()).find((x) => x.r[C.id] === id) || null;
}

function folder_(path) {
  const props = PropertiesService.getScriptProperties();
  let rootId = props.getProperty('rootFolder');
  let root = null;
  if (rootId) { try { root = DriveApp.getFolderById(rootId); } catch (e) { root = null; } }
  if (!root) {
    root = DriveApp.createFolder(ROOT_FOLDER);
    props.setProperty('rootFolder', root.getId());
  }
  let f = root;
  (path || []).forEach((name) => {
    const it = f.getFoldersByName(name);
    f = it.hasNext() ? it.next() : f.createFolder(name);
  });
  return f;
}

function trash_(fileId) {
  if (!fileId) return;
  try { DriveApp.getFileById(fileId).setTrashed(true); } catch (e) { /* 이미 없음 */ }
}

function cleanName_(s) {
  return String(s || '노트').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);
}

/* ---------- 요청 처리 ---------- */
function listNotes_(req, who) {
  const notes = rows_(notesSheet_())
    .filter((x) => canSee_(who, x.r))
    .map((x) => ({
      id: x.r[C.id],
      title: x.r[C.title],
      cls: x.r[C.cls],
      name: x.r[C.name],
      mine: x.r[C.owner] === who.owner,
      updatedAt: Number(x.r[C.updated]) || 0,
      pages: Number(x.r[C.pages]) || 0,
      pdf: who.role === 'owner' ? x.r[C.pdf] : '',
    }));
  return { notes: notes };
}

function uploadNote_(req, who) {
  const meta = req.meta || {};
  if (!meta.id || typeof req.data !== 'string') throw new Error('올릴 노트가 없습니다.');
  const existing = findNote_(meta.id);
  if (existing && existing.r[C.owner] !== who.owner) throw new Error('다른 사람의 노트는 바꿀 수 없습니다.');

  const ownerFolder = who.role === 'owner' ? ['관리자'] : [cleanName_(who.cls), cleanName_(who.name)];
  const dataFile = folder_(['노트 파일'].concat(ownerFolder))
    .createFile(Utilities.newBlob(req.data, 'application/json', cleanName_(meta.title) + '.gnote'));
  let pdfUrl = '';
  if (req.pdf) {
    const pdfName = (who.role === 'owner' ? '' : cleanName_(who.name) + ' - ') + cleanName_(meta.title) + '.pdf';
    const pdf = folder_(['PDF'].concat(ownerFolder)).createFile(Utilities.newBlob(Utilities.base64Decode(req.pdf), 'application/pdf', pdfName));
    pdfUrl = pdf.getUrl();
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sh = notesSheet_();
    const cur = findNote_(meta.id);
    const values = [
      meta.id, String(meta.title || '제목 없음'), who.cls, who.role === 'owner' ? '관리자' : who.name, who.owner,
      Number(meta.updatedAt) || Date.now(), Number(meta.pages) || 0, dataFile.getId(), pdfUrl,
      cur ? cur.r[C.text] : '',
    ];
    if (cur) {
      trash_(cur.r[C.file]);
      if (cur.r[C.pdf]) trash_(fileIdFromUrl_(cur.r[C.pdf]));
      sh.getRange(cur.row, 1, 1, values.length).setValues([values]);
    } else {
      sh.appendRow(values);
    }
    // 페이지 순서가 바뀌었거나 지워진 페이지가 있으면 글자 목록도 맞춘다
    const order = {};
    (meta.pageIds || []).forEach((pid, i) => { order[pid] = i + 1; });
    const tsh = textSheet_();
    const trows = rows_(tsh).filter((x) => x.r[0] === meta.id);
    for (let i = trows.length - 1; i >= 0; i--) {
      const x = trows[i];
      if (!order[x.r[2]]) tsh.deleteRow(x.row);
      else if (order[x.r[2]] !== x.r[1]) tsh.getRange(x.row, 2).setValue(order[x.r[2]]);
    }
    refreshNoteText_(meta.id);
  } finally {
    lock.releaseLock();
  }
  return {};
}

function fileIdFromUrl_(url) {
  const m = String(url).match(/[-\w]{25,}/);
  return m ? m[0] : '';
}

// 페이지 그림을 글자로 바꿔 시트에 적는다
function ocrPages_(req, who) {
  const note = findNote_(req.id);
  if (!note || note.r[C.owner] !== who.owner) throw new Error('노트를 먼저 올려야 합니다.');
  const started = Date.now();
  const done = [];
  const results = [];
  for (const p of req.pages || []) {
    if (Date.now() - started > 240000) break; // Apps Script 실행 시간 제한(6분) 안에서 멈춘다
    let text = '';
    if (p.image) {
      try { text = ocrImage_(Utilities.newBlob(Utilities.base64Decode(p.image), 'image/jpeg', 'page.jpg')); }
      catch (e) { text = ''; }
    }
    results.push({ pageId: p.pageId, page: (p.index || 0) + 1, text: text });
    done.push(p.pageId);
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const tsh = textSheet_();
    const existing = {};
    rows_(tsh).forEach((x) => { if (x.r[0] === req.id) existing[x.r[2]] = x.row; });
    const now = new Date();
    results.forEach((r) => {
      const values = [[req.id, r.page, r.pageId, r.text.slice(0, 45000), now]];
      if (existing[r.pageId]) tsh.getRange(existing[r.pageId], 1, 1, 5).setValues(values);
      else tsh.appendRow(values[0]);
    });
    refreshNoteText_(req.id);
  } finally {
    lock.releaseLock();
  }
  return { done: done };
}

function ocrImage_(blob) {
  let id;
  if (typeof Drive !== 'undefined' && Drive.Files) {
    // [서비스 +]에서 Drive API를 추가한 경우
    if (Drive.Files.create) {
      id = Drive.Files.create({ name: 'ocr-temp', mimeType: MimeType.GOOGLE_DOCS }, blob, { ocrLanguage: 'ko' }).id;
    } else {
      id = Drive.Files.insert({ title: 'ocr-temp', mimeType: MimeType.GOOGLE_DOCS }, blob, { ocr: true, ocrLanguage: 'ko' }).id;
    }
  } else {
    id = ocrUpload_(blob);
  }
  try {
    return DocumentApp.openById(id).getBody().getText().replace(/\s+\n/g, '\n').trim();
  } finally {
    trash_(id);
  }
}

// Drive API 서비스를 추가하지 않아도 되도록 드라이브에 직접 올려 문서로 바꾼다 (글자 인식)
function ocrUpload_(blob) {
  const boundary = 'goodnotes' + Date.now();
  const head = '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n'
    + JSON.stringify({ name: 'ocr-temp', mimeType: 'application/vnd.google-apps.document' })
    + '\r\n--' + boundary + '\r\nContent-Type: ' + (blob.getContentType() || 'image/jpeg') + '\r\n\r\n';
  const tail = '\r\n--' + boundary + '--';
  const payload = Utilities.newBlob(head).getBytes().concat(blob.getBytes(), Utilities.newBlob(tail).getBytes());
  const res = UrlFetchApp.fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&ocrLanguage=ko&fields=id', {
    method: 'post',
    contentType: 'multipart/related; boundary=' + boundary,
    payload: payload,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 300) {
    throw new Error('글자 인식을 쓸 수 없습니다. Apps Script 편집기 왼쪽 [서비스 +]에서 Drive API를 추가해 주세요. ('
      + res.getResponseCode() + ')');
  }
  return JSON.parse(res.getContentText()).id;
}

// 노트 목록 시트의 '인식된 글자' 칸을 페이지 순서대로 다시 채운다
function refreshNoteText_(id) {
  const note = findNote_(id);
  if (!note) return;
  const parts = rows_(textSheet_())
    .filter((x) => x.r[0] === id && x.r[3])
    .sort((a, b) => a.r[1] - b.r[1])
    .map((x) => '[' + x.r[1] + '쪽] ' + x.r[3]);
  notesSheet_().getRange(note.row, C.text + 1).setValue(parts.join('\n').slice(0, 45000));
}

function downloadNote_(req, who) {
  const note = findNote_(req.id);
  if (!note || !canSee_(who, note.r)) throw new Error('노트를 찾을 수 없습니다.');
  const data = DriveApp.getFileById(note.r[C.file]).getBlob().getDataAsString('UTF-8');
  return { data: data, name: note.r[C.name], updatedAt: Number(note.r[C.updated]) || 0 };
}

function norm_(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, '');
}

function searchText_(req, who) {
  const q = String(req.q || '').trim();
  if (!q) return { results: [] };
  const terms = q.toLowerCase().split(/\s+/).map(norm_).filter(String);
  const notes = {};
  rows_(notesSheet_()).forEach((x) => { if (canSee_(who, x.r)) notes[x.r[C.id]] = x.r; });
  const results = [];
  // 제목에서 찾기
  Object.keys(notes).forEach((id) => {
    const r = notes[id];
    if (terms.every((t) => norm_(r[C.title]).indexOf(t) >= 0)) {
      results.push({ id: id, title: r[C.title], cls: r[C.cls], name: r[C.name], mine: r[C.owner] === who.owner, page: 0, pageId: '', snippet: '' });
    }
  });
  // 손글씨(인식된 글자)에서 찾기
  rows_(textSheet_()).forEach((x) => {
    const r = notes[x.r[0]];
    if (!r || results.length >= 100) return;
    const text = String(x.r[3] || '');
    const flat = norm_(text);
    if (!terms.every((t) => flat.indexOf(t) >= 0)) return;
    results.push({
      id: x.r[0], title: r[C.title], cls: r[C.cls], name: r[C.name], mine: r[C.owner] === who.owner,
      page: x.r[1], pageId: x.r[2], snippet: snippet_(text, terms[0]),
    });
  });
  return { results: results };
}

function snippet_(text, term) {
  const lines = text.split('\n');
  const hit = lines.find((l) => norm_(l).indexOf(term) >= 0) || lines[0] || '';
  return hit.slice(0, 120);
}

function removeNote_(req, who) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const note = findNote_(req.id);
    if (!note) return {};
    if (who.role !== 'owner' && note.r[C.owner] !== who.owner) throw new Error('지울 수 없는 노트입니다.');
    trash_(note.r[C.file]);
    if (note.r[C.pdf]) trash_(fileIdFromUrl_(note.r[C.pdf]));
    notesSheet_().deleteRow(note.row);
    const tsh = textSheet_();
    const trows = rows_(tsh).filter((x) => x.r[0] === req.id);
    for (let i = trows.length - 1; i >= 0; i--) tsh.deleteRow(trows[i].row);
  } finally {
    lock.releaseLock();
  }
  return {};
}

/* 설치 확인용: 편집기에서 이 함수를 한 번 실행하면 권한 승인과 시트·폴더 만들기가 끝납니다. */
function 설치확인() {
  const st = settings_();
  notesSheet_();
  textSheet_();
  folder_([]);
  const blank = Utilities.newBlob(Utilities.base64Decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII='), 'image/png', 'test.png');
  try { ocrImage_(blank); } catch (e) { throw new Error('글자 인식 준비가 안 됐습니다: ' + e.message); }
  const linked = refreshLinks_();
  Logger.log('준비 완료! 관리자 비밀번호: ' + st.key);
  Logger.log(linked ? "'설정' 탭에 초대 링크를 채웠습니다." : '이제 [배포 → 새 배포]를 하세요.');
}


// ===== 코드 끝: 이 줄이 보이면 끝까지 잘 붙여 넣은 것입니다 =====
