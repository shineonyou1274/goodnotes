// 앱 시작점: 화면 전환(노트 목록 ↔ 편집)과 서비스 워커 등록
import * as db from './db.js';
import { Library } from './library.js';
import { Editor } from './editor.js';
import { loadSettings } from './settings.js';
import { toast } from './util.js';
import { getCloud, needsSync, uploadNotebook } from './cloud.js';

const root = document.getElementById('app');

const app = {
  settings: loadSettings(),
  clipboard: [],
  screen: null,
  busy: Promise.resolve(),

  goLibrary() {
    if (location.hash && location.hash !== '#/') location.hash = '#/';
    else route();
  },

  openNotebook(id) {
    location.hash = `#/note/${id}`;
  },
};

async function closeScreen() {
  const s = app.screen;
  app.screen = null;
  if (!s) return;
  if (s instanceof Editor) {
    await s.close();
    backgroundSync(s.nb.id);
  } else s.destroy();
}

// 노트를 닫으면 바뀐 내용을 클라우드에 조용히 올린다
function backgroundSync(id) {
  if (!getCloud()) return;
  app.syncing = (app.syncing || Promise.resolve()).then(async () => {
    const nb = await db.getNotebook(id);
    if (!nb || !needsSync(nb)) return;
    try {
      await uploadNotebook(id);
      toast(`“${nb.title}” 클라우드에 저장했습니다`);
    } catch (e) {
      console.error(e);
      toast('클라우드에 올리지 못했습니다. 나중에 “동기화”를 눌러 주세요.', 3500);
    }
    if (app.screen instanceof Library) app.screen.load();
  });
}

async function show() {
  // 초대 링크: #/join?u=웹앱주소&c=수업코드(&n=이름&t=기기코드)
  const j = location.hash.match(/^#\/join\?(.*)$/);
  if (j) {
    const q = new URLSearchParams(j[1]);
    app.pendingJoin = {
      mode: q.get('c') ? 'student' : 'owner',
      url: q.get('u') || '', classCode: q.get('c') || '', name: q.get('n') || '', token: q.get('t') || undefined,
    };
    history.replaceState(null, '', location.pathname + location.search + '#/');
  }
  await closeScreen();
  const m = location.hash.match(/^#\/note\/([\w-]+)/);
  if (m) {
    const nb = await db.getNotebook(m[1]);
    if (!nb) { toast('노트를 찾을 수 없습니다'); location.replace('#/'); return; }
    const pages = await db.getPages(nb.id);
    const byId = new Map(pages.map((p) => [p.id, p]));
    let ordered = nb.pageIds.map((id) => byId.get(id)).filter(Boolean);
    // 순서 목록에 없는 페이지가 있으면 뒤에 붙인다
    for (const p of pages) if (!nb.pageIds.includes(p.id)) ordered.push(p);
    if (!ordered.length) { toast('빈 노트입니다'); location.replace('#/'); return; }
    document.title = `${nb.title} – 노트`;
    const ed = new Editor(app, nb, ordered);
    app.screen = ed;
    ed.mount(root);
  } else {
    document.title = '노트';
    const lib = new Library(app);
    app.screen = lib;
    await lib.mount(root);
  }
}

function route() {
  // 화면 전환이 겹치지 않도록 차례대로 처리한다
  app.busy = app.busy.then(show).catch((e) => {
    console.error(e);
    toast('문제가 생겼습니다: ' + (e.message || e));
  });
}

window.addEventListener('hashchange', route);
route();
db.requestPersistence();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

window.__app = app;
