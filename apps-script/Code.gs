/**
 * 노트 앱 클라우드 서버 (구글 Apps Script)
 *
 * 하는 일
 *  - 노트를 구글 드라이브에 저장하고, 구글 시트에 목록을 적는다.
 *  - 페이지 그림을 드라이브의 글자 인식(OCR)으로 읽어 시트에 적고, 손글씨 검색에 쓴다.
 *  - 관리자(나)는 모든 노트를 보고, 학생은 자기 노트만 올리고 내려받는다.
 *  - 과제(문제지)를 반에 나눠 주고, 제출한 답안을 낱말·AI로 미리 검사해 피드백을 돌려준다.
 *
 * 이 코드는 고칠 필요가 없습니다. 비밀번호와 반 목록은 '설정' 탭, AI 키는 'AI 설정' 탭에서 바꿉니다.
 * 설치 방법: https://shineonyou1274.github.io/goodnotes/setup.html
 */

const DEFAULT_APP_URL = 'https://shineonyou1274.github.io/goodnotes/';
const SETTINGS_SHEET = '설정';
const CLASS_START_ROW = 6; // '설정' 탭에서 반 목록이 시작하는 줄
const ROOT_FOLDER = '노트 앱 저장소';
const NOTES_SHEET = '노트';
const TEXT_SHEET = '페이지 글자';
const TASK_SHEET = '과제';
const AI_SHEET = 'AI 설정';
const NOTE_HEADERS = ['노트 ID', '제목', '반', '이름', '소유자', '수정 시각', '쪽 수', '노트 파일', 'PDF', '인식된 글자',
  '과제', '과제 ID', '낱말 확인', 'AI 피드백 초안', '선생님 피드백', '첨삭 노트', '점수', '채점 근거'];
const TEXT_HEADERS = ['노트 ID', '쪽', '페이지 ID', '인식된 글자', '인식 시각'];
const TASK_HEADERS = ['과제 ID', '제목', '반', '마감', '핵심 낱말', '모범 답안·채점 기준', '제출', '과제 파일', '내준 시각', '루브릭'];
const C = {
  id: 0, title: 1, cls: 2, name: 3, owner: 4, updated: 5, pages: 6, file: 7, pdf: 8, text: 9,
  task: 10, taskId: 11, check: 12, ai: 13, feedback: 14, ret: 15, score: 16, reasons: 17,
};
const T = { id: 0, title: 1, cls: 2, due: 3, keys: 4, rubric: 5, count: 6, file: 7, created: 8, criteria: 9 };
const ALL_CLASSES = '모든 반';

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
  tasks: listTasks_,
  getTask: getTask_,
  assign: assignTask_,
  check: checkNote_,
  noteInfo: noteInfo_,
  giveBack: giveBack_,
  getReturn: getReturn_,
  aiQuestions: aiQuestions_,
  aiWrite: aiWrite_,
  aiRubric: aiRubric_,
};

