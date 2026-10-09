// 구글 시트·드라이브(Apps Script) 클라우드 연결: 올리기, 내려받기, 손글씨 검색
// 관리자(owner): 비밀번호로 연결, 모든 노트를 보고 자기 노트는 기기 사이에 동기화한다.
// 학생(student): 수업 코드와 이름으로 연결, 제출한 자기 노트만 올리고 내려받는다.
import * as db from './db.js';
import { exportBackup, importBackup } from './backup.js';
import { exportPdf } from './pdf.js';
import { renderPageCanvas, ensurePageImages } from './render.js';

const KEY = 'goodnotes-web:cloud';
const DELETED_KEY = 'goodnotes-web:cloud-deleted';
const OCR_BATCH = 6;

export function getCloud() {
  try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; }
}

export function setCloud(cfg) {
  if (cfg) localStorage.setItem(KEY, JSON.stringify(cfg));
  else localStorage.removeItem(KEY);
}

export function newToken() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

function deletedIds() {
  try { return new Set(JSON.parse(localStorage.getItem(DELETED_KEY) || '[]')); } catch { return new Set(); }
}

export function rememberDeleted(id) {
  const s = deletedIds();
  s.add(id);
  localStorage.setItem(DELETED_KEY, JSON.stringify([...s].slice(-500)));
}

async function call(action, body = {}, cfg = getCloud()) {
  if (!cfg) throw new Error('클라우드에 연결되어 있지 않습니다.');
  const auth = cfg.mode === 'owner'
    ? { key: cfg.key }
    : { classCode: cfg.classCode, token: cfg.token, name: cfg.name };
  let res;
  try {
    res = await fetch(cfg.url, {
      method: 'POST',
      // text/plain으로 보내야 Apps Script가 브라우저 보안 검사(CORS)에 막히지 않는다
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, ...auth, ...body }),
    });
  } catch {
    throw new Error('서버에 연결하지 못했습니다. “이 주소가 맞는지 새 탭에서 확인”을 눌러 “노트 앱 서버가 동작 중입니다”가 보이는지 확인하세요. 안 보이면 Apps Script 배포 설정(웹 앱, 액세스 권한: 모든 사용자)을 확인하세요.');
  }
  let data;
  try { data = await res.json(); } catch {
    throw new Error(`서버 응답을 읽을 수 없습니다 (${res.status}). “이 주소가 맞는지 새 탭에서 확인”을 눌러 보고, Apps Script 배포 설정(웹 앱, 액세스 권한: 모든 사용자)을 확인하세요.`);
  }
  if (!data.ok) throw new Error(data.error || '요청이 실패했습니다.');
  return data;
}

export const ping = (cfg) => call('ping', { selfUrl: cfg?.url }, cfg);
export const listRemote = () => call('list').then((d) => d.notes || []);
export const searchRemote = (q) => call('search', { q }).then((d) => d.results || []);
export const removeRemote = (id) => call('remove', { id });
export const listTasks = () => call('tasks');
export const noteInfo = (id) => call('noteInfo', { id });
export const giveBack = (id, feedback, data, scores) => call('giveBack', { id, feedback, data, scores });
export const aiWrite = (id, scores, memo) => call('aiWrite', { id, scores, memo }).then((d) => d.feedback);
export const aiRubric = (title, answers) => call('aiRubric', { title, answers }).then((d) => d.rubric || []);
export const aiQuestions = (opts) => call('aiQuestions', opts);

// 이 노트를 클라우드에 올릴지
export function shouldSync(nb, cfg = getCloud()) {
  // 내려받은 학생 노트(사본)는 올리지 않는다. 노트 메뉴에서 끈 노트(cloud === false)도 올리지 않는다.
  return !!cfg && !nb.remoteId && nb.cloud !== false;
}

export function needsSync(nb, cfg = getCloud()) {
  // fresh: 받기만 하고 아직 쓰지 않은 과제는 제출하지 않는다
  return shouldSync(nb, cfg) && !nb.fresh && (nb.syncedAt || 0) < nb.updatedAt;
}

async function loadPages(nb) {
  const pages = await db.getPages(nb.id);
  const byId = new Map(pages.map((p) => [p.id, p]));
  return nb.pageIds.map((id) => byId.get(id)).filter(Boolean);
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

async function pageImage(page) {
  if (!page.items.length && !page.bg) return null; // 빈 페이지는 읽을 것이 없다
  await ensurePageImages(page);
  const c = renderPageCanvas(page, Math.min(2, 1400 / page.w));
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.82));
  c.width = c.height = 0;
  return blob ? blobToBase64(blob) : null;
}

// 올리기는 한 번에 하나씩만 한다 (노트를 닫자마자 '동기화'를 눌러도 두 번 올라가지 않게)
let uploadQueue = Promise.resolve();

