// 클라우드 연결 화면, 클라우드 노트 목록, 손글씨 검색 결과
import * as db from './db.js';
import { icons } from './icons.js';
import {
  getCloud, setCloud, newToken, ping, listRemote, searchRemote, removeRemote, syncAll, openRemote,
  inviteLink, deviceLink,
} from './cloud.js';
import { h, toast, progress, dialog, confirmDialog, formatDate } from './util.js';
import { giveBackDialog } from './tasks.js';

const GUIDE_URL = 'setup.html';

function field(label, input, hint) {
  return h('div', { class: 'field' }, h('label', { class: 'field-label' }, label), input, hint ? h('div', { class: 'field-hint' }, hint) : null);
}

// 연결 대화 상자. prefill: { mode, url, classCode, name, token }
export async function connectDialog(prefill = {}) {
  let mode = prefill.mode || (prefill.classCode ? 'student' : 'owner');
  const url = h('input', { class: 'input', type: 'url', placeholder: 'https://script.google.com/macros/s/…/exec', value: prefill.url || '' });
  const key = h('input', { class: 'input', type: 'password', placeholder: '시트 “설정” 탭의 관리자 비밀번호', value: '' });
  const code = h('input', { class: 'input', type: 'text', placeholder: '선생님이 알려 준 수업 코드', value: prefill.classCode || '' });
  // 학번과 이름을 따로 받아 '10213 김하늘' 모양으로 맞춘다 (시트에서 학번 순으로 정리되게)
  const nm = String(prefill.name || '').trim().match(/^(\d+)\s+(.+)$/);
  const stNo = h('input', { class: 'input', type: 'text', inputmode: 'numeric', placeholder: '예: 10213', value: nm ? nm[1] : '' });
  const name = h('input', { class: 'input', type: 'text', placeholder: '예: 김하늘', value: nm ? nm[2] : prefill.name || '' });
  const body = h('div', { class: 'form' });
  const draw = () => {
    body.innerHTML = '';
    const parts = [
      h('div', { class: 'seg seg-wide' },
        h('button', { class: `seg-btn ${mode === 'owner' ? 'active' : ''}`, onclick: () => { mode = 'owner'; draw(); } }, '내 저장소 (관리자)'),
        h('button', { class: `seg-btn ${mode === 'student' ? 'active' : ''}`, onclick: () => { mode = 'student'; draw(); } }, '수업 참여 (학생)')),
      h('p', { class: 'muted small' }, mode === 'owner'
        ? '내 구글 시트·드라이브에 노트를 저장합니다. 여러 기기에서 같은 노트를 쓰고, 손글씨를 검색할 수 있습니다. 수업 코드를 정했다면 학생들이 제출한 노트도 여기서 봅니다.'
        : '선생님의 저장소에 내 노트를 제출합니다. 내 노트는 나와 선생님만 볼 수 있습니다.'),
      field('웹 앱 주소', url, h('span', {},
        h('a', { href: '#', onclick: (e) => { e.preventDefault(); if (url.value.trim()) window.open(url.value.trim(), '_blank', 'noopener'); } }, '이 주소가 맞는지 새 탭에서 확인'),
        mode === 'owner' ? ' · ' : null,
        mode === 'owner' ? h('a', { href: GUIDE_URL, target: '_blank', rel: 'noopener' }, '주소를 만드는 방법 보기') : null)),
      mode === 'owner' ? field('관리자 비밀번호', key) : field('수업 코드', code),
      mode === 'student' ? h('div', { class: 'two-col name-row' }, field('학번', stNo), field('이름', name)) : null];
    body.append(...parts.filter(Boolean));
  };
  draw();
  for (;;) {
    // 링크로 주소가 이미 들어와 있으면 비밀번호(또는 이름) 칸부터 쓰게 한다
    if (prefill.url) setTimeout(() => (mode === 'owner' ? key : stNo).focus(), 120);
    const ok = await dialog({
      title: '클라우드 연결',
      body,
      buttons: [{ label: '취소', value: false }, { label: '연결', value: true, primary: true }],
    });
    if (!ok) return null;
    const cfg = mode === 'owner'
      ? { mode, url: url.value.trim(), key: key.value }
      : {
        mode, url: url.value.trim(), classCode: code.value.trim(),
        name: `${stNo.value.replace(/\D/g, '')} ${name.value.trim().replace(/\s+/g, ' ')}`.trim(),
        token: prefill.token || newToken(),
      };
    if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(cfg.url)) { toast('웹 앱 주소는 https://script.google.com/ 으로 시작해야 합니다', 3500); continue; }
    if (mode === 'student' && !/^\d+$/.test(stNo.value.trim())) { toast('학번을 숫자로 쓰세요 (예: 10213)'); stNo.focus(); continue; }
    if (mode === 'student' && !name.value.trim()) { toast('이름을 쓰세요'); name.focus(); continue; }
    try {
      progress('연결 확인 중…');
      const info = await ping(cfg);
      progress(null);
      cfg.className = info.className || '';
      if (mode === 'owner') cfg.classes = info.classes || [];
      setCloud(cfg);
      if (mode === 'owner') toast('내 저장소에 연결했습니다');
      else await studentGuide(cfg);
      return cfg;
    } catch (e) {
      progress(null);
      toast(e.message, 9000);
    }
  }
}

