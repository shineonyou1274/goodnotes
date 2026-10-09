// 과제: 문제지 만들기, 반에 내주기, 학생의 받은 과제·피드백, 선생님의 피드백 돌려주기
import * as db from './db.js';
import { newNotebook, newPage, uid, COVER_COLORS, PAGE_SIZES } from './model.js';
import { measureTextHeight } from './render.js';
import { exportBackup } from './backup.js';
import {
  getCloud, ping, setCloud, listTasks, startTask, openReturn, assignNotebook, noteInfo, giveBack, aiQuestions,
} from './cloud.js';
import { h, toast, progress, dialog } from './util.js';

const INK = '#1c1c1e';
const LINE = '#b8c4d6';
const SEEN_KEY = 'goodnotes-web:feedback-seen';

function field(label, input, hint) {
  return h('div', { class: 'field' }, h('label', { class: 'field-label' }, label), input, hint ? h('div', { class: 'field-hint muted' }, hint) : null);
}

function seg(options, value, onChange) {
  const el = h('div', { class: 'seg seg-wide' });
  const draw = () => {
    el.innerHTML = '';
    for (const [v, label] of options) {
      el.append(h('button', { class: `seg-btn ${v === value ? 'active' : ''}`, onclick: () => { value = v; onChange(v); draw(); } }, label));
    }
  };
  draw();
  return el;
}

/* ---------- 문제지 만들기 ---------- */
const line = (x1, y1, x2, y2, color = LINE, width = 1.2) => ({
  type: 'stroke', id: uid(), tool: 'pen', color, width, constant: true, pts: new Float32Array([x1, y1, 0.5, x2, y2, 0.5]),
});
const box = (x, y, w, hh) => ({
  type: 'stroke', id: uid(), tool: 'pen', color: '#9aa6b8', width: 1.4, constant: true, closed: true,
  pts: new Float32Array([x, y, 0.5, x + w, y, 0.5, x + w, y + hh, 0.5, x, y + hh, 0.5]),
});
const text = (x, y, w, size, str, bold = false) => ({ type: 'text', id: uid(), x, y, w, size, color: INK, text: str, bold });

// 문제 목록으로 페이지들을 만든다
export function buildWorksheet({ title, questions, style = 'lines', length = 'mid', nameField = true, size = 'a4-portrait' }) {
  const nb = newNotebook({ title, cover: COVER_COLORS[2], size, template: 'blank', paper: 'white' });
  nb.worksheet = true;
  const { w: W, h: H } = PAGE_SIZES[size] || PAGE_SIZES['a4-portrait'];
  const M = 60;
  const ctx = document.createElement('canvas').getContext('2d');
  const pages = [];
  let page, y;
  const newSheet = () => {
    page = newPage(nb.id, { size, template: 'blank', paper: 'white' });
    pages.push(page);
    y = 60;
  };
  newSheet();
  // 머리: 제목, 이름 칸
  const nameW = nameField ? 230 : 0;
  const head = text(M, 46, W - 2 * M - nameW, 28, title, true);
  page.items.push(head);
  if (nameField) {
    page.items.push(text(W - M - 210, 62, 60, 18, '이름'));
    page.items.push(line(W - M - 160, 88, W - M, 88, '#6e6e73', 1.2));
  }
  const headBottom = Math.max(110, 46 + measureTextHeight(ctx, head) + 14);
  page.items.push(line(M, headBottom, W - M, headBottom, INK, 1.6));
  y = headBottom + 28;

  const nLines = { short: 2, mid: 4, long: 7 }[length] || 4;
  const boxH = { short: 80, mid: 150, long: 270 }[length] || 150;
  const gap = 38;
  questions.forEach((q, i) => {
    const qt = text(M, y, W - 2 * M, 19, `${i + 1}. ${q}`);
    const th = measureTextHeight(ctx, qt);
    const area = style === 'box' ? boxH : gap * nLines + 10;
    if (y + th + 10 + area > H - 50 && page.items.length > 0 && y > 100) {
      newSheet();
      qt.y = y;
    }
    page.items.push(qt);
    const ya = qt.y + th + 10;
    if (style === 'box') page.items.push(box(M, ya, W - 2 * M, boxH));
    else for (let k = 1; k <= nLines; k++) page.items.push(line(M + 14, ya + gap * k, W - M, ya + gap * k));
    y = ya + area + 30;
  });
  nb.pageIds = pages.map((p) => p.id);
  return { nb, pages };
}

