// 클라우드 연결 화면, 클라우드 노트 목록, 손글씨 검색 결과
import * as db from './db.js';
import { icons } from './icons.js';
import {
  getCloud, setCloud, newToken, ping, listRemote, searchRemote, removeRemote, syncAll, openRemote,
  inviteLink, deviceLink,
} from './cloud.js';
import { h, toast, progress, dialog, confirmDialog, formatDate } from './util.js';

const GUIDE_URL = 'setup.html';

function field(label, input, hint) {
  return h('div', { class: 'field' }, h('label', { class: 'field-label' }, label), input, hint ? h('div', { class: 'field-hint' }, hint) : null);
}

// 연결 대화 상자. prefill: { mode, url, classCode, name, token }
export async function connectDialog(prefill = {}) {
  let mode = prefill.mode || (prefill.classCode ? 'student' : 'owner');
  const url = h('input', { class: 'input', type: 'url', placeholder: 'https://script.google.com/macros/s/…/exec', value: prefill.url || '' });
  const key = h('input', { class: 'input', type: 'password', placeholder: 'Code.gs에 적은 OWNER_KEY', value: '' });
  const code = h('input', { class: 'input', type: 'text', placeholder: '선생님이 알려 준 수업 코드', value: prefill.classCode || '' });
  const name = h('input', { class: 'input', type: 'text', placeholder: '예: 10213 김하늘', value: prefill.name || '' });
  const body = h('div', { class: 'form' });
  const draw = () => {
    body.innerHTML = '';
    body.append(
      h('div', { class: 'seg seg-wide' },
        h('button', { class: `seg-btn ${mode === 'owner' ? 'active' : ''}`, onclick: () => { mode = 'owner'; draw(); } }, '내 저장소 (관리자)'),
        h('button', { class: `seg-btn ${mode === 'student' ? 'active' : ''}`, onclick: () => { mode = 'student'; draw(); } }, '수업 참여 (학생)')),
      h('p', { class: 'muted small' }, mode === 'owner'
        ? '내 구글 시트·드라이브에 노트를 저장합니다. 여러 기기에서 같은 노트를 쓰고, 손글씨를 검색할 수 있습니다. 수업 코드를 정했다면 학생들이 제출한 노트도 여기서 봅니다.'
        : '선생님의 저장소에 내 노트를 제출합니다. 내 노트는 나와 선생님만 볼 수 있습니다.'),
      field('웹 앱 주소', url, mode === 'owner' ? h('a', { href: GUIDE_URL, target: '_blank', rel: 'noopener' }, '주소를 만드는 방법 보기') : null),
      mode === 'owner' ? field('관리자 비밀번호', key) : field('수업 코드', code),
      mode === 'student' ? field('이름 (학번과 함께 쓰면 좋아요)', name) : null);
  };
  draw();
  for (;;) {
    const ok = await dialog({
      title: '클라우드 연결',
      body,
      buttons: [{ label: '취소', value: false }, { label: '연결', value: true, primary: true }],
    });
    if (!ok) return null;
    const cfg = mode === 'owner'
      ? { mode, url: url.value.trim(), key: key.value }
      : { mode, url: url.value.trim(), classCode: code.value.trim(), name: name.value.trim(), token: prefill.token || newToken() };
    if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(cfg.url)) { toast('웹 앱 주소는 https://script.google.com/ 으로 시작해야 합니다', 3500); continue; }
    if (mode === 'student' && !cfg.name) { toast('이름을 입력하세요'); continue; }
    try {
      progress('연결 확인 중…');
      const info = await ping(cfg);
      progress(null);
      cfg.className = info.className || '';
      if (mode === 'owner') cfg.classes = info.classes || [];
      setCloud(cfg);
      toast(mode === 'owner' ? '내 저장소에 연결했습니다' : `${cfg.className || '수업'}에 참여했습니다`);
      return cfg;
    } catch (e) {
      progress(null);
      toast(e.message, 4500);
    }
  }
}