// 노트 하나를 올리고, 바뀐 페이지의 손글씨를 글자로 읽게 한다.
// 이미 올린 뒤로 바뀐 것이 없으면 아무것도 하지 않고 false를 돌려준다.
export function uploadNotebook(nbId, onProgress = () => {}) {
  const run = uploadQueue.then(() => doUpload(nbId, onProgress));
  uploadQueue = run.catch(() => {});
  return run;
}

async function doUpload(nbId, onProgress) {
  const nb = await db.getNotebook(nbId);
  if (!nb || !needsSync(nb)) return false;
  const pages = await loadPages(nb);
  const version = nb.updatedAt;
  onProgress('노트 올리는 중…');
  const data = await (await exportBackup(nb, pages)).text();
  const pdf = await blobToBase64(await exportPdf(pages, null, { maxScale: 1.4, quality: 0.72 }));
  await call('upload', {
    meta: { id: nb.id, title: nb.title, updatedAt: version, pages: pages.length, pageIds: pages.map((p) => p.id), taskId: nb.taskId || '' },
    data,
    pdf,
  });

  const todo = pages.filter((p) => (p.ocrAt || 0) < (p.updatedAt || 1));
  let doneCount = 0;
  for (let i = 0; i < todo.length; i += OCR_BATCH) {
    const batch = todo.slice(i, i + OCR_BATCH);
    onProgress(`손글씨 읽는 중… ${doneCount} / ${todo.length}쪽`);
    const payload = [];
    for (const p of batch) payload.push({ pageId: p.id, index: pages.indexOf(p), image: await pageImage(p) });
    const res = await call('ocr', { id: nb.id, pages: payload });
    const done = new Set(res.done || []);
    const now = Date.now();
    const changed = batch.filter((p) => done.has(p.id));
    changed.forEach((p) => { p.ocrAt = now; });
    if (changed.length) await db.putPages(changed);
    doneCount += changed.length;
    if (done.size < batch.length) break; // 서버 시간이 모자라면 다음 동기화 때 이어서 한다
  }

  // 올리는 동안 노트가 바뀌었을 수 있으니 최신 기록에 '올린 버전'만 적는다
  const cur = await db.getNotebook(nb.id);
  if (cur) {
    cur.syncedAt = version;
    await db.putNotebook(cur);
  }
  // 과제 답안이면 서버가 낱말·AI 검사를 한다 (기다리지 않는다)
  if (nb.taskId) call('check', { id: nb.id }).catch((e) => console.warn('검사 실패', e));
  return true;
}

function canvasJpeg(c, q) {
  return new Promise((r) => c.toBlob(r, 'image/jpeg', q));
}

// 선생님: 문제지를 과제로 내준다. 학생이 지우지 못하도록 페이지를 그림 한 장으로 굳혀서 보낸다.
export async function assignNotebook(nbId, { classes, due, keywords, rubric, criteria }, onProgress = () => {}) {
  const nb = await db.getNotebook(nbId);
  const pages = await loadPages(nb);
  const flat = [];
  for (const [i, p] of pages.entries()) {
    onProgress(`문제지 준비 중… ${i + 1} / ${pages.length}`);
    await ensurePageImages(p);
    // 동영상은 그림으로 굳히지 않고 그대로 둬서 학생도 재생할 수 있게 한다
    const videos = p.items.filter((it) => it.type === 'video');
    const c = renderPageCanvas({ ...p, items: p.items.filter((it) => it.type !== 'video') }, Math.min(2, 1600 / p.w));
    const bg = await canvasJpeg(c, 0.85);
    c.width = c.height = 0;
    flat.push({ ...p, bg, items: videos, template: 'blank' });
  }
  onProgress('반에 내주는 중…');
  const tnb = { ...nb, taskId: nb.id };
  delete tnb.taskInfo;
  const data = await (await exportBackup(tnb, flat)).text();
  await call('assign', { meta: { id: nb.id, title: nb.title, classes, due, keywords, rubric, criteria }, data });
  const cur = await db.getNotebook(nbId);
  cur.taskInfo = { ...(cur.taskInfo || {}), classes, due, keywords, rubric, criteria, assignedAt: Date.now() };
  await db.putNotebook(cur);
}

// 학생: 과제를 받아 내 노트로 만든다 (이미 있으면 그 노트)
export async function startTask(task) {
  const local = (await db.getAllNotebooks()).find((n) => n.taskId === task.id && !n.returnOf);
  if (local) return local;
  const res = await call('getTask', { id: task.id });
  const { nb, pages } = await importBackup(res.data);
  nb.taskId = task.id;
  nb.title = res.title || task.title;
  nb.createdAt = nb.updatedAt = Date.now();
  nb.syncedAt = 0;
  nb.fresh = true;
  delete nb.taskInfo;
  delete nb.worksheet;
  await db.putNotebookWithPages(nb, pages);
  return nb;
}

