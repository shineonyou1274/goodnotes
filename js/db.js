// IndexedDB 저장소: 노트(notebooks)와 페이지(pages)를 기기 안에 저장한다.
const DB_NAME = 'goodnotes-web';
const DB_VERSION = 1;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('notebooks')) {
        db.createObjectStore('notebooks', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('pages')) {
        const pages = db.createObjectStore('pages', { keyPath: 'id' });
        pages.createIndex('notebookId', 'notebookId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function promisify(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function getAllNotebooks() {
  const db = await open();
  return promisify(db.transaction('notebooks').objectStore('notebooks').getAll());
}

export async function getNotebook(id) {
  const db = await open();
  return promisify(db.transaction('notebooks').objectStore('notebooks').get(id));
}

export async function putNotebook(nb) {
  const db = await open();
  const tx = db.transaction('notebooks', 'readwrite');
  tx.objectStore('notebooks').put(nb);
  return txDone(tx);
}

export async function getPages(notebookId) {
  const db = await open();
  const idx = db.transaction('pages').objectStore('pages').index('notebookId');
  return promisify(idx.getAll(notebookId));
}

export async function putPages(pages) {
  const db = await open();
  const tx = db.transaction('pages', 'readwrite');
  const store = tx.objectStore('pages');
  for (const p of pages) store.put(p);
  return txDone(tx);
}

export async function deletePages(ids) {
  const db = await open();
  const tx = db.transaction('pages', 'readwrite');
  const store = tx.objectStore('pages');
  for (const id of ids) store.delete(id);
  return txDone(tx);
}

// 노트와 그 페이지들을 한 번에 저장한다.
export async function putNotebookWithPages(nb, pages) {
  const db = await open();
  const tx = db.transaction(['notebooks', 'pages'], 'readwrite');
  tx.objectStore('notebooks').put(nb);
  const store = tx.objectStore('pages');
  for (const p of pages) store.put(p);
  return txDone(tx);
}

export async function deleteNotebook(id) {
  const db = await open();
  const pages = await getPages(id);
  const tx = db.transaction(['notebooks', 'pages'], 'readwrite');
  tx.objectStore('notebooks').delete(id);
  const store = tx.objectStore('pages');
  for (const p of pages) store.delete(p.id);
  return txDone(tx);
}

export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      const already = await navigator.storage.persisted();
      if (!already) await navigator.storage.persist();
    }
  } catch { /* 지원하지 않는 브라우저 */ }
}
