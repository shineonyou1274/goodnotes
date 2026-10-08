// 화면 요소를 만드는 도우미, 파일 저장·공유, 알림 메시지

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) {
        if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv;
      }
    }
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export async function dataURLToBlob(url) {
  const res = await fetch(url);
  return res.blob();
}

export function safeFileName(name) {
  return (name || 'note').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'note';
}

const isTouchDevice = () => window.matchMedia('(pointer: coarse)').matches;

// 태블릿에서는 공유 시트(파일 앱·드라이브 등에 저장)를, 그 밖에는 내려받기를 쓴다
export async function saveFile(blob, filename) {
  const file = new File([blob], filename, { type: blob.type });
  if (isTouchDevice() && navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export function pickFile(accept, multiple = false) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, style: { display: 'none' } });
    if (multiple) input.multiple = true;
    input.addEventListener('change', () => {
      resolve(multiple ? [...input.files] : input.files[0] || null);
      input.remove();
    });
    document.body.appendChild(input);
    input.click();
  });
}

let toastTimer = 0;
export function toast(msg, ms = 2400) {
  let el = document.getElementById('toast');
  if (!el) {
    el = h('div', { id: 'toast', role: 'status' });
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

export function progress(msg) {
  let el = document.getElementById('progress');
  if (!msg) { el?.remove(); return; }
  if (!el) {
    el = h('div', { id: 'progress' }, h('div', { class: 'box' }, h('div', { class: 'spinner' }), h('div', { class: 'msg' })));
    document.body.appendChild(el);
  }
  el.querySelector('.msg').textContent = msg;
}

// 간단한 대화 상자. buttons: [{label, value, primary, danger}]
export function dialog({ title, body, buttons = [{ label: '확인', value: true, primary: true }] }) {
  return new Promise((resolve) => {
    const close = (v) => { back.remove(); resolve(v); };
    const box = h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true' },
      title && h('h2', {}, title),
      body && h('div', { class: 'dialog-body' }, body),
      h('div', { class: 'dialog-buttons' },
        buttons.map((b) => h('button', {
          class: `btn ${b.primary ? 'primary' : ''} ${b.danger ? 'danger' : ''}`,
          onclick: () => close(typeof b.value === 'function' ? b.value() : b.value),
        }, b.label))));
    const back = h('div', { class: 'dialog-back', onclick: (e) => { if (e.target === back) close(null); } }, box);
    document.body.appendChild(back);
    const first = box.querySelector('input, select');
    if (first) setTimeout(() => first.focus(), 50);
  });
}

export function confirmDialog(title, message, okLabel = '삭제', danger = true) {
  return dialog({
    title,
    body: message,
    buttons: [{ label: '취소', value: false }, { label: okLabel, value: true, primary: !danger, danger }],
  });
}

export function promptDialog(title, value = '', placeholder = '') {
  const input = h('input', { class: 'input', type: 'text', value, placeholder });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') e.target.closest('.dialog').querySelector('.btn.primary').click();
  });
  return dialog({
    title,
    body: input,
    buttons: [{ label: '취소', value: null }, { label: '확인', value: () => input.value.trim(), primary: true }],
  });
}

// 떠 있는 메뉴(팝오버). anchor 요소 아래에 띄운다.
export function popover(anchor, content, { onClose, className = '' } = {}) {
  closePopovers();
  const pop = h('div', { class: `popover ${className}` }, content);
  const back = h('div', { class: 'popover-back' });
  const close = () => { pop.remove(); back.remove(); onClose?.(); };
  back.addEventListener('pointerdown', (e) => { e.preventDefault(); close(); });
  pop._close = close;
  document.body.append(back, pop);
  const r = anchor.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  let left = r.left + r.width / 2 - pr.width / 2;
  left = Math.max(8, Math.min(vw - pr.width - 8, left));
  let top = r.bottom + 8;
  if (top + pr.height > vh - 8) top = Math.max(8, r.top - pr.height - 8);
  pop.style.left = left + 'px';
  pop.style.top = top + 'px';
  return { el: pop, close };
}

export function closePopovers() {
  document.querySelectorAll('.popover').forEach((p) => (p._close ? p._close() : p.remove()));
}

export function menu(anchor, items) {
  const list = h('div', { class: 'menu' });
  const pop = popover(anchor, list);
  for (const it of items) {
    if (!it) continue;
    if (it === '-') { list.append(h('div', { class: 'menu-sep' })); continue; }
    list.append(h('button', {
      class: `menu-item ${it.danger ? 'danger' : ''}`,
      onclick: () => { pop.close(); it.action(); },
    }, it.icon ? h('span', { class: 'mi-icon', html: it.icon }) : null, h('span', {}, it.label),
    it.checked !== undefined ? h('span', { class: 'mi-check' }, it.checked ? '✓' : '') : null));
  }
  return pop;
}

export function formatDate(ts) {
  const d = new Date(ts);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) {
    return d.toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });
  }
  return d.toLocaleDateString('ko-KR', { year: 'numeric', month: 'short', day: 'numeric' });
}