/* ---------- 권한 ---------- */
function authorize_(req) {
  const st = settings_();
  if (req.key !== undefined) {
    if (st.key.length < 8 || !/[a-zA-Z]/.test(st.key) || !/[0-9]/.test(st.key)) {
      throw new Error("시트 '설정' 탭의 관리자 비밀번호를 영문과 숫자를 섞어 8자 이상으로 바꿔 주세요. (예: note2026ok)");
    }
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
// 영문과 숫자가 섞인 비밀번호
function newPassword_() {
  let p = '';
  while (!/[a-z]/.test(p) || !/[0-9]/.test(p)) p = randomText_(10);
  return p;
}

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
    const c1 = String(sh.getRange(1, 3).getValue());
    if (c1.indexOf('← 노트 앱에서') === 0 || c1 === '← 8자 이상. 학생에게 비밀') writeHelp_(sh);
    return sh;
  }
  sh = ss.insertSheet(SETTINGS_SHEET, 0);
  sh.getRange(1, 1, 5, 2).setValues([
    ['관리자 비밀번호', newPassword_()],
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
    ['← 영문+숫자 8자 이상 (예: note2026ok). 학생에게 비밀'],
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
    .addItem('AI 초안 만들기 (고른 줄)', 'AI초안만들기')
    .addItem('AI 연결 시험', 'AI연결시험')
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

function ownerOnly_(who) {
  if (who.role !== 'owner') throw new Error('선생님만 할 수 있습니다.');
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

function notesSheet_() {
  const sh = sheet_(NOTES_SHEET, NOTE_HEADERS);
  // 예전 시트에는 과제·피드백 칸이 없으니 제목 줄을 늘린다
  if (sh.getLastColumn() < NOTE_HEADERS.length) {
    sh.getRange(1, 1, 1, NOTE_HEADERS.length).setValues([NOTE_HEADERS]);
    sh.getRange(1, 1, 1, NOTE_HEADERS.length).setFontWeight('bold').setBackground('#eef2fd');
    sh.getRange(1, C.feedback + 1).setBackground('#fff6d6');
  }
  return sh;
}
function textSheet_() { return sheet_(TEXT_SHEET, TEXT_HEADERS); }
function taskSheet_() {
  const sh = sheet_(TASK_SHEET, TASK_HEADERS);
  if (sh.getLastColumn() < TASK_HEADERS.length) {
    sh.getRange(1, 1, 1, TASK_HEADERS.length).setValues([TASK_HEADERS]);
    sh.getRange(1, 1, 1, TASK_HEADERS.length).setFontWeight('bold').setBackground('#eef2fd');
  }
  return sh;
}

function cell_(row, i) {
  const v = row[i];
  return v === undefined || v === null ? '' : v;
}

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
      task: cell_(x.r, C.task),
      feedback: !!String(cell_(x.r, C.feedback)).trim(),
      returned: !!cell_(x.r, C.ret),
      check: who.role === 'owner' ? String(cell_(x.r, C.check)) : '',
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
    // 같은 노트가 두 줄로 들어간 적이 있으면 하나만 남긴다
    const dups = rows_(sh).filter((x) => x.r[C.id] === meta.id);
    for (let i = dups.length - 1; i >= 1; i--) {
      trash_(dups[i].r[C.file]);
      if (dups[i].r[C.pdf]) trash_(fileIdFromUrl_(dups[i].r[C.pdf]));
      sh.deleteRow(dups[i].row);
    }
    const cur = findNote_(meta.id);
    const task = meta.taskId ? findTask_(String(meta.taskId)) : null;
    const values = [
      meta.id, String(meta.title || '제목 없음'), who.cls, who.role === 'owner' ? '관리자' : who.name, who.owner,
      Number(meta.updatedAt) || Date.now(), Number(meta.pages) || 0, dataFile.getId(), pdfUrl,
      cur ? cur.r[C.text] : '', task ? task.r[T.title] : '', task ? task.r[T.id] : '',
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
    SpreadsheetApp.flush(); // 다음 요청이 방금 쓴 줄을 보도록 먼저 기록한다
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
    SpreadsheetApp.flush(); // 다음 요청이 방금 쓴 줄을 보도록 먼저 기록한다
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
    SpreadsheetApp.flush(); // 다음 요청이 방금 쓴 줄을 보도록 먼저 기록한다
    lock.releaseLock();
  }
  return {};
}

/* ---------- 과제 ---------- */
function findTask_(id) {
  if (!id) return null;
  return rows_(taskSheet_()).find((x) => String(x.r[T.id]) === String(id)) || null;
}

function taskClasses_(row) {
  return String(row[T.cls] || '').split(',').map((s) => s.trim()).filter(String);
}

function taskVisible_(who, row) {
  if (who.role === 'owner') return true;
  const list = taskClasses_(row);
  return !list.length || list.indexOf(ALL_CLASSES) >= 0 || list.indexOf(who.cls) >= 0;
}

function dateText_(v) {
  if (!v) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    const p = (n) => (n < 10 ? '0' : '') + n;
    return v.getFullYear() + '-' + p(v.getMonth() + 1) + '-' + p(v.getDate());
  }
  return String(v);
}

function timeOf_(v) {
  if (!v) return 0;
  const t = Object.prototype.toString.call(v) === '[object Date]' ? v.getTime() : Date.parse(String(v));
  return isNaN(t) ? 0 : t;
}

function splitKeys_(s) {
  return String(s || '').split(/[,，\n]/).map((k) => k.trim()).filter(String);
}

// 선생님: 문제지를 과제로 내준다 (같은 노트를 다시 내주면 고쳐 쓴다)
function assignTask_(req, who) {
  ownerOnly_(who);
  const m = req.meta || {};
  if (!m.id || typeof req.data !== 'string') throw new Error('내줄 문제지가 없습니다.');
  const title = String(m.title || '과제').slice(0, 100);
  const file = folder_(['과제']).createFile(Utilities.newBlob(req.data, 'application/json', cleanName_(title) + '.gnote'));
  const classes = (m.classes || []).map(String).filter(String);
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sh = taskSheet_();
    const cur = findTask_(m.id);
    const row = cur ? cur.row : sh.getLastRow() + 1;
    if (cur) trash_(cur.r[T.file]);
    sh.getRange(row, 1, 1, TASK_HEADERS.length).setValues([[
      String(m.id), title, classes.length ? classes.join(', ') : ALL_CLASSES, String(m.due || ''),
      String(m.keywords || ''), String(m.rubric || ''),
      '=COUNTIF(\'' + NOTES_SHEET + '\'!L:L,A' + row + ')&"명"', file.getId(), new Date(),
      String(m.criteria || ''),
    ]]);
  } finally {
    SpreadsheetApp.flush();
    lock.releaseLock();
  }
  return {};
}

// 과제 목록. 학생에게는 내 반 과제와 내 노트의 피드백을 함께 알려 준다
function listTasks_(req, who) {
  const tasks = rows_(taskSheet_())
    .filter((x) => x.r[T.id] && taskVisible_(who, x.r))
    .map((x) => ({
      id: String(x.r[T.id]), title: x.r[T.title], cls: x.r[T.cls], due: dateText_(x.r[T.due]),
      assignedAt: timeOf_(x.r[T.created]),
    }));
  const showScore = who.role !== 'owner' && aiSettings_().showScore;
  const mine = who.role === 'owner' ? [] : rows_(notesSheet_())
    .filter((x) => x.r[C.owner] === who.owner && (cell_(x.r, C.taskId) || String(cell_(x.r, C.feedback)).trim() || cell_(x.r, C.ret)))
    .map((x) => ({
      noteId: x.r[C.id], title: x.r[C.title], taskId: String(cell_(x.r, C.taskId)),
      feedback: String(cell_(x.r, C.feedback)).trim(), returned: String(cell_(x.r, C.ret)),
      updatedAt: Number(x.r[C.updated]) || 0,
      score: showScore && String(cell_(x.r, C.feedback)).trim() ? String(cell_(x.r, C.score)) : '',
      scores: showScore && String(cell_(x.r, C.feedback)).trim() ? parseScores_(cell_(x.r, C.reasons)) : [],
    }));
  return { tasks: tasks, mine: mine };
}

function getTask_(req, who) {
  const t = findTask_(req.id);
  if (!t || !taskVisible_(who, t.r)) throw new Error('과제를 찾을 수 없습니다.');
  const data = DriveApp.getFileById(t.r[T.file]).getBlob().getDataAsString('UTF-8');
  return { data: data, title: t.r[T.title], due: dateText_(t.r[T.due]) };
}

/* ---------- 검사·피드백 ---------- */
// 제출한 노트를 검사한다: 핵심 낱말 확인, (AI 키가 있으면) AI 피드백 초안
function checkNote_(req, who) {
  const note = findNote_(req.id);
  if (!note || !canSee_(who, note.r)) throw new Error('노트를 찾을 수 없습니다.');
  return runCheck_(req.id);
}

function runCheck_(id) {
  const note = findNote_(id);
  const task = note ? findTask_(cell_(note.r, C.taskId)) : null;
  if (!note || !task) return { checked: false };
  const keys = splitKeys_(task.r[T.keys]);
  let check = '';
  if (keys.length) {
    const flat = norm_(note.r[C.text]);
    const hit = keys.filter((k) => flat.indexOf(norm_(k)) >= 0);
    const miss = keys.filter((k) => hit.indexOf(k) < 0);
    check = hit.length + '/' + keys.length + (miss.length ? ' · 빠짐: ' + miss.join(', ') : ' · 모두 있음');
  }
  const ai = aiSettings_();
  const criteria = parseRubric_(task.r[T.criteria]);
  let draft = null, graded = null;
  if (ai.key) {
    try {
      if (criteria.length) {
        graded = aiGrade_(note, task, criteria, ai);
        draft = graded.feedback;
      } else {
        draft = aiFeedback_(note, task, ai);
      }
    } catch (e) { draft = 'AI 실패: ' + e.message; }
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const cur = findNote_(id); // 그사이 줄 위치가 바뀌었을 수 있다
    if (!cur) return { checked: false };
    const sh = notesSheet_();
    sh.getRange(cur.row, C.check + 1).setValue(check);
    if (draft !== null) {
      const oldDraft = String(cell_(cur.r, C.ai));
      const oldFeedback = String(cell_(cur.r, C.feedback)).trim();
      sh.getRange(cur.row, C.ai + 1).setValue(draft);
      if (graded) writeScores_(sh, cur.row, graded.scores);
      // '바로 돌려주기'이면 선생님이 직접 쓴 피드백이 없을 때만 AI 피드백을 그대로 보낸다
      if (ai.autoReturn && draft.indexOf('AI 실패') !== 0 && (!oldFeedback || oldFeedback === oldDraft.trim())) {
        sh.getRange(cur.row, C.feedback + 1).setValue(draft);
      }
    }
  } finally {
    SpreadsheetApp.flush();
    lock.releaseLock();
  }
  return { checked: true };
}

function answerPdf_(note) {
  const pdfId = fileIdFromUrl_(note.r[C.pdf]);
  if (!pdfId) throw new Error('답안 PDF가 없습니다.');
  return Utilities.base64Encode(DriveApp.getFileById(pdfId).getBlob().getBytes());
}

function aiFeedback_(note, task, ai) {
  const pdf = answerPdf_(note);
  const prompt = [
    '너는 한국 학교 선생님을 돕는 조교다. 첨부한 PDF는 학생이 문제지(활동지)에 손으로 답을 쓴 것이다.',
    '인쇄된 글자는 문제이고, 손글씨가 학생의 답이다.',
    '과제: ' + task.r[T.title],
    task.r[T.rubric] ? '모범 답안·채점 기준:\n' + task.r[T.rubric] : '',
    task.r[T.keys] ? '꼭 들어가야 할 낱말: ' + task.r[T.keys] : '',
    '선생님의 부탁: ' + ai.ask,
    '학생에게 돌려줄 피드백을 한국어로 써라. 문제 번호별로 맞았는지와 고칠 점을 짧게 쓰고, 마지막에 격려 한 줄.',
    '학생 이름은 쓰지 말고, 마크다운 기호(#, *, **)는 쓰지 마라.',
  ].filter(String).join('\n');
  return askAI_(ai, prompt, { pdf: pdf });
}

/* ---------- 루브릭 ---------- */
// 시트에 적는 모양 (한 줄에 기준 하나):
// 내용 이해 | 4 | 잘함: 핵심을 정확히 설명 / 보통: 일부만 설명 / 부족: 잘못 이해
function parseRubric_(text) {
  return String(text || '').split('\n').map((l) => l.trim()).filter(String).map((l) => {
    const p = l.split('|').map((x) => x.trim());
    const lv = {};
    String(p[2] || '').split('/').forEach((seg) => {
      const m = seg.match(/^\s*(잘함|보통|부족)\s*[:：]\s*([\s\S]*)$/);
      if (m) lv[m[1]] = m[2].trim();
    });
    return { name: p[0], max: Math.max(1, Math.round(Number(p[1])) || 1), good: lv['잘함'] || '', mid: lv['보통'] || '', low: lv['부족'] || '' };
  }).filter((c) => c.name);
}

function rubricText_(criteria) {
  return criteria.map((c) => c.name + ' (' + c.max + '점)'
    + (c.good ? ' 잘함: ' + c.good : '') + (c.mid ? ' / 보통: ' + c.mid : '') + (c.low ? ' / 부족: ' + c.low : '')).join('\n');
}

// '채점 근거' 칸: 기준 | 점수/배점 | 근거
function parseScores_(text) {
  return String(text || '').split('\n').map((l) => l.split('|').map((x) => x.trim())).filter((p) => p[0] && p[1])
    .map((p) => {
      const m = p[1].match(/([\d.]+)\s*\/\s*([\d.]+)/);
      return { name: p[0], score: m ? Number(m[1]) : 0, max: m ? Number(m[2]) : 0, reason: p[2] || '' };
    });
}

function writeScores_(sh, row, scores) {
  const total = scores.reduce((a, s) => a + (Number(s.score) || 0), 0);
  const max = scores.reduce((a, s) => a + (Number(s.max) || 0), 0);
  sh.getRange(row, C.score + 1).setValue(scores.length ? total + '/' + max : '');
  sh.getRange(row, C.reasons + 1).setValue(scores.map((s) => s.name + ' | ' + s.score + '/' + s.max + ' | ' + String(s.reason || '').replace(/[|\n]/g, ' ')).join('\n'));
}

function parseJson_(text) {
  const m = String(text).match(/\{[\s\S]*\}/);
  try { return JSON.parse(m ? m[0] : text); } catch (e) { throw new Error('AI 답을 읽지 못했습니다. 다시 해 주세요.'); }
}

// AI가 루브릭으로 채점하고 피드백을 쓴다
function aiGrade_(note, task, criteria, ai) {
  const prompt = [
    '너는 한국 학교 선생님을 돕는 채점 조교다. 첨부한 PDF는 학생이 문제지에 손으로 답을 쓴 것이다. 인쇄된 글자는 문제, 손글씨가 학생의 답이다.',
    '과제: ' + task.r[T.title],
    task.r[T.rubric] ? '모범 답안:\n' + task.r[T.rubric] : '',
    '루브릭 (기준마다 0점부터 배점까지 정수로 채점):\n' + rubricText_(criteria),
    '선생님의 부탁: ' + ai.ask,
    '반드시 JSON 하나만 출력: {"scores":[{"criterion":"기준 이름 그대로","score":정수,"reason":"한 문장 근거"}],"feedback":"학생에게 줄 피드백"}',
    'feedback에는 점수를 쓰지 말고, 루브릭 기준에 맞춰 잘한 점과 고칠 점을 쓴다. 학생 이름과 마크다운 기호는 쓰지 마라.',
  ].filter(String).join('\n');
  const data = parseJson_(askAI_(ai, prompt, { pdf: answerPdf_(note), json: true }));
  const got = Array.isArray(data.scores) ? data.scores : [];
  const scores = criteria.map((c, i) => {
    const s = got.find((g) => String(g.criterion || '').trim() === c.name) || got[i] || {};
    return { name: c.name, max: c.max, score: Math.max(0, Math.min(c.max, Math.round(Number(s.score)) || 0)), reason: String(s.reason || '') };
  });
  return { scores: scores, feedback: String(data.feedback || '').replace(/\*\*/g, '').trim() };
}

// 선생님: 노트의 검사 결과와 피드백 보기 (돌려주기 창에 채운다)
function noteInfo_(req, who) {
  ownerOnly_(who);
  const note = findNote_(req.id);
  if (!note) throw new Error('노트를 찾을 수 없습니다.');
  const task = findTask_(cell_(note.r, C.taskId));
  return {
    task: cell_(note.r, C.task), check: String(cell_(note.r, C.check)), ai: String(cell_(note.r, C.ai)),
    feedback: String(cell_(note.r, C.feedback)), returned: !!cell_(note.r, C.ret),
    rubric: task ? parseRubric_(task.r[T.criteria]) : [],
    scores: parseScores_(cell_(note.r, C.reasons)),
    aiOn: !!aiSettings_().key,
  };
}

// 선생님이 매긴 점수로 AI가 피드백을 쓴다
function aiWrite_(req, who) {
  ownerOnly_(who);
  const note = findNote_(req.id);
  if (!note) throw new Error('노트를 찾을 수 없습니다.');
  const task = findTask_(cell_(note.r, C.taskId));
  const ai = aiSettings_();
  const scores = (req.scores || []).map((s) => s.name + ': ' + s.score + '/' + s.max + (s.reason ? ' (' + s.reason + ')' : '')).join('\n');
  const prompt = [
    '너는 한국 학교 선생님을 돕는 조교다. 첨부한 PDF는 학생이 손으로 쓴 답안이다.',
    task ? '과제: ' + task.r[T.title] : '',
    task && task.r[T.rubric] ? '모범 답안:\n' + task.r[T.rubric] : '',
    task && parseRubric_(task.r[T.criteria]).length ? '루브릭:\n' + rubricText_(parseRubric_(task.r[T.criteria])) : '',
    scores ? '선생님이 매긴 점수 (이 점수에 맞게 써라):\n' + scores : '',
    req.memo ? '선생님 메모: ' + String(req.memo).slice(0, 500) : '',
    '선생님의 부탁: ' + ai.ask,
    '학생에게 줄 피드백만 한국어로 써라. 점수 숫자는 쓰지 말고, 학생 이름과 마크다운 기호는 쓰지 마라.',
  ].filter(String).join('\n');
  return { feedback: askAI_(ai, prompt, { pdf: answerPdf_(note) }) };
}

// 선생님: 과제에 맞는 루브릭을 AI가 만든다
function aiRubric_(req, who) {
  ownerOnly_(who);
  const prompt = [
    '너는 한국 학교 선생님을 돕는다. 아래 과제를 채점할 루브릭을 만들어라.',
    '과제: ' + String(req.title || '').slice(0, 200),
    req.answers ? '문제·모범 답안:\n' + String(req.answers).slice(0, 3000) : '',
    '평가 기준은 3~5개, 배점은 기준마다 2~5점 정수, 합계는 10점 안팎.',
    '반드시 JSON 하나만 출력: {"rubric":[{"criterion":"평가 기준","points":정수,"good":"잘함일 때 모습","mid":"보통일 때","low":"부족할 때"}]}',
    '설명은 학생이 읽어도 알 수 있게 짧게.',
  ].filter(String).join('\n');
  const data = parseJson_(askAI_(aiSettings_(), prompt, { json: true }));
  return { rubric: normRubric_(data.rubric) };
}

function normRubric_(list) {
  return (Array.isArray(list) ? list : []).map((r) => ({
    name: String(r.criterion || r.name || '').replace(/[|\n]/g, ' ').trim(),
    max: Math.max(1, Math.min(20, Math.round(Number(r.points || r.max)) || 1)),
    good: String(r.good || '').replace(/[|/\n]/g, ' ').trim(),
    mid: String(r.mid || '').replace(/[|/\n]/g, ' ').trim(),
    low: String(r.low || '').replace(/[|/\n]/g, ' ').trim(),
  })).filter((r) => r.name);
}

// 선생님: 피드백 글과 (있으면) 펜으로 첨삭한 노트를 학생에게 돌려준다
function giveBack_(req, who) {
  ownerOnly_(who);
  if (!findNote_(req.id)) throw new Error('노트를 찾을 수 없습니다.');
  let fileId = '';
  if (typeof req.data === 'string' && req.data) {
    fileId = folder_(['첨삭']).createFile(Utilities.newBlob(req.data, 'application/json', 'feedback.gnote')).getId();
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const note = findNote_(req.id);
    const sh = notesSheet_();
    if (req.feedback !== undefined) sh.getRange(note.row, C.feedback + 1).setValue(String(req.feedback).slice(0, 45000));
    if (Array.isArray(req.scores)) writeScores_(sh, note.row, req.scores.slice(0, 20));
    if (fileId) {
      trash_(cell_(note.r, C.ret));
      sh.getRange(note.row, C.ret + 1).setValue(fileId);
    }
  } finally {
    SpreadsheetApp.flush();
    lock.releaseLock();
  }
  return {};
}

// 학생: 선생님이 첨삭한 노트 받기
function getReturn_(req, who) {
  const note = findNote_(req.id);
  if (!note || !canSee_(who, note.r) || !cell_(note.r, C.ret)) throw new Error('첨삭한 노트가 없습니다.');
  return { data: DriveApp.getFileById(note.r[C.ret]).getBlob().getDataAsString('UTF-8') };
}

/* ---------- AI ---------- */
function aiSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(AI_SHEET);
  if (sh) {
    // 예전 탭에는 '점수 보여 주기' 줄이 없다
    if (!String(sh.getRange(5, 1).getValue())) {
      sh.getRange(5, 1, 1, 3).setValues([['점수 보여 주기', '아니오', '← 예: 피드백을 돌려줄 때 루브릭 점수도 학생에게 보임']]);
    }
    // 예전 탭에는 '워크스페이스 ID' 줄이 없다 → 6줄에 넣고 안내를 한 줄 아래로 다시 쓴다
    if (String(sh.getRange(6, 1).getValue()) !== '워크스페이스 ID') {
      sh.getRange(6, 1, 1, 3).setValues([['워크스페이스 ID', '', '← Claude 개인 키(sk-ant-usr…)만: 키가 작업 공간을 고르지 않았다면 wrkspc_…를 넣으세요']]);
      writeAiGuide_(sh);
    }
    return sh;
  }
  sh = ss.insertSheet(AI_SHEET);
  const rows = [
    ['AI 키', '', '← 아래 방법으로 받은 키를 붙여 넣으세요. 비워 두면 AI를 쓰지 않습니다'],
    ['바로 돌려주기', '아니오', '← 예: AI 피드백이 바로 학생에게 감 / 아니오: 선생님이 보고 고친 뒤 돌려줌'],
    ['AI에게 부탁', '학생 눈높이에 맞게 친절하게. 잘한 점 1가지, 고칠 점 1~2가지. 5문장 이내.', '← 자유롭게 고치세요'],
    ['모델', '', '← 비워 두면 자동'],
    ['점수 보여 주기', '아니오', '← 예: 피드백을 돌려줄 때 루브릭 점수도 학생에게 보임'],
    ['워크스페이스 ID', '', '← Claude 개인 키(sk-ant-usr…)만: 키가 작업 공간을 고르지 않았다면 wrkspc_…를 넣으세요'],
  ];
  sh.getRange(1, 1, rows.length, 3).setValues(rows);
  writeAiGuide_(sh);
  sh.getRange(1, 1, 6, 1).setFontWeight('bold');
  sh.getRange(1, 2, 1, 1).setBackground('#fff6d6');
  sh.getRange(1, 3, 6, 1).setFontColor('#6e6e73');
  sh.setColumnWidth(1, 130);
  sh.setColumnWidth(2, 460);
  sh.setColumnWidth(3, 420);
  try {
    const yesNo = SpreadsheetApp.newDataValidation().requireValueInList(['예', '아니오']).build();
    sh.getRange(2, 2).setDataValidation(yesNo);
    sh.getRange(5, 2).setDataValidation(yesNo);
  } catch (e) { /* 목록 상자는 없어도 된다 */ }
  return sh;
}

