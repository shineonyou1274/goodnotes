/**
 * 노트 앱 클라우드 서버 (구글 Apps Script)
 *
 * 하는 일
 *  - 노트를 구글 드라이브에 저장하고, 구글 시트에 목록을 적는다.
 *  - 페이지 그림을 드라이브의 글자 인식(OCR)으로 읽어 시트에 적고, 손글씨 검색에 쓴다.
 *  - 관리자(나)는 모든 노트를 보고, 학생은 자기 노트만 올리고 내려받는다.
 *
 * 설치 방법은 apps-script/설치안내.md 를 보세요.
 */

/* ===== 여기 세 줄만 바꾸세요 ===== */
const OWNER_KEY = '여기에-나만-아는-비밀번호';  // 관리자 비밀번호 (8자 이상, 남에게 알려 주지 마세요)
const CLASS_CODE = '';                          // 학생에게 알려 줄 수업 코드. 비워 두면 혼자 쓰는 저장소가 됩니다.
const CLASS_NAME = '';                          // 학생 화면에 보일 수업 이름 (예: '3학년 2반 수학')
/* ================================== */

const DEFAULT_KEY = '여기에-나만-아는-비밀번호';
const ROOT_FOLDER = '노트 앱 저장소';
const NOTES_SHEET = '노트';
const TEXT_SHEET = '페이지 글자';
const NOTE_HEADERS = ['노트 ID', '제목', '이름', '소유자', '수정 시각', '쪽 수', '노트 파일', 'PDF', '인식된 글자'];
const TEXT_HEADERS = ['노트 ID', '쪽', '페이지 ID', '인식된 글자', '인식 시각'];
const C = { id: 0, title: 1, name: 2, owner: 3, updated: 4, pages: 5, file: 6, pdf: 7, text: 8 };

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
  ping: (req, who) => ({
    role: who.role,
    name: who.name,
    className: CLASS_NAME,
    classCode: who.role === 'owner' ? CLASS_CODE : undefined,
  }),
  list: listNotes_,
  upload: uploadNote_,
  ocr: ocrPages_,
  download: downloadNote_,
  search: searchText_,
  remove: removeNote_,
};

/* ---------- 권한 ---------- */
function authorize_(req) {
  if (req.key !== undefined) {
    if (OWNER_KEY === DEFAULT_KEY || OWNER_KEY.length < 8) {
      throw new Error('Code.gs 맨 위의 OWNER_KEY를 8자 이상 나만 아는 비밀번호로 바꾼 뒤 다시 배포하세요.');
    }
    if (req.key !== OWNER_KEY) throw new Error('비밀번호가 맞지 않습니다.');
    return { role: 'owner', owner: 'owner', name: '관리자' };
  }
  if (!CLASS_CODE) throw new Error('이 저장소는 학생 참여를 받지 않습니다. (CLASS_CODE가 비어 있음)');
  if (req.classCode !== CLASS_CODE) throw new Error('수업 코드가 맞지 않습니다.');
  if (!req.token || String(req.token).length < 16) throw new Error('기기 정보가 올바르지 않습니다.');
  const name = String(req.name || '').trim().slice(0, 40);
  if (!name) throw new Error('이름을 입력하세요.');
  return { role: 'student', owner: hash_(req.token), name };
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

  const ownerFolder = who.role === 'owner' ? '관리자' : cleanName_(who.name);
  const dataFile = folder_(['노트 파일', ownerFolder])
    .createFile(Utilities.newBlob(req.data, 'application/json', cleanName_(meta.title) + '.gnote'));
  let pdfUrl = '';
  if (req.pdf) {
    const pdfName = (who.role === 'owner' ? '' : cleanName_(who.name) + ' - ') + cleanName_(meta.title) + '.pdf';
    const pdf = folder_(['PDF', ownerFolder]).createFile(Utilities.newBlob(Utilities.base64Decode(req.pdf), 'application/pdf', pdfName));
    pdfUrl = pdf.getUrl();
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sh = notesSheet_();
    const cur = findNote_(meta.id);
    const values = [
      meta.id, String(meta.title || '제목 없음'), who.role === 'owner' ? '관리자' : who.name, who.owner,
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
  if (typeof Drive === 'undefined') {
    throw new Error('Apps Script 편집기 왼쪽 [서비스 +]에서 Drive API를 추가하세요.');
  }
  if (Drive.Files.create) {
    id = Drive.Files.create({ name: 'ocr-temp', mimeType: MimeType.GOOGLE_DOCS }, blob, { ocrLanguage: 'ko' }).id;
  } else {
    id = Drive.Files.insert({ title: 'ocr-temp', mimeType: MimeType.GOOGLE_DOCS }, blob, { ocr: true, ocrLanguage: 'ko' }).id;
  }
  try {
    return DocumentApp.openById(id).getBody().getText().replace(/\s+\n/g, '\n').trim();
  } finally {
    trash_(id);
  }
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
      results.push({ id: id, title: r[C.title], name: r[C.name], mine: r[C.owner] === who.owner, page: 0, pageId: '', snippet: '' });
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
      id: x.r[0], title: r[C.title], name: r[C.name], mine: r[C.owner] === who.owner,
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
  notesSheet_();
  textSheet_();
  folder_([]);
  const blank = Utilities.newBlob(Utilities.base64Decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII='), 'image/png', 'test.png');
  try { ocrImage_(blank); } catch (e) { throw new Error('글자 인식 준비가 안 됐습니다: ' + e.message); }
  Logger.log('준비 완료! 이제 [배포 → 새 배포]를 하세요.');
}