// 학생이 처음 참여했을 때 보여 주는 짧은 안내
function studentGuide(cfg) {
  return dialog({
    title: `${cfg.className || '수업'}에 참여했어요`,
    body: h('ol', { class: 'guide-list' },
      h('li', {}, '맨 위 ', h('b', {}, '받은 과제'), '를 눌러 쓰세요. (과제가 없으면 ', h('b', {}, '+ 새 노트'), ')'),
      h('li', {}, '다 쓰면 위쪽의 ', h('b', {}, '제출하기'), '를 한 번 누르세요.'),
      h('li', {}, h('b', {}, '제출됨 ✓'), '이 보이면 끝! 고쳐 쓰면 다시 ', h('b', {}, '제출하기'), '가 됩니다.')),
    buttons: [{ label: '알겠어요', value: true, primary: true }],
  });
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
  const tools = h('div', { class: 'remote-tools' });
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
      // 반이 여럿이면 단추 하나로 모아 창에서 고른다
      ...(cfg.mode === 'owner' && (cfg.classes || []).length === 1 ? [copyBtn(`${cfg.classes[0].name} 초대 링크`, inviteLink(cfg, cfg.classes[0].code))] : []),
      cfg.mode === 'owner' && (cfg.classes || []).length > 1 ? h('button', {
        class: 'btn', onclick: () => dialog({
          title: '반 초대 링크',
          body: h('div', { class: 'invite-list' }, cfg.classes.map((c) => h('div', { class: 'remote-row' },
            h('div', { class: 'remote-text strong' }, c.name), copyBtn('복사', inviteLink(cfg, c.code))))),
          buttons: [{ label: '닫기', value: null }],
        }),
      }, `반 초대 링크 (${cfg.classes.length}개)`) : null,
      cfg.mode === 'student' ? copyBtn('다른 기기에서 이어 쓰기 링크', deviceLink(cfg)) : null,
      h('button', {
        class: 'btn', onclick: async () => {
          closeFn?.();
          const ok = await confirmDialog('연결 끊기', '이 기기의 노트는 그대로 남고, 클라우드와 주고받기만 멈춥니다.', '연결 끊기');
          if (ok) { setCloud(null); toast('연결을 끊었습니다'); lib?.load(); }
        },
      }, '연결 끊기')),
    h('label', { class: 'field-label' }, cfg.mode === 'owner' ? '클라우드에 있는 노트' : '내가 제출한 노트'),
    tools,
    list);
  const p = dialog({ title: '클라우드', body, buttons: [{ label: '닫기', value: null }] });
  closeFn = () => document.querySelector('.dialog-back')?.remove();
  try {
    const all = (await listRemote()).sort((a, b) => b.updatedAt - a.updatedAt);
    renderRemote(app, cfg, all, tools, list, () => closeFn());
  } catch (e) {
    list.innerHTML = '';
    list.append(h('div', { class: 'error-text' }, e.message));
  }
  await p;
}

const ko = (a, b) => String(a || '').localeCompare(String(b || ''), 'ko', { numeric: true });

function dayLabel(ts) {
  const d = new Date(ts), today = new Date();
  const days = Math.round((new Date(today.toDateString()) - new Date(d.toDateString())) / 86400000);
  if (days === 0) return '오늘';
  if (days === 1) return '어제';
  return d.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' });
}