// 'AI 설정' 탭 7줄부터: 키 받는 방법
function writeAiGuide_(sh) {
  const rows = [
    ['AI 키 받는 방법', '셋 중 하나만 넣으면 됩니다. 키 모양을 보고 앱이 알아서 고릅니다.', ''],
    ['구글 Gemini (무료)', 'aistudio.google.com/apikey → [Create API key] → AIza…로 시작하는 키 복사', '이 시트와 같은 구글 계정으로'],
    ['ChatGPT (유료)', 'platform.openai.com/api-keys → [Create new secret key] → sk-…로 시작하는 키 복사', 'Billing에서 금액을 충전해야 씁니다'],
    ['Claude (유료)', 'console.anthropic.com → API Keys → [Create Key] (작업 공간 하나를 고르면 편함) → sk-ant-…로 시작하는 키 복사', 'Billing에서 금액을 충전해야 씁니다'],
    ['확인', "키를 B1 칸에 붙여 넣고 시트 메뉴 [노트 앱 → AI 연결 시험]. '성공'이 뜨면 끝!", ''],
    ['', '', ''],
    ['알아 두기', '', ''],
    ['•', 'ChatGPT Plus·Claude Pro 같은 월 구독과 API 키는 따로입니다. API 키는 쓴 만큼 요금이 나갑니다.', ''],
    ['•', '무료 Gemini는 사용량을 넘으면 잠시 뒤 다시 됩니다. 무료로 쓰면 구글이 내용을 서비스 개선에 쓸 수 있습니다.', ''],
    ['•', '학생 답안 그림이 AI 회사로 보내집니다. 학교 지침을 확인하세요.', ''],
    ['•', "AI 결과는 '노트' 탭 [AI 피드백 초안] 칸에 들어갑니다. 고쳐서 [선생님 피드백] 칸에 쓰면 학생에게 갑니다.", ''],
    ['•', "루브릭은 앱에서 과제를 내줄 때 정합니다. '과제' 탭 [루브릭] 칸에서도 고칠 수 있습니다. (한 줄에 하나: 기준 | 배점 | 잘함: … / 보통: … / 부족: …)", ''],
    ['•', '모델 칸을 비우면 Gemini는 gemini-flash-latest, ChatGPT는 gpt-5-mini, Claude는 claude-sonnet-5-5를 씁니다.', ''],
  ];
  sh.getRange(7, 1, 20, 3).setValues(Array.from({ length: 20 }, (_, i) => rows[i] || ['', '', '']));
  sh.getRange(7, 1, 20, 3).setFontWeight('normal').setFontColor('#1c1c1e');
  sh.getRange(7, 1, 1, 2).setFontWeight('bold').setFontColor('#3a6df0');
  sh.getRange(8, 1, 4, 1).setFontWeight('bold');
  sh.getRange(8, 3, 4, 1).setFontColor('#6e6e73');
  sh.getRange(13, 1).setFontWeight('bold');
}