export async function runSync(lib) {
  try {
    progress('동기화 중…');
    const { pulled, pushed } = await syncAll((m) => progress(m));
    progress(null);
    toast(pulled || pushed ? `받은 노트 ${pulled}개, 올린 노트 ${pushed}개` : '모두 최신입니다');
  } catch (e) {
    console.error(e);
    progress(null);
    toast('동기화하지 못했습니다: ' + e.message, 4500);
  }
  await lib?.load();
}

async function openRemoteNote(app, remote, pageId) {
  try {
    progress('노트 받는 중…');
    const nb = await openRemote(remote);
    progress(null);
    if (pageId) {
      const fresh = await db.getNotebook(nb.id);
      fresh.lastPage = pageId;
      await db.putNotebook(fresh);
    }
    app.openNotebook(nb.id);
  } catch (e) {
    progress(null);
    toast(e.message, 4000);
  }
}

// 클라우드 창: 연결 상태, 동기화, (관리자) 학생 노트 목록
export async function cloudPanel(app, lib) {
  const cfg = getCloud();
  if (!cfg) {
    if (await connectDialog()) await runSync(lib);
    return;
  }
  if (cfg.mode === 'owner') {
    // Code.gs에 반을 더했을 수 있으니 반 목록을 새로 받는다
    try { cfg.classes = (await ping(cfg)).classes || []; setCloud(cfg); } catch { /* 목록에서 오류를 보여 준다 */ }
  }
  const list = h('div', { class: 'remote-list' }, h('div', { class: 'muted' }, '목록을 불러오는 중…'));
  const filter = h('select', { class: 'input class-filter hidden', 'aria-label': '반 고르기' });
  const copyBtn = (label, text) => h('button', {
    class: 'btn', onclick: async () => {
      try { await navigator.clipboard.writeText(text); toast('링크를 복사했습니다'); } catch { await dialog({ title: label, body: h('textarea', { class: 'input link-box', readonly: true }, text) }); }
    },
  }, label);
  let closeFn = null;
  const body = h('div', { class: 'form' },
    h('div', { class: 'cloud-status' },
      h('span', { class: 'status-dot' }),
      h('div', {},
        h('div', { class: 'strong' }, cfg.mode === 'owner' ? '내 저장소에 연결됨 (관리자)' : `${cfg.className || '수업'} · ${cfg.name}`),
        h('div', { class: 'muted small' }, cfg.mode === 'owner'
          ? '모든 노트가 자동으로 구글 드라이브에 저장되고, 손글씨를 검색할 수 있습니다.'
          : '내 노트가 선생님께 제출됩니다. 제출하지 않을 노트는 노트 메뉴에서 “선생님께 제출”을 끄세요.'))),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn primary', onclick: () => { closeFn?.(); runSync(lib); } }, '지금 동기화'),
      ...(cfg.mode === 'owner' ? (cfg.classes || []).map((c) => copyBtn(`${c.name} 초대 링크`, inviteLink(cfg, c.code))) : []),
      cfg.mode === 'student' ? copyBtn('다른 기기에서 이어 쓰기 링크', deviceLink(cfg)) : null,
      h('button', {
        class: 'btn', onclick: async () => {
          closeFn?.();
          const ok = await confirmDialog('연결 끊기', '이 기기의 노트는 그대로 남고, 클라우드와 주고받기만 멈춥니다.', '연결 끊기');
          if (ok) { setCloud(null); toast('연결을 끊었습니다'); lib?.load(); }
        },
      }, '연결 끊기')),
    h('label', { class: 'field-label' }, cfg.mode === 'owner' ? '클라우드에 있는 노트' : '내가 제출한 노트'),
    filter,
    list);
  const p = dialog({ title: '클라우드', body, buttons: [{ label: '닫기', value: null }] });
  closeFn = () => document.querySelector('.dialog-back')?.remove();
  try {
    const ko = (a, b) => String(a || '').localeCompare(String(b || ''), 'ko', { numeric: true });
    const all = (await listRemote()).sort((a, b) => (a.mine === b.mine ? 0 : a.mine ? -1 : 1)
      || ko(a.cls, b.cls) || ko(a.name, b.name) || b.updatedAt - a.updatedAt);
    const classes = [...new Set(all.filter((n) => !n.mine && n.cls).map((n) => n.cls))];
    if (cfg.mode === 'owner' && classes.length > 1) {
      filter.classList.remove('hidden');
      filter.append(h('option', { value: '' }, '모든 반'), ...classes.map((c) => h('option', { value: c }, c)));
      filter.addEventListener('change', () => renderList());
    }
    const renderList = () => {
      const notes = filter.value ? all.filter((n) => n.cls === filter.value) : all;
      list.innerHTML = '';
      if (!notes.length) list.append(h('div', { class: 'muted' }, '아직 올라간 노트가 없습니다.'));
      let lastGroup = null;
      for (const n of notes) {
        const group = n.mine ? '내 노트' : [n.cls, n.name].filter(Boolean).join(' · ');
        if (cfg.mode === 'owner' && group !== lastGroup) {
          list.append(h('div', { class: 'remote-group' }, group));
          lastGroup = group;
        }
        list.append(h('div', { class: 'remote-row' },
          h('div', { class: 'remote-text' },
            h('div', { class: 'strong ellipsis' }, n.title),
            h('div', { class: 'muted small' }, `${formatDate(n.updatedAt)} · ${n.pages}쪽`)),
          h('button', { class: 'btn small', onclick: () => { closeFn(); openRemoteNote(app, n); } }, '열기'),
          n.pdf ? h('a', { class: 'btn small', href: n.pdf, target: '_blank', rel: 'noopener' }, 'PDF') : null,
          cfg.mode === 'owner' || n.mine ? h('button', {
            class: 'mini-btn', 'aria-label': '클라우드에서 삭제', html: icons.trash, onclick: async (e) => {
              const row = e.currentTarget.closest('.remote-row');
              if (!window.confirm(`클라우드에서 “${n.title}” 노트를 지울까요? 드라이브의 파일도 휴지통으로 갑니다.`)) return;
              try { await removeRemote(n.id); row.remove(); toast('클라우드에서 지웠습니다'); } catch (err) { toast(err.message, 4000); }
            },
          }) : null));
      }
    };
    renderList();
  } catch (e) {
    list.innerHTML = '';
    list.append(h('div', { class: 'error-text' }, e.message));
  }
  await p;
}