export async function worksheetDialog(app) {
  const cfg = getCloud();
  const owner = cfg?.mode === 'owner';
  let style = 'lines', length = 'mid';
  let extra = { answers: [], keywords: [] };
  const title = h('input', { class: 'input', type: 'text', placeholder: '예: 3단원 확인 문제' });
  const qs = h('textarea', { class: 'input qs-box', placeholder: '한 줄에 문제 하나씩\n예: 광합성에 필요한 세 가지를 쓰시오.\n예: 잎이 초록색인 까닭을 설명하시오.' });
  const nameChk = h('input', { type: 'checkbox', checked: true });
  const aiBtn = owner ? h('button', {
    class: 'btn small', onclick: async () => {
      const got = await aiQuestionDialog(title.value.trim());
      if (!got) return;
      qs.value = got.questions.join('\n');
      if (!title.value.trim()) title.value = got.topic;
      extra = got;
      toast('AI가 만든 문제입니다. 고쳐서 쓰세요.', 3000);
    },
  }, '✨ AI로 문제 만들기') : null;
  const body = h('div', { class: 'form' },
    field('제목', title),
    h('div', { class: 'field' },
      h('div', { class: 'label-row' }, h('label', { class: 'field-label' }, '문제'), aiBtn),
      qs),
    field('답 쓰는 곳', h('div', { class: 'two-col' },
      seg([['lines', '줄'], ['box', '네모 칸']], style, (v) => { style = v; }),
      seg([['short', '짧게'], ['mid', '보통'], ['long', '길게']], length, (v) => { length = v; }))),
    h('label', { class: 'check-row' }, nameChk, ' 위에 이름 칸 넣기'),
    h('p', { class: 'muted small' }, '만든 뒤에 펜·글상자·사진으로 자유롭게 고칠 수 있습니다. PDF 활동지는 “가져오기”로 불러오세요.'));
  for (;;) {
    const ok = await dialog({ title: '문제지 만들기', body, buttons: [{ label: '취소', value: false }, { label: '만들기', value: true, primary: true }] });
    if (!ok) return;
    const questions = qs.value.split('\n').map((s) => s.trim()).filter(Boolean);
    if (!questions.length) { toast('문제를 한 줄 이상 쓰세요'); continue; }
    const { nb, pages } = buildWorksheet({ title: title.value.trim() || '문제지', questions, style, length, nameField: nameChk.checked });
    if (extra.answers.length || extra.keywords.length) {
      nb.taskInfo = {
        rubric: extra.answers.map((a, i) => `${i + 1}. ${a}`).join('\n'),
        keywords: extra.keywords.join(', '),
      };
    }
    await db.putNotebookWithPages(nb, pages);
    app.openNotebook(nb.id);
    return;
  }
}

async function aiQuestionDialog(topicGuess) {
  const topic = h('input', { class: 'input', type: 'text', placeholder: '예: 식물의 광합성', value: topicGuess || '' });
  const level = h('input', { class: 'input', type: 'text', placeholder: '예: 초등 5학년, 중1' });
  const count = h('select', { class: 'input' }, [3, 5, 8, 10].map((n) => h('option', { value: n, selected: n === 5 }, `${n}문항`)));
  const kind = h('select', { class: 'input' }, ['서술형과 단답형 섞어서', '단답형', '서술형', '빈칸 채우기'].map((k) => h('option', { value: k }, k)));
  for (;;) {
    const ok = await dialog({
      title: 'AI로 문제 만들기',
      body: h('div', { class: 'form' }, field('주제·단원', topic), h('div', { class: 'two-col' }, field('학년', level), field('문항 수', count)), field('유형', kind),
        h('p', { class: 'muted small' }, "시트 'AI 설정' 탭에 AI 키가 있어야 합니다. 모범 답안과 핵심 낱말도 함께 만들어 과제 검사에 씁니다.")),
      buttons: [{ label: '취소', value: false }, { label: '만들기', value: true, primary: true }],
    });
    if (!ok) return null;
    if (!topic.value.trim()) { toast('주제를 쓰세요'); continue; }
    try {
      progress('AI가 문제를 만드는 중… (10~30초)');
      const res = await aiQuestions({ topic: topic.value.trim(), level: level.value.trim(), count: Number(count.value), kind: kind.value });
      progress(null);
      if (!res.questions.length) throw new Error('AI가 문제를 만들지 못했습니다. 다시 눌러 주세요.');
      return { ...res, topic: topic.value.trim() };
    } catch (e) {
      progress(null);
      toast(e.message, 6000);
    }
  }
}