function aiSettings_() {
  const v = aiSheet_().getRange(1, 2, 6, 1).getValues();
  return {
    workspace: String(v[5][0] || '').replace(/\s/g, ''),
    showScore: String(v[4][0]).trim() === '예',
    // 복사할 때 딸려 온 띄어쓰기·따옴표·보이지 않는 글자를 뺀다
    key: String(v[0][0] || '').replace(/[\s'"`\u200B-\u200D\uFEFF]/g, ''),
    autoReturn: String(v[1][0]).trim() === '예',
    ask: String(v[2][0] || '').trim() || '친절하게, 5문장 이내.',
    model: String(v[3][0] || '').trim(),
  };
}

// AI에게 묻는다. 키가 sk-ant-로 시작하면 Claude, 아니면 Gemini
function askAI_(ai, prompt, opt) {
  opt = opt || {};
  if (!ai.key) throw new Error("'AI 설정' 탭에 AI 키를 넣어 주세요.");
  if (/^sk-ant-admin/.test(ai.key)) throw new Error('Claude 관리자(Admin) 키로는 AI를 쓸 수 없습니다. 일반 API 키(sk-ant-api…)를 넣어 주세요.');
  const claude = /^sk-ant-/.test(ai.key);
  const gpt = !claude && /^sk-/.test(ai.key);
  let url, headers, body;
  if (gpt) {
    url = 'https://api.openai.com/v1/responses';
    headers = { Authorization: 'Bearer ' + ai.key };
    const content = [];
    if (opt.pdf) content.push({ type: 'input_file', filename: 'answer.pdf', file_data: 'data:application/pdf;base64,' + opt.pdf });
    content.push({ type: 'input_text', text: prompt });
    body = { model: ai.model || 'gpt-5-mini', input: [{ role: 'user', content: content }] };
  } else if (claude) {
    url = 'https://api.anthropic.com/v1/messages';
    headers = { 'x-api-key': ai.key, 'anthropic-version': '2023-06-01' };
    // 개인 키(sk-ant-usr…)가 작업 공간을 고르지 않았으면 작업 공간 ID를 함께 보내야 한다
    if (/^wrkspc_/.test(ai.workspace)) headers['anthropic-workspace-id'] = ai.workspace;
    const content = [];
    if (opt.pdf) content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: opt.pdf } });
    content.push({ type: 'text', text: prompt });
    // 답하기 전에 생각하는 모델이라 답 길이를 넉넉히 준다
    body = { model: ai.model || 'claude-sonnet-5-5', max_tokens: 16000, messages: [{ role: 'user', content: content }] };
  } else {
    url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(ai.model || 'gemini-flash-latest') + ':generateContent';
    headers = { 'x-goog-api-key': ai.key };
    const parts = [];
    if (opt.pdf) parts.push({ inline_data: { mime_type: 'application/pdf', data: opt.pdf } });
    parts.push({ text: prompt });
    body = { contents: [{ role: 'user', parts: parts }] };
    if (opt.json) body.generationConfig = { responseMimeType: 'application/json' };
  }
  for (let attempt = 0; ; attempt++) {
    const res = UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'application/json', headers: headers, payload: JSON.stringify(body), muteHttpExceptions: true,
    });
    const code = res.getResponseCode();
    if ((code === 429 || code >= 500) && attempt < 1) { Utilities.sleep(15000); continue; }
    let json = {};
    try { json = JSON.parse(res.getContentText()); } catch (e) { json = {}; }
    if (code >= 300) {
      const msg = String((json.error && json.error.message) || res.getContentText()).slice(0, 200);
      const who = providerName_(ai) + ' (' + code + ') ';
      // 원래 오류 문장도 함께 보여 줘야 무엇이 문제인지 알 수 있다
      if (/anthropic-workspace-id|workspace/i.test(msg)) {
        throw new Error(who + "이 키는 작업 공간(Workspace)을 정해야 합니다. ① console.anthropic.com → Settings → Workspaces의 ID 칸에서 wrkspc_…를 복사해 'AI 설정' 탭 B6 칸에 넣거나, ② 키를 새로 만들 때 작업 공간 하나를 고르세요. [" + msg + ']');
      }
      if (code === 429) throw new Error(who + '사용량 한도에 걸렸습니다. 잠시 뒤 다시 해 주세요. [' + msg + ']');
      if (/credit|billing|quota|balance/i.test(msg)) throw new Error(who + '요금 잔액이 없습니다. 키를 만든 사이트의 Billing에서 충전해 주세요. [' + msg + ']');
      if (code === 404 || /model/i.test(msg) && /not.?found|does not exist|invalid/i.test(msg)) throw new Error(who + "모델 이름이 맞지 않습니다. 'AI 설정' 탭 B4(모델) 칸을 비워 보세요. [" + msg + ']');
      if (code === 401 || code === 403 || /api.?key|x-api-key|authentication/i.test(msg)) throw new Error(who + "키가 맞지 않습니다. 키 전체를 다시 복사해 B1 칸에 넣어 주세요. [" + msg + ']');
      throw new Error(who + '요청 실패: ' + msg);
    }
    let text = '';
    if (gpt) {
      text = json.output_text || (json.output || []).reduce((all, o) => all.concat(o.type === 'message' ? o.content || [] : []), [])
        .filter((c) => c.type === 'output_text').map((c) => c.text).join('');
    } else if (claude) {
      if (json.stop_reason === 'refusal') throw new Error('Claude가 이 요청에는 답하지 않았습니다. 다시 해 보거나 다른 AI 키를 써 주세요.');
      text = (json.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
    } else {
      const cand = (json.candidates || [])[0];
      text = ((cand && cand.content && cand.content.parts) || []).map((p) => p.text || '').join('');
    }
    if (!text) throw new Error('AI가 답을 주지 않았습니다.');
    return opt.json ? text : text.replace(/\*\*/g, '').replace(/^#+\s*/gm, '').trim();
  }
}