// 클라우드 창의 노트 목록: (선생님) 학생 제출 / 내 노트 탭, 반·과제 고르기, 접었다 펴는 묶음
function renderRemote(app, cfg, all, tools, list, close) {
  const owner = cfg.mode === 'owner';
  const subs = all.filter((n) => !n.mine);
  const mine = all.filter((n) => n.mine);
  let tab = owner && subs.length ? 'subs' : 'mine';
  const clsSel = h('select', { class: 'input', 'aria-label': '반 고르기' });
  const taskSel = h('select', { class: 'input', 'aria-label': '과제 고르기' });
  const fill = (sel, label, values) => {
    sel.innerHTML = '';
    sel.append(h('option', { value: '' }, label), ...values.map((v) => h('option', { value: v }, v)));
    sel.onchange = draw;
  };
  fill(clsSel, '모든 반', [...new Set(subs.map((n) => n.cls).filter(Boolean))].sort(ko));
  fill(taskSel, '모든 과제', [...new Set(subs.map((n) => n.task || '과제 아님'))]);

  function row(n) {
    const who = owner && !n.mine ? `${n.name || ''} ` : '';
    const meta = [owner && !n.mine && !n.task ? n.title : '', formatDate(n.updatedAt), n.check ? `낱말 ${n.check}` : '',
      n.feedback || n.returned ? '피드백 ✓' : ''].filter(Boolean).join(' · ');
    return h('div', { class: 'remote-row' },
      h('button', { class: 'remote-text', onclick: () => { close(); openRemoteNote(app, n); } },
        h('div', { class: 'strong ellipsis' }, who ? who : n.title),
        h('div', { class: 'muted small ellipsis' }, meta)),
      owner && !n.mine ? h('button', { class: 'btn small', onclick: () => giveBackDialog(n) }, n.feedback || n.returned ? '피드백 ✓' : '피드백') : null,
      n.pdf ? h('a', { class: 'btn small', href: n.pdf, target: '_blank', rel: 'noopener' }, 'PDF') : null,
      owner || n.mine ? h('button', {
        class: 'mini-btn', 'aria-label': '클라우드에서 삭제', html: icons.trash, onclick: async (e) => {
          const r = e.currentTarget.closest('.remote-row');
          if (!window.confirm(`클라우드에서 “${n.title}” 노트를 지울까요? 드라이브의 파일도 휴지통으로 갑니다.`)) return;
          try { await removeRemote(n.id); r.remove(); toast('클라우드에서 지웠습니다'); } catch (err) { toast(err.message, 4000); }
        },
      }) : null);
  }

  // groups: [{ title, sub, items }] — 첫 묶음만 펼쳐 둔다
  function groups(gs) {
    list.innerHTML = '';
    if (!gs.length) { list.append(h('div', { class: 'muted' }, '아직 올라간 노트가 없습니다.')); return; }
    gs.forEach((g, i) => {
      const d = h('details', { class: 'remote-group-box' },
        h('summary', {}, h('span', { class: 'strong' }, g.title), h('span', { class: 'muted small' }, ` ${g.sub}`)),
        ...g.items.map(row));
      if (i === 0) d.open = true;
      list.append(d);
    });
  }

  function byDay(items) {
    const m = new Map();
    for (const n of items) { const k = dayLabel(n.updatedAt); if (!m.has(k)) m.set(k, []); m.get(k).push(n); }
    return [...m].map(([k, v]) => ({ title: k, sub: `${v.length}개`, items: v }));
  }

  function draw() {
    tools.innerHTML = '';
    if (owner) {
      tools.append(h('div', { class: 'seg seg-wide' },
        h('button', { class: `seg-btn ${tab === 'subs' ? 'active' : ''}`, onclick: () => { tab = 'subs'; draw(); } }, `학생 제출 ${subs.length}`),
        h('button', { class: `seg-btn ${tab === 'mine' ? 'active' : ''}`, onclick: () => { tab = 'mine'; draw(); } }, `내 노트 ${mine.length}`)));
      if (tab === 'subs' && subs.length) tools.append(h('div', { class: 'two-col filter-row' }, clsSel, taskSel));
    }
    if (tab === 'mine') { groups(byDay(owner ? mine : all)); return; }
    const items = subs.filter((n) => (!clsSel.value || n.cls === clsSel.value) && (!taskSel.value || (n.task || '과제 아님') === taskSel.value));
    // 과제별로 묶고, 최근에 제출이 들어온 과제를 위에. 과제 안에서는 반 → 이름 순
    const m = new Map();
    for (const n of items) { const k = n.task || '과제 아님'; if (!m.has(k)) m.set(k, []); m.get(k).push(n); }
    groups([...m].map(([k, v]) => ({
      title: k,
      sub: `${v.length}명 · ${dayLabel(Math.max(...v.map((n) => n.updatedAt)))}`,
      items: v.sort((a, b) => ko(a.cls, b.cls) || ko(a.name, b.name)),
      last: Math.max(...v.map((n) => n.updatedAt)),
    })).sort((a, b) => (a.title === '과제 아님') - (b.title === '과제 아님') || b.last - a.last));
  }
  draw();
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