// 손글씨 검색 결과를 container에 그린다
export async function searchHandwriting(app, q, container) {
  container.innerHTML = '';
  container.classList.remove('hidden');
  container.append(h('div', { class: 'muted' }, `“${q}” 손글씨에서 찾는 중…`));
  let results;
  try {
    results = await searchRemote(q);
  } catch (e) {
    container.innerHTML = '';
    container.append(h('div', { class: 'error-text' }, e.message));
    return;
  }
  const cfg = getCloud();
  container.innerHTML = '';
  container.append(h('div', { class: 'search-head' },
    h('span', { class: 'strong' }, `손글씨 검색 결과 ${results.length}개`),
    h('button', { class: 'mini-btn', 'aria-label': '검색 결과 닫기', html: icons.close, onclick: () => container.classList.add('hidden') })));
  if (!results.length) {
    container.append(h('div', { class: 'muted small' }, '찾지 못했습니다. 방금 쓴 노트는 동기화한 뒤에 검색됩니다.'));
    return;
  }
  const terms = q.split(/\s+/).filter(Boolean);
  for (const r of results) {
    const who = cfg?.mode === 'owner' && !r.mine ? `${[r.cls, r.name].filter(Boolean).join(' ')} · ` : '';
    container.append(h('button', {
      class: 'result-row',
      onclick: () => openRemoteNote(app, { id: r.id, title: r.title, name: r.name, mine: r.mine, updatedAt: 0 }, r.pageId),
    },
    h('div', { class: 'strong ellipsis' }, `${who}${r.title}${r.page ? ` · ${r.page}쪽` : ''}`),
    r.snippet ? h('div', { class: 'snippet', html: highlight(r.snippet, terms) }) : null));
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function highlight(text, terms) {
  let html = escapeHtml(text);
  for (const t of terms) {
    const re = new RegExp(escapeHtml(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    html = html.replace(re, (m) => `<mark>${m}</mark>`);
  }
  return html;
}