// 선생님: AI로 문제 만들기
function aiQuestions_(req, who) {
  ownerOnly_(who);
  const prompt = [
    '너는 한국 학교 선생님을 돕는다. 아래 조건으로 학생 활동지 문제를 만들어라.',
    '주제·단원: ' + String(req.topic || '').slice(0, 300),
    '학년: ' + String(req.level || '').slice(0, 40),
    '문항 수: ' + (Number(req.count) || 5),
    '문제 유형: ' + String(req.kind || '서술형과 단답형 섞어서'),
    '반드시 JSON 하나만 출력: {"questions":["문제", ...], "answers":["모범 답안", ...], "keywords":["채점 핵심 낱말", ...],'
      + ' "rubric":[{"criterion":"평가 기준","points":정수,"good":"잘함일 때","mid":"보통일 때","low":"부족할 때"}]}',
    '문제 앞에 번호를 붙이지 마라. keywords는 3~8개. rubric은 기준 3~5개, 합계 10점 안팎.',
  ].join('\n');
  const text = askAI_(aiSettings_(), prompt, { json: true });
  const m = text.match(/\{[\s\S]*\}/);
  let data;
  try { data = JSON.parse(m ? m[0] : text); } catch (e) { throw new Error('AI 답을 읽지 못했습니다. 다시 눌러 주세요.'); }
  const list = (a) => (Array.isArray(a) ? a.map(String).filter(String) : []);
  return { questions: list(data.questions), answers: list(data.answers), keywords: list(data.keywords), rubric: normRubric_(data.rubric) };
}