// 학생: 선생님이 첨삭한 노트를 받는다 (이미 받은 것은 새것으로 바꾼다)
export async function openReturn(item) {
  const res = await call('getReturn', { id: item.noteId });
  const { nb, pages } = await importBackup(res.data);
  const old = (await db.getAllNotebooks()).find((n) => n.returnOf === item.noteId);
  if (old) await db.deleteNotebook(old.id);
  nb.title = `✏ 첨삭: ${item.title}`;
  nb.returnOf = item.noteId;
  nb.cloud = false;
  delete nb.remoteId;
  delete nb.remoteName;
  delete nb.taskId;
  nb.createdAt = nb.updatedAt = Date.now();
  await db.putNotebookWithPages(nb, pages);
  return nb;
}

// 서버의 노트를 기기로 가져온다. asCopy이면 학생 노트를 보기용 사본으로 저장한다.
export async function downloadNotebook(remote, { asCopy = false } = {}) {
  const res = await call('download', { id: remote.id });
  const { nb, pages } = await importBackup(res.data, { keepIds: !asCopy });
  if (asCopy) {
    const existing = (await db.getAllNotebooks()).find((n) => n.remoteId === remote.id);
    const localId = existing ? existing.id : nb.id;
    if (existing) await db.deleteNotebook(existing.id);
    nb.id = localId;
    pages.forEach((p) => { p.notebookId = localId; });
    nb.remoteId = remote.id;
    nb.remoteName = res.name || remote.name;
    nb.remoteUpdatedAt = res.updatedAt;
    nb.title = remote.title;
    nb.cloud = false;
    delete nb.syncedAt;
    nb.updatedAt = Date.now();
  } else {
    const old = await db.getNotebook(nb.id);
    if (old) await db.deleteNotebook(nb.id);
    nb.updatedAt = res.updatedAt || nb.updatedAt;
    nb.syncedAt = nb.updatedAt;
    nb.cloud = true;
    if (old) { nb.thumb = nb.thumb || old.thumb; nb.lastPage = old.lastPage; }
  }
  // 이미 글자를 읽은 페이지는 다시 읽지 않는다
  if (!asCopy) pages.forEach((p) => { p.ocrAt = Math.max(p.ocrAt || 0, p.updatedAt || 0); });
  await db.putNotebookWithPages(nb, pages);
  return nb;
}

// 전체 동기화: 다른 기기에서 바뀐 내 노트를 받고, 이 기기에서 바뀐 노트를 올린다
export async function syncAll(onProgress = () => {}) {
  const cfg = getCloud();
  if (!cfg) throw new Error('클라우드에 연결되어 있지 않습니다.');
  onProgress('목록 확인 중…');
  const remote = await listRemote();
  const deleted = deletedIds();
  let local = await db.getAllNotebooks();
  const byId = new Map(local.map((n) => [n.id, n]));
  let pulled = 0, pushed = 0;
  for (const r of remote) {
    if (!r.mine || deleted.has(r.id)) continue;
    const l = byId.get(r.id);
    if (!l) {
      onProgress(`“${r.title}” 받는 중…`);
      await downloadNotebook(r);
      pulled++;
    } else if (r.updatedAt > (l.syncedAt || 0)) {
      if ((l.syncedAt || 0) >= l.updatedAt) {
        onProgress(`“${r.title}” 받는 중…`);
        await downloadNotebook(r);
        pulled++;
      } else {
        // 양쪽에서 모두 고쳤으면 서버 쪽을 사본으로 남기고 이 기기 것을 올린다
        onProgress(`“${r.title}” 다른 기기 버전 받는 중…`);
        const copy = await downloadNotebook(r, { asCopy: true });
        copy.title = `${r.title} (다른 기기에서 고친 것)`;
        delete copy.remoteId;
        delete copy.cloud;
        await db.putNotebook(copy);
        pulled++;
      }
    }
  }
  local = await db.getAllNotebooks();
  for (const nb of local) {
    if (!needsSync(nb, cfg)) continue;
    if (await uploadNotebook(nb.id, (m) => onProgress(`“${nb.title}” ${m}`))) pushed++;
  }
  return { pulled, pushed };
}

// 아직 없는 학생 노트 사본은 새로 받고, 있으면 서버가 더 새것일 때만 다시 받는다
export async function openRemote(remote) {
  const local = await db.getAllNotebooks();
  const own = local.find((n) => n.id === remote.id);
  if (own) return own;
  const copy = local.find((n) => n.remoteId === remote.id);
  if (copy && (copy.remoteUpdatedAt || 0) >= remote.updatedAt) return copy;
  return downloadNotebook(remote, { asCopy: !remote.mine });
}

export function inviteLink(cfg, code, appUrl = location.href.split('#')[0]) {
  const p = new URLSearchParams({ u: cfg.url, c: code });
  return `${appUrl}#/join?${p}`;
}

export function deviceLink(cfg, appUrl = location.href.split('#')[0]) {
  const p = new URLSearchParams({ u: cfg.url, c: cfg.classCode, n: cfg.name, t: cfg.token });
  return `${appUrl}#/join?${p}`;
}

