// 노트 목록(서재) 화면
import * as db from './db.js';
import { icons } from './icons.js';
import { newNotebook, newPage, uid, COVER_COLORS, TEMPLATES, PAPER_COLORS, PAGE_SIZES } from './model.js';
import { pdfToPages, exportPdf } from './pdf.js';
import { exportBackup, importBackup } from './backup.js';
import { templatePreview } from './editor.js';
import { getCloud, shouldSync, needsSync, removeRemote, rememberDeleted } from './cloud.js';
import { connectDialog, cloudPanel, runSync, searchHandwriting } from './cloud-ui.js';
import { worksheetDialog, assignDialog, renderStudentTasks } from './tasks.js';
import {
  h, toast, progress, dialog, confirmDialog, promptDialog, menu, pickFile, saveFile, safeFileName, formatDate,
} from './util.js';

export class Library {
  constructor(app) {
    this.app = app;
    this.query = '';
  }

  async mount(container) {
    this.el = h('div', { class: 'library' });
    this.search = h('input', { class: 'search', type: 'search', placeholder: '노트 찾기', 'aria-label': '노트 찾기', enterkeyhint: 'search' });
    this.search.addEventListener('input', () => { this.query = this.search.value.trim().toLowerCase(); this.renderGrid(); });
    // 클라우드에 연결돼 있으면 Enter로 손글씨까지 찾는다
    this.search.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const q = this.search.value.trim();
      if (!q) return;
      if (!getCloud()) { toast('손글씨 검색은 클라우드에 연결하면 쓸 수 있습니다 (오른쪽 위 구름 버튼)', 3500); return; }
      this.search.blur();
      searchHandwriting(this.app, q, this.results);
    });
    this.cloudBtn = h('button', { class: 'icon-btn cloud-btn', title: '클라우드', 'aria-label': '클라우드', html: icons.cloud, onclick: () => cloudPanel(this.app, this) });
    const header = h('header', { class: 'lib-header' },
      this.titleEl = h('h1', { class: 'ellipsis' }, '노트'),
      h('div', { class: 'spacer' }),
      h('label', { class: 'search-wrap' }, h('span', { html: icons.search }), this.search),
      this.cloudBtn,
      h('button', { class: 'btn', onclick: (e) => this.importMenu(e.currentTarget) }, h('span', { html: icons.upload }), h('span', { class: 'hide-sm' }, '가져오기')),
      h('button', { class: 'btn primary', onclick: () => this.createDialog() }, h('span', { html: icons.plus }), h('span', { class: 'hide-xs' }, '새 노트')));
    this.results = h('section', { class: 'search-results hidden' });
    this.tasksEl = h('section', { class: 'tasks hidden' });
    this.grid = h('main', { class: 'grid' });
    this.el.append(header, this.results, this.tasksEl, this.grid);
    container.append(this.el);
    await this.load();
    // 학생: 선생님이 새 과제를 내면 따로 누르지 않아도 뜨도록 가끔 다시 확인한다
    this._refreshTasks = () => {
      if (document.visibilityState === 'visible' && getCloud()?.mode === 'student') renderStudentTasks(this, this.tasksEl);
    };
    this._taskTimer = setInterval(this._refreshTasks, 60000);
    document.addEventListener('visibilitychange', this._refreshTasks);
    if (this.app.pendingJoin) {
      const j = this.app.pendingJoin;
      this.app.pendingJoin = null;
      if (await connectDialog(j)) {
        await this.load(); // 받은 과제를 바로 보여 준다
        await runSync(this);
      }
    }
  }

  destroy() {
    clearInterval(this._taskTimer);
    document.removeEventListener('visibilitychange', this._refreshTasks);
    this.el?.remove();
  }

  async load() {
    if (!this.el) return;
    this.notebooks = (await db.getAllNotebooks()).sort((a, b) => b.updatedAt - a.updatedAt);
    const cfg = getCloud();
    this.cloudBtn.classList.toggle('connected', !!cfg);
    // 학생은 위에 자기 이름을 보여 준다: "김하늘의 노트"
    const who = cfg?.mode === 'student' && cfg.name ? cfg.name.replace(/^\d+\s*/, '') || cfg.name : '';
    this.titleEl.textContent = who ? `${who}의 노트` : '노트';
    this.titleEl.title = cfg?.mode === 'student' ? [cfg.className, cfg.name].filter(Boolean).join(' · ') : '';
    document.title = who ? `${who}의 노트` : '노트';
    this.renderGrid();
    if (cfg?.mode === 'student') renderStudentTasks(this, this.tasksEl);
    else this.tasksEl.classList.add('hidden');
  }

  syncLabel(nb) {
    const cfg = getCloud();
    if (!cfg) return null;
    if (nb.remoteId) return h('span', { class: 'badge student' }, nb.remoteName || '학생');
    if (nb.returnOf) return h('span', { class: 'badge student' }, '첨삭');
    if (nb.fresh) return h('span', { class: 'badge wait' }, '새 과제');
    if (!shouldSync(nb, cfg)) return null;
    return needsSync(nb, cfg)
      ? h('span', { class: 'badge wait', title: '아직 올리지 않은 변경이 있습니다' }, '올릴 것 있음')
      : h('span', { class: 'badge ok', title: '클라우드에 저장됨' }, cfg.mode === 'student' ? '제출됨' : '저장됨');
  }

  renderGrid() {
    const g = this.grid;
    g.innerHTML = '';
    const list = this.notebooks.filter((n) => !this.query || n.title.toLowerCase().includes(this.query));
    g.append(h('button', { class: 'card new-card', onclick: () => this.createDialog() },
      h('div', { class: 'cover new-cover', html: icons.plus }), h('div', { class: 'card-title' }, '새 노트')));
    const cfg = getCloud();
    if (!cfg || cfg.mode === 'owner') {
      g.append(h('button', { class: 'card new-card', onclick: () => worksheetDialog(this.app) },
        h('div', { class: 'cover new-cover', html: icons.template }), h('div', { class: 'card-title' }, '문제지 만들기')));
    }
    for (const nb of list) {
      const cover = nb.thumb
        ? h('div', { class: 'cover thumb-cover', style: { '--cover': nb.cover } }, h('img', { src: nb.thumb, alt: '', draggable: 'false' }))
        : h('div', { class: 'cover color-cover', style: { '--cover': nb.cover } }, h('span', {}, nb.title));
      g.append(h('div', { class: 'card' },
        h('button', { class: 'card-open', onclick: () => this.app.openNotebook(nb.id), 'aria-label': `${nb.title} 열기` }, cover),
        h('div', { class: 'card-info' },
          h('div', { class: 'card-text' }, h('div', { class: 'card-title' }, nb.title), h('div', { class: 'card-date' }, formatDate(nb.updatedAt), this.syncLabel(nb))),
          h('button', { class: 'mini-btn', 'aria-label': '노트 메뉴', html: icons.more, onclick: (e) => this.cardMenu(e.currentTarget, nb) }))));
    }
    if (!this.notebooks.length) {
      g.append(h('div', { class: 'empty' },
        h('p', {}, '아직 노트가 없습니다.'),
        h('p', { class: 'muted' }, '“새 노트”를 눌러 시작하거나, PDF를 가져와서 필기해 보세요.')));
    }
  }

  importMenu(anchor) {
    menu(anchor, [
      { label: 'PDF 가져오기', icon: icons.pdf, action: () => this.importPdf() },
      { label: '백업 파일(.gnote) 가져오기', icon: icons.upload, action: () => this.importBackupFile() },
    ]);
  }

  cardMenu(anchor, nb) {
    menu(anchor, [
      { label: '이름 바꾸기', icon: icons.edit, action: () => this.rename(nb) },
      { label: '표지 색 바꾸기', icon: icons.palette, action: () => this.recolor(nb) },
      { label: '복제', icon: icons.duplicate, action: () => this.duplicate(nb) },
      '-',
      { label: 'PDF로 내보내기', icon: icons.pdf, action: () => this.exportPdf(nb) },
      { label: '백업 파일로 내보내기', icon: icons.download, action: () => this.exportBackup(nb) },
      ...this.cloudMenuItems(nb),
      '-',
      { label: '삭제', icon: icons.trash, danger: true, action: () => this.remove(nb) },
    ]);
  }

  cloudMenuItems(nb) {
    const cfg = getCloud();
    if (!cfg || nb.remoteId) return [];
    const on = shouldSync(nb, cfg);
    const label = cfg.mode === 'student' ? '선생님께 제출' : '클라우드에 저장';
    const assign = cfg.mode === 'owner'
      ? [{ label: nb.taskInfo?.assignedAt ? '과제 다시 내주기' : '과제로 내주기', icon: icons.share || icons.upload, action: () => assignDialog(nb.id) }]
      : [];
    return ['-', ...assign, {
      label, icon: icons.cloud, checked: on,
      action: async () => {
        const fresh = await db.getNotebook(nb.id);
        fresh.cloud = !on;
        await db.putNotebook(fresh);
        if (!on) await runSync(this);
        else {
          toast(cfg.mode === 'student' ? '이제 이 노트는 올리지 않습니다 (이미 제출한 것은 남아 있습니다)' : '이 노트는 클라우드에 올리지 않습니다');
          await this.load();
        }
      },
    }];
  }

  async createDialog() {
    let cover = COVER_COLORS[Math.floor(Math.random() * COVER_COLORS.length)];
    let template = 'lined', paper = 'white', size = 'a4-portrait';
    const title = h('input', { class: 'input', type: 'text', placeholder: '제목 없음', value: '' });
    const covers = h('div', { class: 'choice-row' });
    const tplGrid = h('div', { class: 'choice-grid' });
    const paperRow = h('div', { class: 'choice-row' });
    const sizeSel = h('select', { class: 'input' }, Object.entries(PAGE_SIZES).map(([id, s]) => h('option', { value: id }, s.label)));
    sizeSel.addEventListener('change', () => { size = sizeSel.value; draw(); });
    const draw = () => {
      covers.innerHTML = '';
      for (const c of COVER_COLORS) {
        covers.append(h('button', { class: `cover-chip ${c === cover ? 'active' : ''}`, style: { background: c }, 'aria-label': '표지 색', onclick: () => { cover = c; draw(); } }));
      }
      tplGrid.innerHTML = '';
      for (const [id, label] of Object.entries(TEMPLATES)) {
        tplGrid.append(h('button', { class: `choice ${template === id ? 'active' : ''}`, onclick: () => { template = id; draw(); } },
          templatePreview(id, paper, size), h('span', {}, label)));
      }
      paperRow.innerHTML = '';
      for (const [id, pc] of Object.entries(PAPER_COLORS)) {
        paperRow.append(h('button', { class: `paper-chip ${paper === id ? 'active' : ''}`, onclick: () => { paper = id; draw(); } },
          h('span', { class: 'paper-dot', style: { background: pc.fill } }), pc.label));
      }
    };
    draw();
    const ok = await dialog({
      title: '새 노트',
      body: h('div', { class: 'form' },
        h('label', { class: 'field-label' }, '제목'), title,
        h('label', { class: 'field-label' }, '표지'), covers,
        h('label', { class: 'field-label' }, '종이 서식'), tplGrid,
        h('div', { class: 'two-col' },
          h('div', {}, h('label', { class: 'field-label' }, '종이 크기'), sizeSel),
          h('div', {}, h('label', { class: 'field-label' }, '종이 색'), paperRow))),
      buttons: [{ label: '취소', value: false }, { label: '만들기', value: true, primary: true }],
    });
    if (!ok) return;
    const nb = newNotebook({ title: title.value.trim() || '제목 없음', cover, size, template, paper });
    const page = newPage(nb.id, { size, template, paper });
    nb.pageIds = [page.id];
    await db.putNotebookWithPages(nb, [page]);
    this.app.openNotebook(nb.id);
  }

  async importPdf() {
    const file = await pickFile('application/pdf,.pdf');
    if (!file) return;
    const nb = newNotebook({ title: file.name.replace(/\.pdf$/i, ''), template: 'blank' });
    try {
      progress('PDF 여는 중…');
      const pages = await pdfToPages(file, nb.id, (i, n) => progress(`PDF 가져오는 중… ${i} / ${n}`));
      nb.pageIds = pages.map((p) => p.id);
      if (pages[0]) { nb.size = 'a4-portrait'; }
      await db.putNotebookWithPages(nb, pages);
      progress(null);
      this.app.openNotebook(nb.id);
    } catch (e) {
      console.error(e);
      progress(null);
      toast('PDF를 열 수 없습니다. 암호가 걸렸거나 손상된 파일일 수 있습니다.', 4000);
    }
  }

  async importBackupFile() {
    const file = await pickFile('.gnote,application/json,.json');
    if (!file) return;
    try {
      progress('백업 파일 불러오는 중…');
      const { nb, pages } = await importBackup(file);
      await db.putNotebookWithPages(nb, pages);
      progress(null);
      toast(`“${nb.title}” 노트를 가져왔습니다`);
      await this.load();
    } catch (e) {
      console.error(e);
      progress(null);
      toast(e.message || '백업 파일을 읽을 수 없습니다', 4000);
    }
  }

  async loadFull(nb) {
    const pages = await db.getPages(nb.id);
    const byId = new Map(pages.map((p) => [p.id, p]));
    return nb.pageIds.map((id) => byId.get(id)).filter(Boolean);
  }

  async rename(nb) {
    const name = await promptDialog('노트 이름', nb.title);
    if (!name) return;
    nb.title = name;
    await db.putNotebook(nb);
    this.renderGrid();
  }

  async recolor(nb) {
    const row = h('div', { class: 'choice-row' });
    let chosen = nb.cover;
    const draw = () => {
      row.innerHTML = '';
      for (const c of COVER_COLORS) row.append(h('button', { class: `cover-chip ${c === chosen ? 'active' : ''}`, style: { background: c }, onclick: () => { chosen = c; draw(); } }));
    };
    draw();
    const ok = await dialog({ title: '표지 색', body: row, buttons: [{ label: '취소', value: false }, { label: '적용', value: true, primary: true }] });
    if (!ok) return;
    nb.cover = chosen;
    await db.putNotebook(nb);
    this.renderGrid();
  }

  async duplicate(nb) {
    const pages = await this.loadFull(nb);
    const copy = { ...nb, id: uid(), title: nb.title + ' 사본', createdAt: Date.now(), updatedAt: Date.now() };
    delete copy.syncedAt;
    const newPages = pages.map((p) => ({ ...p, id: uid(), notebookId: copy.id }));
    copy.pageIds = newPages.map((p) => p.id);
    await db.putNotebookWithPages(copy, newPages);
    await this.load();
    toast('노트를 복제했습니다');
  }

  async exportPdf(nb) {
    try {
      progress('PDF 만드는 중…');
      const pages = await this.loadFull(nb);
      const blob = await exportPdf(pages, (i, n) => progress(`PDF 만드는 중… ${i} / ${n}`));
      progress(null);
      await saveFile(blob, safeFileName(nb.title) + '.pdf');
    } catch (e) {
      console.error(e);
      progress(null);
      toast('PDF를 만들지 못했습니다');
    }
  }

  async exportBackup(nb) {
    try {
      progress('백업 파일 만드는 중…');
      const blob = await exportBackup(nb, await this.loadFull(nb));
      progress(null);
      await saveFile(blob, safeFileName(nb.title) + '.gnote');
    } catch (e) {
      console.error(e);
      progress(null);
      toast('백업 파일을 만들지 못했습니다');
    }
  }

  async remove(nb) {
    const cfg = getCloud();
    const inCloud = cfg && !nb.remoteId && nb.syncedAt;
    let choice;
    if (inCloud) {
      choice = await dialog({
        title: '노트 삭제',
        body: `“${nb.title}” 노트를 지울까요? 되돌릴 수 없습니다.`,
        buttons: [
          { label: '취소', value: null },
          { label: '이 기기에서만', value: 'local' },
          { label: '클라우드에서도', value: 'all', danger: true },
        ],
      });
      if (!choice) return;
    } else {
      if (!(await confirmDialog('노트 삭제', `“${nb.title}” 노트를 지울까요? 되돌릴 수 없습니다.`))) return;
      choice = 'local';
    }
    if (inCloud) {
      // 동기화할 때 다시 내려받지 않도록 기억해 둔다
      rememberDeleted(nb.id);
      if (choice === 'all') {
        try { await removeRemote(nb.id); } catch (e) { toast('클라우드에서 지우지 못했습니다: ' + e.message, 4000); }
      }
    }
    await db.deleteNotebook(nb.id);
    await this.load();
  }
}