/* ---------- 과제로 내주기 (선생님) ---------- */
export async function assignDialog(nbId) {
  const cfg = getCloud();
  if (cfg?.mode !== 'owner') { toast('구름 버튼에서 “내 저장소”로 연결해야 과제를 내줄 수 있습니다', 3500); return false; }
  try { cfg.classes = (await ping(cfg)).classes || []; setCloud(cfg); } catch { /* 저장해 둔 목록을 쓴다 */ }
  const classes = cfg.classes || [];
  if (!classes.length) { toast("시트 '설정' 탭에 반 이름을 먼저 적으세요", 3500); return false; }
  const nb = await db.getNotebook(nbId);
  const info = nb.taskInfo || {};
  const picked = new Set(info.classes?.length ? info.classes : classes.map((c) => c.name));
  const checks = h('div', { class: 'check-list' }, classes.map((c) => h('label', { class: 'check-row' },
    h('input', { type: 'checkbox', checked: picked.has(c.name), onchange: (e) => (e.target.checked ? picked.add(c.name) : picked.delete(c.name)) }), ' ', c.name)));
  const due = h('input', { class: 'input', type: 'date', value: info.due || '' });
  const keys = h('input', { class: 'input', type: 'text', placeholder: '예: 빛, 물, 이산화 탄소', value: info.keywords || '' });
  const rubric = h('textarea', { class: 'input rubric-box', placeholder: '예: 1. 빛, 물, 이산화 탄소\n2. 엽록소 때문', value: '' });
  rubric.value = info.rubric || '';
  for (;;) {
    const ok = await dialog({
      title: `“${nb.title}” 과제로 내주기`,
      body: h('div', { class: 'form' },
        field('반', checks),
        field('마감 (안 써도 됨)', due),
        field('핵심 낱말 (자동 검사용, 안 써도 됨)', keys, '학생 손글씨에 이 낱말이 있는지 시트에 표시합니다.'),
        field('모범 답안·채점 기준 (AI 검사용, 안 써도 됨)', rubric, "시트 'AI 설정' 탭에 AI 키를 넣으면 AI가 피드백 초안을 씁니다.")),
      buttons: [{ label: '취소', value: false }, { label: info.assignedAt ? '다시 내주기' : '내주기', value: true, primary: true }],
    });
    if (!ok) return false;
    if (!picked.size) { toast('반을 하나 이상 고르세요'); continue; }
    try {
      await assignNotebook(nbId, {
        classes: classes.map((c) => c.name).filter((n) => picked.has(n)),
        due: due.value, keywords: keys.value.trim(), rubric: rubric.value.trim(),
      }, (m) => progress(m));
      progress(null);
      await dialog({
        title: '과제를 내줬어요',
        body: h('ol', { class: 'guide-list' },
          h('li', {}, '학생 앱 맨 위 ', h('b', {}, '받은 과제'), '에 나타납니다.'),
          h('li', {}, '제출 현황은 시트 ', h('b', {}, '과제'), ' 탭, 답안은 ', h('b', {}, '노트'), ' 탭에서 봅니다.'),
          h('li', {}, '피드백은 노트 탭 ', h('b', {}, '선생님 피드백'), ' 칸에 쓰거나, 앱에서 학생 노트를 열어 ', h('b', {}, '돌려주기'), '를 누르세요.')),
      });
      return true;
    } catch (e) {
      progress(null);
      toast('내주지 못했습니다: ' + e.message, 5000);
    }
  }
}

/* ---------- 돌려주기 (선생님) ---------- */
// remote: { id, title, name }. copy: 선생님이 펜으로 첨삭한 사본 노트(있으면)
export async function giveBackDialog(remote, copy = null) {
  let info;
  try {
    progress('피드백 불러오는 중…');
    info = await noteInfo(remote.id);
  } catch (e) {
    progress(null);
    toast(e.message, 4000);
    return;
  } finally { progress(null); }
  const fb = h('textarea', { class: 'input feedback-box', placeholder: '학생에게 보낼 피드백' });
  fb.value = info.feedback || info.ai.replace(/^AI 실패:.*$/s, '') || '';
  const withNote = h('input', { type: 'checkbox', checked: !!copy });
  const body = h('div', { class: 'form' },
    info.check ? h('div', { class: 'check-line' }, h('b', {}, '낱말 확인 '), info.check) : null,
    info.ai && !info.feedback ? h('div', { class: 'muted small' }, 'AI가 쓴 초안입니다. 고쳐서 보내세요.') : null,
    info.ai.startsWith('AI 실패') ? h('div', { class: 'error-text' }, info.ai) : null,
    fb,
    copy ? h('label', { class: 'check-row' }, withNote, ' 펜으로 쓴 첨삭도 함께 보내기') : null);
  const ok = await dialog({
    title: `${remote.name || '학생'} · ${remote.title}`,
    body,
    buttons: [{ label: '취소', value: false }, { label: '돌려주기', value: true, primary: true }],
  });
  if (!ok) return;
  try {
    progress('돌려주는 중…');
    let data;
    if (copy && withNote.checked) {
      const pages = (await db.getPages(copy.id));
      const byId = new Map(pages.map((p) => [p.id, p]));
      const fresh = await db.getNotebook(copy.id);
      data = await (await exportBackup(fresh, fresh.pageIds.map((id) => byId.get(id)).filter(Boolean))).text();
    }
    await giveBack(remote.id, fb.value.trim(), data);
    progress(null);
    toast('학생에게 돌려줬습니다 ✓');
  } catch (e) {
    progress(null);
    toast('돌려주지 못했습니다: ' + e.message, 5000);
  }
}