function providerName_(ai) {
  if (/^sk-ant-/.test(ai.key)) return 'Claude';
  if (/^sk-/.test(ai.key)) return 'ChatGPT';
  return 'Gemini';
}

function AI연결시험() {
  let msg;
  const ai = aiSettings_();
  if (!ai.key) msg = "'AI 설정' 탭 B1 칸에 AI 키를 먼저 넣어 주세요.";
  else if (/^sk-ant-admin/.test(ai.key)) msg = '관리자(Admin) 키입니다. 이 키로는 AI에게 물을 수 없습니다. console.anthropic.com → API Keys에서 일반 키(sk-ant-api…)를 만들어 넣어 주세요.';
  else if (!/^(sk-|AIza)/.test(ai.key)) msg = '키 모양이 낯섭니다. Gemini 키는 AIza…, ChatGPT 키는 sk-…, Claude 키는 sk-ant-…로 시작합니다. 키 전체를 다시 복사해 주세요.';
  else {
    try { msg = providerName_(ai) + ' 연결 성공! 답: ' + askAI_(ai, '“연결 성공”이라고만 답하세요.'); } catch (e) { msg = e.message; }
  }
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { Logger.log(msg); }
}

// '노트' 탭에서 고른 줄들의 낱말 확인·AI 초안을 다시 만든다
function AI초안만들기() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getActiveSheet();
  let msg;
  if (sh.getName() !== NOTES_SHEET) {
    msg = "'노트' 탭에서 검사할 학생 줄을 고른 뒤 다시 누르세요.";
  } else {
    const range = sh.getActiveRange();
    const ids = sh.getRange(range.getRow(), 1, range.getNumRows(), 1).getValues().map((r) => r[0]).filter(String);
    let n = 0;
    ids.forEach((id) => { if (runCheck_(id).checked) n++; });
    msg = n ? n + '개를 검사했습니다.' : '과제로 낸 노트가 아닙니다. (과제 ID 칸이 빈 줄)';
  }
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { Logger.log(msg); }
}

/* 설치 확인용: 편집기에서 이 함수를 한 번 실행하면 권한 승인과 시트·폴더 만들기가 끝납니다. */
function 설치확인() {
  const st = settings_();
  notesSheet_();
  textSheet_();
  taskSheet_();
  aiSheet_();
  folder_([]);
  const blank = Utilities.newBlob(Utilities.base64Decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII='), 'image/png', 'test.png');
  try { ocrImage_(blank); } catch (e) { throw new Error('글자 인식 준비가 안 됐습니다: ' + e.message); }
  const linked = refreshLinks_();
  Logger.log('준비 완료! 관리자 비밀번호: ' + st.key);
  Logger.log(linked ? "'설정' 탭에 초대 링크를 채웠습니다." : '이제 [배포 → 새 배포]를 하세요.');
}


// ===== 코드 끝: 이 줄이 보이면 끝까지 잘 붙여 넣은 것입니다 =====