/* ---------- 받은 과제·피드백 (학생) ---------- */
function seenMap() {
  try { return JSON.parse(localStorage.getItem(SEEN_KEY) || '{}'); } catch { return {}; }
}
const fbKey = (m) => `${m.feedback}|${m.returned}`;
function markSeen(m) {
  const s = seenMap();
  s[m.noteId] = fbKey(m);
  localStorage.setItem(SEEN_KEY, JSON.stringify(s));
}

// 서재 맨 위에 받은 과제와 피드백을 그린다
export async function renderStudentTasks(lib, container) {
  let res;
  try { res = await listTasks(); } catch { container.classList.add('hidden'); return; }
  const local = await db.getAllNotebooks();
  const seen = seenMap();
  const mine = res.mine || [];
  const items = [];
  for (const t of res.tasks || []) {
    const sub = mine.find((m) => m.taskId === t.id && (m.feedback || m.returned)) || mine.find((m) => m.taskId === t.id);
    const nb = local.find((n) => n.taskId === t.id && !n.returnOf);
    items.push({ task: t, sub, nb });
  }
  // 과제가 아닌 노트에 온 피드백
  for (const m of mine) if ((m.feedback || m.returned) && !items.some((i) => i.sub === m)) items.push({ task: null, sub: m, nb: null });
  container.innerHTML = '';
  if (!items.length) { container.classList.add('hidden'); return; }
  container.classList.remove('hidden');
  let fresh = 0;
  const row = h('div', { class: 'task-row' });
  for (const it of items) {
    const { task, sub, nb } = it;
    const hasFb = sub && (sub.feedback || sub.returned);
    const isNew = hasFb && seen[sub.noteId] !== fbKey(sub);
    if (isNew) fresh++;
    let status, cls;
    if (hasFb) { status = isNew ? '새 피드백 ✉' : '피드백 보기'; cls = 'fb'; }
    else if (!nb) { status = sub ? '제출됨 ✓' : '풀기'; cls = sub ? 'done' : 'todo'; }
    else if (nb.fresh) { status = '풀기'; cls = 'todo'; }
    else if ((nb.syncedAt || 0) >= nb.updatedAt) { status = '제출됨 ✓'; cls = 'done'; }
    else { status = '제출 안 함'; cls = 'wait'; }
    row.append(h('button', {
      class: `task-card ${cls} ${isNew ? 'new' : ''}`,
      onclick: () => (hasFb ? feedbackDialog(lib, it) : openTask(lib, task)),
    },
    h('div', { class: 'task-title ellipsis' }, task?.title || sub.title),
    h('div', { class: 'task-meta' }, h('span', { class: 'task-status' }, status), task?.due ? h('span', { class: 'muted' }, `마감 ${task.due.slice(5).replace('-', '/')}`) : null)));
  }
  container.append(h('div', { class: 'task-head' }, '받은 과제'), row);
  if (fresh && !lib.toldFeedback) { lib.toldFeedback = true; toast(`선생님 피드백이 ${fresh}개 왔어요 ✉`, 3500); }
}

async function openTask(lib, task) {
  try {
    progress('과제 받는 중…');
    const nb = await startTask(task);
    progress(null);
    lib.app.openNotebook(nb.id);
  } catch (e) {
    progress(null);
    toast(e.message, 4000);
  }
}

async function feedbackDialog(lib, { task, sub }) {
  markSeen(sub);
  const local = (await db.getAllNotebooks()).find((n) => n.id === sub.noteId);
  const choice = await dialog({
    title: `선생님 피드백 · ${task?.title || sub.title}`,
    body: h('div', { class: 'feedback-text' }, sub.feedback || '선생님이 노트에 직접 첨삭해 주셨어요.'),
    buttons: [
      { label: '닫기', value: null },
      local ? { label: '내 답안 열기', value: 'mine', primary: !sub.returned } : null,
      sub.returned ? { label: '첨삭 노트 보기', value: 'ret', primary: true } : null,
    ].filter(Boolean),
  });
  if (choice === 'mine') lib.app.openNotebook(local.id);
  else if (choice === 'ret') {
    try {
      progress('첨삭 노트 받는 중…');
      const nb = await openReturn(sub);
      progress(null);
      lib.app.openNotebook(nb.id);
    } catch (e) {
      progress(null);
      toast(e.message, 4000);
    }
  } else lib.load();
}
