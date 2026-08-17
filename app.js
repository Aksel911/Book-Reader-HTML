/**
 * Умный Читатель v2 — Enhanced offline book reader for iPhone
 * Formats: PDF, EPUB, FB2, TXT, HTML
 * Features: TTS with highlight, bookmarks, TOC, search, sleep timer, stats, themes...
 */
(function () {
  'use strict';

  // ===== State =====
  const state = {
    books: [],
    currentBook: null,
    currentType: null,
    pdfDoc: null,
    pdfPage: 1,
    pdfTotal: 0,
    epubBook: null,
    epubRendition: null,
    epubToc: [],
    textContent: '',
    textPages: [],
    textPage: 0,
    fullText: '',          // for search & FB2
    isSpeaking: false,
    voices: [],
    detectedLang: 'ru-RU',
    readerTheme: localStorage.getItem('readerTheme') || 'dark',
    fontSize: parseInt(localStorage.getItem('fontSize') || '18', 10),
    lineHeight: parseFloat(localStorage.getItem('lineHeight') || '1.7'),
    fontFamily: localStorage.getItem('fontFamily') || 'system-ui',
    ttsRate: parseFloat(localStorage.getItem('ttsRate') || '1'),
    continuousTTS: true,
    highlightTTS: true,
    sleepTimerId: null,
    sleepTimerEnd: null,
    readingStart: null,
    ttsSentences: [],
    ttsSentenceIdx: 0,
    pendingBookmark: null,
    // Archive navigation
    archiveStack: [],          // [{name, books: [...], path}]
    currentViewBooks: null,    // null = root library
    rootBooks: []              // original folder books
  };

  // ===== DOM helpers =====
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  // ===== Utils =====
  function showLoading(t = 'Загрузка...') {
    $('#loading-text').textContent = t;
    $('#loading').classList.remove('hidden');
  }
  function hideLoading() { $('#loading').classList.add('hidden'); }

  function toast(msg, ms = 2200) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.add('hidden'), ms);
  }

  function formatSize(b) {
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1048576).toFixed(1) + ' MB';
  }

  function getExt(n) { return n.split('.').pop().toLowerCase(); }
  function isBookFile(n) {
    return ['pdf', 'epub', 'fb2', 'djvu', 'djv', 'txt', 'html', 'htm'].includes(getExt(n));
  }
  function isArchive(n) {
    return ['zip', 'rar'].includes(getExt(n));
  }
  function isSupportedEntry(n) {
    return isBookFile(n) || isArchive(n);
  }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  function detectLanguage(text) {
    if (!text || text.length < 20) return 'ru-RU';
    const sample = text.slice(0, 2000).toLowerCase();
    const cyr = (sample.match(/[а-яёіїєґ]/g) || []).length;
    const lat = (sample.match(/[a-z]/g) || []).length;
    const chi = (sample.match(/[\u4e00-\u9fff]/g) || []).length;
    const jap = (sample.match(/[\u3040-\u30ff]/g) || []).length;
    const kor = (sample.match(/[\uac00-\ud7af]/g) || []).length;
    const tot = sample.replace(/\s/g, '').length || 1;

    if (chi / tot > 0.12) return 'zh-CN';
    if (jap / tot > 0.08) return 'ja-JP';
    if (kor / tot > 0.08) return 'ko-KR';
    if (cyr / tot > 0.25) {
      if (/[іїєґ]/.test(sample)) return 'uk-UA';
      return 'ru-RU';
    }
    if (lat / tot > 0.35) {
      if (/\b(the|and|of|to|in|is|you|that|for)\b/.test(sample)) return 'en-US';
      if (/\b(der|die|das|und|ist|ich|nicht|ein)\b/.test(sample)) return 'de-DE';
      if (/\b(le|la|les|des|et|est|que|pour|un)\b/.test(sample)) return 'fr-FR';
      if (/\b(el|la|los|las|de|que|en|un|una)\b/.test(sample)) return 'es-ES';
      if (/\b(il|la|di|che|per|una|sono)\b/.test(sample)) return 'it-IT';
      if (/\b(o|a|os|as|de|que|em|um)\b/.test(sample)) return 'pt-BR';
      return 'en-US';
    }
    return 'ru-RU';
  }

  // Split text into sentences for TTS highlighting
  function splitSentences(text) {
    if (!text) return [];
    const parts = text.match(/[^.!?…]+[.!?…]+(?:\s+|$)|[^.!?…]+$/g) || [text];
    const out = [];
    for (const part of parts) {
      const clean = part.replace(/\s+/g, ' ').trim();
      if (!clean) continue;
      if (clean.length <= 260) out.push(clean);
      else for (let i = 0; i < clean.length; i += 240) out.push(clean.slice(i, i + 240).trim());
    }
    return out.filter(Boolean);
  }

  // ===== Storage =====
  function loadJSON(key, def = {}) {
    try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(def)); }
    catch { return def; }
  }
  function saveJSON(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  }

  function getProgress(path) {
    return loadJSON('bookProgress')[path] || 0;
  }
  function setProgress(path, p) {
    const d = loadJSON('bookProgress');
    d[path] = p;
    saveJSON('bookProgress', d);
  }

  function getBookmarks(path) {
    return loadJSON('bookBookmarks')[path] || [];
  }
  function setBookmarks(path, list) {
    const d = loadJSON('bookBookmarks');
    d[path] = list;
    saveJSON('bookBookmarks', d);
  }

  // Favorites & Tags
  function getFavorites() {
    return loadJSON('bookFavorites', {});
  }
  function isFavorite(path) {
    return !!getFavorites()[path];
  }
  function toggleFavorite(path) {
    const f = getFavorites();
    if (f[path]) delete f[path];
    else f[path] = Date.now();
    saveJSON('bookFavorites', f);
    return !!f[path];
  }
  function getTags(path) {
    return loadJSON('bookTags')[path] || [];
  }
  function setTags(path, tags) {
    const d = loadJSON('bookTags');
    d[path] = [...new Set(tags.map(t => t.trim()).filter(Boolean))];
    saveJSON('bookTags', d);
  }
  function getAllTags() {
    const d = loadJSON('bookTags');
    const set = new Set();
    Object.values(d).forEach(arr => (arr || []).forEach(t => set.add(t)));
    return [...set].sort((a, b) => a.localeCompare(b, 'ru'));
  }

  function getStats() {
    return loadJSON('readingStats', { totalMinutes: 0, booksOpened: 0, pagesRead: 0 });
  }
  function addReadingTime(mins) {
    const s = getStats();
    s.totalMinutes = (s.totalMinutes || 0) + mins;
    saveJSON('readingStats', s);
  }
  function incStat(key, n = 1) {
    const s = getStats();
    s[key] = (s[key] || 0) + n;
    saveJSON('readingStats', s);
  }

  // ===== Theme & Settings =====
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    state.readerTheme = theme;
    localStorage.setItem('readerTheme', theme);
    $$('.theme-opt').forEach(b => b.classList.toggle('active', b.dataset.theme === theme));
  }

  function applyReaderStyles() {
    document.documentElement.style.setProperty('--reader-font-size', state.fontSize + 'px');
    document.documentElement.style.setProperty('--reader-line-height', state.lineHeight);
    document.documentElement.style.setProperty('--reader-font-family', state.fontFamily);
    const el = $('#text-reader');
    if (el) {
      el.style.fontSize = state.fontSize + 'px';
      el.style.lineHeight = state.lineHeight;
      el.style.fontFamily = state.fontFamily;
    }
  }

  // ===== Library import =====
  const SUPPORTED_EXTENSIONS = ['pdf', 'epub', 'fb2', 'djvu', 'djv', 'txt', 'html', 'htm', 'zip', 'rar'];

  function makeBook(file, relPath = '') {
    const type = getExt(file.name);
    const archive = isArchive(file.name);
    const path = relPath || file.webkitRelativePath || file.name;
    const stableKey = path;
    const recents = loadJSON('recentBooks', {});
    return {
      id: stableKey,
      name: file.name.replace(/\.[^.]+$/, ''),
      path,
      key: stableKey,
      type,
      isArchive: archive,
      file,
      size: file.size,
      modified: file.lastModified || 0,
      progress: archive ? 0 : getProgress(stableKey) || getProgress(path),
      lastOpened: recents[stableKey] || recents[path] || 0,
      fromArchive: false
    };
  }

  function importFiles(fileList, sourceLabel = 'файлов') {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    showLoading(`Сканирую ${sourceLabel}...`);
    const books = files.filter(file => isSupportedEntry(file.name)).map(file => makeBook(file));
    state.books = books;
    state.rootBooks = books;
    state.archiveStack = [];
    state.currentViewBooks = null;
    hideLoading();
    renderLibrary();
    toast(`Найдено: ${books.length} поддерживаемых файлов`);
  }

  $('#folder-input').addEventListener('change', e => {
    importFiles(e.target.files, 'папку и подпапки');
    e.target.value = '';
  });
  $('#files-input').addEventListener('change', e => {
    importFiles(e.target.files, 'файлы');
    e.target.value = '';
  });

  // Desktop fallback: drag/drop a folder or a collection of files.
  const dropTarget = $('#welcome-card');
  ['dragenter','dragover'].forEach(type => dropTarget.addEventListener(type, e => {
    e.preventDefault(); dropTarget.classList.add('drag-over');
  }));
  ['dragleave','drop'].forEach(type => dropTarget.addEventListener(type, e => {
    e.preventDefault(); dropTarget.classList.remove('drag-over');
  }));
  dropTarget.addEventListener('drop', e => importFiles(e.dataTransfer && e.dataTransfer.files, 'перетащенных файлов'));

  function getCurrentBooks() {
    return state.currentViewBooks || state.rootBooks || state.books;
  }

  function renderBreadcrumb() {
    const el = $('#archive-breadcrumb');
    if (!state.archiveStack.length) {
      el.classList.add('hidden');
      el.innerHTML = '';
      return;
    }
    el.classList.remove('hidden');
    let html = '<span class="crumb" data-level="-1">📚 Библиотека</span>';
    state.archiveStack.forEach((a, i) => {
      html += '<span class="sep">›</span>';
      const isLast = i === state.archiveStack.length - 1;
      html += `<span class="crumb ${isLast ? 'current' : ''}" data-level="${i}">${escapeHtml(a.name)}</span>`;
    });
    el.innerHTML = html;
    el.querySelectorAll('.crumb:not(.current)').forEach(c => {
      c.addEventListener('click', () => {
        const level = parseInt(c.dataset.level, 10);
        if (level < 0) {
          state.archiveStack = [];
          state.currentViewBooks = null;
        } else {
          state.archiveStack = state.archiveStack.slice(0, level + 1);
          state.currentViewBooks = state.archiveStack[level].books;
        }
        renderLibrary($('#search-books').value);
      });
    });
  }

  function renderLibrary(filter = '') {
    $('#welcome-card').classList.add('hidden');
    $('#library-content').classList.remove('hidden');
    renderBreadcrumb();

    const source = getCurrentBooks();
    const q = filter.trim().toLowerCase();
    let list = q
      ? source.filter(b => b.name.toLowerCase().includes(q) || (b.path || '').toLowerCase().includes(q))
      : [...source];

    const sort = $('#sort-books').value;
    if (sort === 'favorites') {
      list = list.filter(b => isFavorite(b.key || b.path));
      list.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    } else if (sort === 'name') list.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    else if (sort === 'progress') list.sort((a, b) => (b.progress || 0) - (a.progress || 0));
    else if (sort === 'type') list.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name, 'ru'));
    else if (sort === 'recent') list.sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0));

    const totalRoot = (state.rootBooks || state.books).length;
    const inArch = state.archiveStack.length ? ` (в архиве)` : '';
    $('#library-stats').textContent = `Показано: ${list.length}${inArch} · всего в корне: ${totalRoot}`;
    $('#hero-book-count').textContent = totalRoot;
    $('#library-heading').textContent = state.archiveStack.length ? state.archiveStack[state.archiveStack.length - 1].name : 'Все книги';
    $('#library-subheading').textContent = state.archiveStack.length ? 'Содержимое архива' : 'Локальная коллекция на этом устройстве';

    const grid = $('#books-grid');
    grid.innerHTML = '';
    if (!list.length) {
      const msg = $('#sort-books').value === 'favorites'
        ? 'В избранном пока пусто.<br>Откройте книгу → ⋮ → «В избранном»'
        : 'Ничего не найдено';
      grid.innerHTML = `<p style="grid-column:1/-1;text-align:center;color:var(--text-muted);padding:40px;line-height:1.5">${msg}</p>`;
      return;
    }

    list.forEach(book => {
      const bms = getBookmarks(book.key || book.path);
      const card = document.createElement('div');
      card.className = 'book-card' + (bms.length ? ' has-bookmark' : '');
      const icon = { pdf: '📄', epub: '📘', fb2: '📙', djvu: '📗', djv: '📗', txt: '📝', html: '🌐', htm: '🌐', zip: '📦', rar: '📦' }[book.type] || (book.isArchive ? '📦' : '📖');
      const fav = isFavorite(book.key || book.path);
      const tags = getTags(book.key || book.path);
      const tagsHtml = tags.length
        ? `<div class="book-tags">${tags.slice(0, 3).map(t => `<span class="book-tag">${escapeHtml(t)}</span>`).join('')}</div>`
        : '';
      card.innerHTML = `
        <button type="button" class="fav-star" title="Избранное">${fav ? '⭐' : '☆'}</button>
        <div class="book-cover ${book.type}">${icon}</div>
        <div class="book-info">
          <div class="book-name">${escapeHtml(book.name)}</div>
          <div class="book-meta">${(book.isArchive ? 'Архив ' : '') + book.type.toUpperCase()} · ${formatSize(book.size || 0)}</div>
          ${book.path && book.path.includes('/') ? `<div class="book-path" title="${escapeHtml(book.path)}">${escapeHtml(book.path.split('/').slice(0, -1).join(' / '))}</div>` : ''}
          ${tagsHtml}
          <div class="book-progress"><div class="book-progress-bar" style="width:${Math.min(100, (book.progress || 0) * 100)}%"></div></div>
        </div>`;
      const starBtn = card.querySelector('.fav-star');
      starBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const now = toggleFavorite(book.key || book.path);
        starBtn.textContent = now ? '⭐' : '☆';
        toast(now ? 'В избранном ⭐' : 'Убрано из избранного');
      });
      card.addEventListener('click', () => openBook(book));
      grid.appendChild(card);
    });
  }

  $('#search-books').addEventListener('input', () => renderLibrary($('#search-books').value));
  $('#sort-books').addEventListener('change', () => renderLibrary($('#search-books').value));
  $('#reselect-folder').addEventListener('click', () => {
    $('#folder-input').value = '';
    $('#folder-input').click();
  });

  // Export progress
  $('#export-progress').addEventListener('click', () => {
    const data = {
      progress: loadJSON('bookProgress'),
      bookmarks: loadJSON('bookBookmarks'),
      stats: getStats(),
      exportedAt: new Date().toISOString()
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'book-reader-progress.json';
    a.click();
    toast('Прогресс экспортирован');
  });

  // ===== Open book =====
  async function openBook(book) {
    if (book.isArchive || isArchive(book.name || book.path || '')) {
      await openArchive(book);
      return;
    }

    state.currentBook = book;
    state.currentType = book.type;
    $('#book-title').textContent = book.name;
    showLoading('Открываю книгу...');

    const recents = loadJSON('recentBooks', {});
    recents[book.key || book.path] = Date.now();
    saveJSON('recentBooks', recents);
    book.lastOpened = Date.now();
    incStat('booksOpened');
    state.readingStart = Date.now();

    try {
      if (book.type === 'pdf') await openPDF(book);
      else if (book.type === 'epub') await openEPUB(book);
      else if (book.type === 'fb2') await openFB2(book);
      else if (book.type === 'djvu' || book.type === 'djv') await openDJVU(book);
      else await openText(book);

      $('#library-screen').classList.remove('active');
      $('#reader-screen').classList.add('active');
      prepareTTS();
      updateProgressBar();
    } catch (err) {
      console.error(err);
      alert('Не удалось открыть: ' + (err.message || err));
    } finally {
      hideLoading();
    }
  }

  // ===== Archives (ZIP fully, RAR best-effort) =====
  async function openArchive(book) {
    const ext = getExt(book.name || book.path || 'file.zip');
    showLoading(ext === 'zip' ? 'Распаковываю ZIP...' : 'Пробую открыть RAR...');

    try {
      let entries = [];
      if (ext === 'zip') {
        entries = await unpackZip(book.file);
      } else if (ext === 'rar') {
        entries = await unpackRar(book.file);
      } else {
        throw new Error('Формат архива не поддерживается');
      }

      if (!entries.length) {
        toast('В архиве нет поддерживаемых книг');
        hideLoading();
        return;
      }

      state.archiveStack.push({
        name: book.name || book.path,
        books: entries,
        path: book.path
      });
      state.currentViewBooks = entries;
      hideLoading();
      renderLibrary();
      toast(`В архиве: ${entries.length} файл(ов)`);
    } catch (err) {
      console.error(err);
      hideLoading();
      alert('Не удалось открыть архив: ' + (err.message || err) +
        (ext === 'rar' ? '\n\nRAR поддерживается ограниченно. Лучше используйте ZIP.' : ''));
    }
  }

  async function unpackZip(fileOrBlob) {
    if (typeof JSZip === 'undefined') throw new Error('JSZip не загружен');
    const zip = await JSZip.loadAsync(fileOrBlob);
    const books = [];
    const promises = [];

    zip.forEach((relativePath, entry) => {
      if (entry.dir) return;
      const name = relativePath.split('/').pop();
      if (!isSupportedEntry(name)) return;

      promises.push((async () => {
        try {
          const blob = await entry.async('blob');
          // Give it a File-like object
          const f = new File([blob], name, { type: blob.type || 'application/octet-stream' });
          const type = getExt(name);
          const isArch = isArchive(name);
          const archivePath = `${fileOrBlob.name || 'archive'}::${relativePath}`;
          books.push({
            id: archivePath,
            name: name.replace(/\.[^.]+$/, ''),
            path: relativePath,
            key: archivePath,
            type,
            isArchive: isArch,
            file: f,
            size: blob.size,
            modified: 0,
            progress: isArch ? 0 : getProgress(archivePath) || getProgress(relativePath),
            lastOpened: 0,
            fromArchive: true
          });
        } catch (e) {
          console.warn('Skip entry', relativePath, e);
        }
      })());
    });

    await Promise.all(promises);
    return books.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  }

  async function unpackRar(file) {
    // Best-effort: many pure-JS RAR solutions are heavy/WASM.
    // We try dynamic approach; if fails, user gets clear message.
    // For production reliability on iPhone ZIP is recommended.
    throw new Error('RAR на iPhone в браузере работает нестабильно. Распакуйте в ZIP или выберите ZIP-архив.');
  }

  // ===== DJVU via official DjVu.js Viewer =====
  let djvuViewerInstance = null;

  async function openDJVU(book) {
    if (typeof DjVu === 'undefined' || !DjVu.Viewer) {
      throw new Error('DjVu.js не загружен. Проверьте libs/djvu.js и libs/djvu_viewer.js');
    }

    // Clean previous
    if (djvuViewerInstance) {
      try { djvuViewerInstance = null; } catch (e) {}
    }

    $('#reader-content').innerHTML = '<div id="djvu-viewer-container"></div>';
    const container = $('#djvu-viewer-container');

    const viewer = new DjVu.Viewer();
    djvuViewerInstance = viewer;
    viewer.render(container);

    const buffer = await book.file.arrayBuffer();
    await viewer.loadDocument(buffer, book.name || 'document.djvu');

    // Page tracking
    const updatePageInfo = () => {
      try {
        const page = viewer.getPageNumber ? viewer.getPageNumber() : 1;
        const total = viewer.getPagesCount ? viewer.getPagesCount() : (viewer.pageCount || '?');
        $('#page-num').textContent = page;
        $('#page-count').textContent = total;
        if (typeof total === 'number' && total > 0) {
          const prog = page / total;
          state.currentBook.progress = prog;
          setProgress(state.currentBook.key || state.currentBook.path, prog);
          updateProgressBar();
        }
      } catch (e) {}
    };

    if (DjVu.Viewer && DjVu.Viewer.Events) {
      viewer.on(DjVu.Viewer.Events.PAGE_NUMBER_CHANGED, updatePageInfo);
    }
    // Fallback interval
    const pagePoll = setInterval(updatePageInfo, 800);
    state._djvuPoll = pagePoll;

    // Try text for language / TTS (best-effort)
    try {
      // Some versions expose text layer; otherwise leave empty
      state.textContent = '';
      state.fullText = '';
      state.detectedLang = 'ru-RU';
    } catch (e) {}

    // Restore page after short delay (viewer needs time to init page count)
    setTimeout(() => {
      updatePageInfo();
      try {
        const total = viewer.getPagesCount ? viewer.getPagesCount() : 1;
        const saved = Math.max(1, Math.min(total, Math.round((book.progress || 0) * total) || 1));
        if (viewer.configure) viewer.configure({ pageNumber: saved });
        else if (viewer.setPageNumber) viewer.setPageNumber(saved);
        updatePageInfo();
      } catch (e) { console.warn('DJVU restore page', e); }
    }, 400);
  }

  function loadScript(src) {

    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  function updateProgressBar() {
    let p = 0;
    if (state.currentType === 'pdf') p = state.pdfPage / (state.pdfTotal || 1);
    else if (state.currentType === 'epub') p = (state.currentBook && state.currentBook.progress) || 0;
    else if (state.currentType === 'djvu' || state.currentType === 'djv') p = (state.currentBook && state.currentBook.progress) || 0;
    else p = (state.textPage + 1) / (state.textPages.length || 1);
    $('#reading-progress-fill').style.width = (Math.min(1, Math.max(0, p)) * 100) + '%';
  }

  // ===== PDF =====
  async function openPDF(book) {
    if (typeof pdfjsLib === 'undefined') throw new Error('PDF.js не загружен. Обновите страницу (Ctrl+Shift+R). Если не помогло — перезалейте libs/pdf.min.js');
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'libs/pdf.worker.min.js';
    const buf = await book.file.arrayBuffer();
    state.pdfDoc = await pdfjsLib.getDocument({ data: buf }).promise;
    state.pdfTotal = state.pdfDoc.numPages;
    state.pdfPage = Math.max(1, Math.min(state.pdfTotal, Math.round(book.progress * state.pdfTotal) || 1));
    $('#reader-content').innerHTML = '<div id="pdf-viewer"></div>';
    $('#page-count').textContent = state.pdfTotal;
    await renderPDFPage(state.pdfPage);
  }

  async function renderPDFPage(num) {
    if (!state.pdfDoc) return;
    state.pdfPage = num;
    $('#page-num').textContent = num;
    const page = await state.pdfDoc.getPage(num);
    const scale = Math.min(2.2, (window.innerWidth - 16) / page.getViewport({ scale: 1 }).width);
    const vp = page.getViewport({ scale });
    const viewer = $('#pdf-viewer');
    viewer.innerHTML = '';
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    canvas.height = vp.height;
    canvas.width = vp.width;
    viewer.appendChild(canvas);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;

    const tc = await page.getTextContent();
    const pageText = tc.items.map(i => i.str).join(' ');
    state.textContent = pageText;
    state.fullText = pageText;
    if (pageText.length > 40) state.detectedLang = detectLanguage(pageText);

    const prog = num / state.pdfTotal;
    state.currentBook.progress = prog;
    setProgress(state.currentBook.key || state.currentBook.path, prog);
    updateProgressBar();
    incStat('pagesRead');
  }

  // ===== EPUB =====
  async function openEPUB(book) {
    if (typeof ePub === 'undefined') throw new Error('epub.js не загружен');
    const buf = await book.file.arrayBuffer();
    state.epubBook = ePub(buf);
    await state.epubBook.ready;

    $('#reader-content').innerHTML = '<div id="epub-area"></div>';
    state.epubRendition = state.epubBook.renderTo($('#epub-area'), {
      width: '100%', height: '100%', flow: 'paginated'
    });

    const saved = localStorage.getItem('epubLoc:' + (book.key || book.path));
    if (saved) await state.epubRendition.display(saved);
    else await state.epubRendition.display();

    // TOC
    try {
      const nav = await state.epubBook.loaded.navigation;
      state.epubToc = nav.toc || [];
    } catch (e) { state.epubToc = []; }

    state.epubRendition.on('relocated', (loc) => {
      try {
        const percent = loc.start.percentage || 0;
        state.currentBook.progress = percent;
        setProgress(book.key || book.path, percent);
        localStorage.setItem('epubLoc:' + (book.key || book.path), loc.start.cfi);
        $('#page-num').textContent = Math.round(percent * 100) + '%';
        $('#page-count').textContent = '100%';
        updateProgressBar();
      } catch (e) {}
    });

    // language sample
    try {
      const spine = state.epubBook.spine;
      if (spine && spine.length) {
        const first = spine.get(0);
        const doc = await first.load(state.epubBook.load.bind(state.epubBook));
        const text = (doc.body && doc.body.innerText) || '';
        if (text.length > 60) {
          state.detectedLang = detectLanguage(text);
          state.textContent = text.slice(0, 4000);
          state.fullText = text;
        }
      }
    } catch (e) {}
  }

  // ===== FB2 =====
  async function openFB2(book) {
    const raw = await book.file.text();
    const parser = new DOMParser();
    const xml = parser.parseFromString(raw, 'application/xml');
    if (xml.querySelector('parsererror')) throw new Error('Некорректный FB2');

    // Title
    const titleEl = xml.querySelector('book-title') || xml.querySelector('title-info book-title');
    if (titleEl) book.name = titleEl.textContent.trim() || book.name;
    $('#book-title').textContent = book.name;

    // Extract text from <body> sections, paragraphs
    const bodies = xml.querySelectorAll('body');
    let text = '';
    bodies.forEach(body => {
      const title = body.getAttribute('name') || '';
      if (title && title !== 'notes') text += '\n\n=== ' + title + ' ===\n\n';
      body.querySelectorAll('p, v, subtitle, text-author').forEach(p => {
        text += p.textContent.trim() + '\n\n';
      });
    });
    text = text.trim() || 'Пустой FB2';
    state.fullText = text;
    state.detectedLang = detectLanguage(text);
    paginateText(text, book);
  }

  // ===== TXT / HTML =====
  async function openText(book) {
    let text = await book.file.text();
    if (book.type === 'html' || book.type === 'htm') {
      const parser = new DOMParser();
      const doc = parser.parseFromString(text, 'text/html');
      text = doc.body ? doc.body.innerText : text;
    }
    state.fullText = text;
    state.detectedLang = detectLanguage(text);
    paginateText(text, book);
  }

  function paginateText(text, book) {
    const pageSize = 2200;
    state.textPages = [];
    for (let i = 0; i < text.length; i += pageSize) {
      state.textPages.push(text.slice(i, i + pageSize));
    }
    if (!state.textPages.length) state.textPages = [''];
    state.textPage = Math.min(state.textPages.length - 1, Math.floor((book.progress || 0) * state.textPages.length) || 0);
    state.textContent = state.textPages[state.textPage];

    $('#reader-content').innerHTML = '<div class="text-reader" id="text-reader"></div>';
    renderTextPage(true);
  }

  function renderTextPage(skipProgress) {
    const el = $('#text-reader');
    if (!el) return;
    state.textContent = state.textPages[state.textPage] || '';
    el.textContent = state.textContent; // will re-render with highlights later
    applyReaderStyles();
    $('#page-num').textContent = state.textPage + 1;
    $('#page-count').textContent = state.textPages.length;
    if (!skipProgress) {
      const prog = (state.textPage + 1) / state.textPages.length;
      state.currentBook.progress = prog;
      setProgress(state.currentBook.key || state.currentBook.path, prog);
    }
    updateProgressBar();
  }

  // ===== Navigation =====
  function goPrev() {
    if (state.currentType === 'pdf' && state.pdfPage > 1) renderPDFPage(state.pdfPage - 1);
    else if (state.currentType === 'epub' && state.epubRendition) state.epubRendition.prev();
    else if ((state.currentType === 'djvu' || state.currentType === 'djv') && djvuViewerInstance) {
      try {
        const p = djvuViewerInstance.getPageNumber ? djvuViewerInstance.getPageNumber() : 1;
        if (p > 1 && djvuViewerInstance.configure) djvuViewerInstance.configure({ pageNumber: p - 1 });
        else if (djvuViewerInstance.goToPreviousPage) djvuViewerInstance.goToPreviousPage();
      } catch (e) { console.warn(e); }
    }
    else if (['txt', 'html', 'htm', 'fb2'].includes(state.currentType) && state.textPage > 0) {
      state.textPage--;
      renderTextPage();
    }
  }
  function goNext() {
    if (state.currentType === 'pdf' && state.pdfPage < state.pdfTotal) renderPDFPage(state.pdfPage + 1);
    else if (state.currentType === 'epub' && state.epubRendition) state.epubRendition.next();
    else if ((state.currentType === 'djvu' || state.currentType === 'djv') && djvuViewerInstance) {
      try {
        const p = djvuViewerInstance.getPageNumber ? djvuViewerInstance.getPageNumber() : 1;
        const total = djvuViewerInstance.getPagesCount ? djvuViewerInstance.getPagesCount() : 9999;
        if (p < total && djvuViewerInstance.configure) djvuViewerInstance.configure({ pageNumber: p + 1 });
        else if (djvuViewerInstance.goToNextPage) djvuViewerInstance.goToNextPage();
      } catch (e) { console.warn(e); }
    }
    else if (['txt', 'html', 'htm', 'fb2'].includes(state.currentType) && state.textPage < state.textPages.length - 1) {
      state.textPage++;
      renderTextPage();
    }
  }

  $('#prev-page').addEventListener('click', goPrev);
  $('#next-page').addEventListener('click', goNext);

  // Swipe
  let touchX = 0;
  $('#reader-content').addEventListener('touchstart', e => { touchX = e.changedTouches[0].screenX; }, { passive: true });
  $('#reader-content').addEventListener('touchend', e => {
    const dx = e.changedTouches[0].screenX - touchX;
    if (Math.abs(dx) > 55) (dx < 0 ? goNext : goPrev)();
  }, { passive: true });

  // ===== TTS with sentence highlighting =====
  const synth = window.speechSynthesis || null;

  function loadVoices() {
    if (!synth) return;
    state.voices = synth.getVoices();
    const sel = $('#tts-voice');
    sel.innerHTML = '';
    if (!state.voices.length) {
      sel.innerHTML = '<option>Голоса...</option>';
      return;
    }
    const langPref = state.detectedLang.slice(0, 2);
    const preferred = state.voices.filter(v => v.lang.startsWith(langPref));
    const rest = state.voices.filter(v => !v.lang.startsWith(langPref));
    [...preferred, ...rest].forEach(v => {
      const opt = document.createElement('option');
      opt.value = state.voices.indexOf(v);
      opt.textContent = `${v.name} (${v.lang})`;
      sel.appendChild(opt);
    });
  }
  if (synth && synth.onvoiceschanged !== undefined) synth.onvoiceschanged = loadVoices;
  loadVoices();

  function prepareTTS() { loadVoices(); }

  function getCurrentText() {
    if (['pdf', 'txt', 'html', 'htm', 'fb2'].includes(state.currentType)) return state.textContent || '';
    if (state.currentType === 'epub') {
      try {
        const iframe = document.querySelector('#epub-area iframe');
        if (iframe && iframe.contentDocument) return iframe.contentDocument.body.innerText || state.textContent;
      } catch (e) {}
      return state.textContent || '';
    }
    return '';
  }

  function clearHighlights() {
    const el = $('#text-reader');
    if (el) el.textContent = state.textContent; // reset
  }

  function highlightSentence(idx) {
    if (!state.highlightTTS || !['txt', 'html', 'htm', 'fb2'].includes(state.currentType)) return;
    const el = $('#text-reader');
    if (!el || !state.ttsSentences.length) return;

    let html = '';
    state.ttsSentences.forEach((s, i) => {
      if (i === idx) html += `<span class="tts-highlight active">${escapeHtml(s)}</span> `;
      else html += escapeHtml(s) + ' ';
    });
    el.innerHTML = html;

    // Scroll active into view
    const active = el.querySelector('.tts-highlight.active');
    if (active) active.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function speakSentences(sentences, startIdx = 0) {
    if (!synth) { toast('Озвучка недоступна в этом браузере'); return; }
    if (!sentences.length) {
      toast('Нет текста для озвучки');
      return;
    }
    state.ttsSentences = sentences;
    state.ttsSentenceIdx = startIdx;
    speakNextSentence();
  }

  function speakNextSentence() {
    if (state.ttsSentenceIdx >= state.ttsSentences.length) {
      // finished page → continuous?
      state.isSpeaking = false;
      $('#tts-play').textContent = '▶';
      clearHighlights();
      if (state.continuousTTS) {
        setTimeout(() => {
          if (state.currentType === 'pdf' && state.pdfPage < state.pdfTotal) {
            renderPDFPage(state.pdfPage + 1).then(() => {
              const next = splitSentences(getCurrentText());
              if (next.length) speakSentences(next);
            });
          } else if (state.currentType === 'epub' && state.epubRendition) {
            state.epubRendition.next().then(() => {
              setTimeout(() => {
                const next = splitSentences(getCurrentText());
                if (next.length) speakSentences(next);
              }, 500);
            });
          } else if (['txt', 'html', 'htm', 'fb2'].includes(state.currentType) && state.textPage < state.textPages.length - 1) {
            state.textPage++;
            renderTextPage();
            const next = splitSentences(state.textContent);
            if (next.length) speakSentences(next);
          }
        }, 400);
      }
      return;
    }

    const text = state.ttsSentences[state.ttsSentenceIdx];
    highlightSentence(state.ttsSentenceIdx);

    if (synth) synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const override = $('#tts-lang-override').value;
    const lang = override === 'auto' ? state.detectedLang : override;
    u.lang = lang;
    u.rate = state.ttsRate;

    const idx = parseInt($('#tts-voice').value, 10);
    if (!isNaN(idx) && state.voices[idx]) u.voice = state.voices[idx];
    else {
      const m = state.voices.find(v => v.lang.startsWith(lang.slice(0, 2)));
      if (m) u.voice = m;
    }

    u.onend = () => {
      state.ttsSentenceIdx++;
      if (state.isSpeaking) speakNextSentence();
    };
    u.onerror = () => {
      state.isSpeaking = false;
      $('#tts-play').textContent = '▶';
    };

    state.isSpeaking = true;
    $('#tts-play').textContent = '⏸';
    synth.speak(u);
  }

  function startTTS() {
    const text = getCurrentText();
    const sentences = splitSentences(text);
    speakSentences(sentences);
  }

  $('#tts-play').addEventListener('click', () => {
    if (state.isSpeaking) {
      if (synth.paused) {
        synth.resume();
        $('#tts-play').textContent = '⏸';
      } else {
        synth.pause();
        $('#tts-play').textContent = '▶';
      }
    } else {
      startTTS();
    }
  });

  $('#tts-stop').addEventListener('click', () => {
    if (synth) synth.cancel();
    state.isSpeaking = false;
    $('#tts-play').textContent = '▶';
    clearHighlights();
  });

  $('#tts-rate').addEventListener('input', e => {
    state.ttsRate = parseFloat(e.target.value);
    localStorage.setItem('ttsRate', state.ttsRate);
    $('#tts-rate-label').textContent = state.ttsRate.toFixed(1) + '×';
  });

  // ===== Sleep Timer =====
  $('#tts-timer-btn').addEventListener('click', () => {
    $('#timer-overlay').classList.remove('hidden');
  });
  $('#close-timer').addEventListener('click', () => $('#timer-overlay').classList.add('hidden'));
  $('#timer-cancel').addEventListener('click', () => {
    if (state.sleepTimerId) clearTimeout(state.sleepTimerId);
    state.sleepTimerId = null;
    state.sleepTimerEnd = null;
    toast('Таймер отменён');
    $('#timer-overlay').classList.add('hidden');
  });
  $$('.timer-opt').forEach(btn => {
    btn.addEventListener('click', () => {
      const min = parseInt(btn.dataset.min, 10);
      if (state.sleepTimerId) clearTimeout(state.sleepTimerId);
      state.sleepTimerEnd = Date.now() + min * 60 * 1000;
      state.sleepTimerId = setTimeout(() => {
        if (synth) synth.cancel();
        state.isSpeaking = false;
        $('#tts-play').textContent = '▶';
        clearHighlights();
        toast('Таймер сна: озвучка остановлена');
        state.sleepTimerId = null;
      }, min * 60 * 1000);
      toast(`Таймер: ${min} мин`);
      $('#timer-overlay').classList.add('hidden');
    });
  });

  // ===== Bookmarks =====
  $('#bookmark-btn').addEventListener('click', () => {
    state.pendingBookmark = {
      path: state.currentBook.key || state.currentBook.path,
      type: state.currentType,
      page: state.currentType === 'pdf' ? state.pdfPage :
            state.currentType === 'epub' ? (localStorage.getItem('epubLoc:' + (state.currentBook.key || state.currentBook.path)) || '') :
            state.textPage,
      percent: state.currentBook.progress || 0,
      preview: (getCurrentText() || '').slice(0, 80),
      created: Date.now()
    };
    $('#bookmark-note').value = '';
    $('#bookmark-note-overlay').classList.remove('hidden');
  });

  $('#save-bookmark').addEventListener('click', () => {
    if (!state.pendingBookmark) return;
    const note = $('#bookmark-note').value.trim();
    const list = getBookmarks(state.pendingBookmark.path);
    list.push({ ...state.pendingBookmark, note, id: uid() });
    setBookmarks(state.pendingBookmark.path, list);
    state.pendingBookmark = null;
    $('#bookmark-note-overlay').classList.add('hidden');
    toast('Закладка сохранена 🔖');
  });
  $('#cancel-bookmark').addEventListener('click', () => {
    state.pendingBookmark = null;
    $('#bookmark-note-overlay').classList.add('hidden');
  });

  // ===== Side panel (TOC + Bookmarks) =====
  function openSidePanel(tab = 'toc') {
    $('#side-panel').classList.remove('hidden');
    $$('.side-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    $('#toc-content').classList.toggle('hidden', tab !== 'toc');
    $('#bookmarks-content').classList.toggle('hidden', tab !== 'bookmarks');
    if (tab === 'toc') renderTOC();
    else renderBookmarksPanel();
  }

  $('#toc-btn').addEventListener('click', () => openSidePanel('toc'));
  $('#close-side-panel').addEventListener('click', () => $('#side-panel').classList.add('hidden'));
  $$('.side-tab').forEach(t => {
    t.addEventListener('click', () => openSidePanel(t.dataset.tab));
  });

  function renderTOC() {
    const box = $('#toc-content');
    box.innerHTML = '';
    if (state.currentType === 'epub' && state.epubToc.length) {
      function addItems(items, level = 1) {
        items.forEach(item => {
          const div = document.createElement('div');
          div.className = 'toc-item level-' + Math.min(level, 3);
          div.textContent = item.label || 'Раздел';
          div.addEventListener('click', async () => {
            if (item.href && state.epubRendition) {
              await state.epubRendition.display(item.href);
              $('#side-panel').classList.add('hidden');
            }
          });
          box.appendChild(div);
          if (item.subitems && item.subitems.length) addItems(item.subitems, level + 1);
        });
      }
      addItems(state.epubToc);
    } else if (['txt', 'html', 'htm', 'fb2'].includes(state.currentType)) {
      // Simple page list
      const step = Math.max(1, Math.floor(state.textPages.length / 20));
      for (let i = 0; i < state.textPages.length; i += step) {
        const div = document.createElement('div');
        div.className = 'toc-item level-1';
        div.textContent = `Страница ${i + 1}`;
        div.addEventListener('click', () => {
          state.textPage = i;
          renderTextPage();
          $('#side-panel').classList.add('hidden');
        });
        box.appendChild(div);
      }
    } else if (state.currentType === 'pdf') {
      const step = Math.max(1, Math.floor(state.pdfTotal / 25));
      for (let i = 1; i <= state.pdfTotal; i += step) {
        const div = document.createElement('div');
        div.className = 'toc-item level-1';
        div.textContent = `Страница ${i}`;
        div.addEventListener('click', () => {
          renderPDFPage(i);
          $('#side-panel').classList.add('hidden');
        });
        box.appendChild(div);
      }
    } else {
      box.innerHTML = '<div class="empty-side">Оглавление недоступно</div>';
    }
  }

  function renderBookmarksPanel() {
    const box = $('#bookmarks-content');
    const list = getBookmarks(state.currentBook.key || state.currentBook.path);
    box.innerHTML = '';
    if (!list.length) {
      box.innerHTML = '<div class="empty-side">Нет закладок<br>Нажмите 🔖 чтобы добавить</div>';
      return;
    }
    list.slice().reverse().forEach(bm => {
      const div = document.createElement('div');
      div.className = 'bookmark-item';
      const date = new Date(bm.created).toLocaleDateString('ru');
      div.innerHTML = `
        <button class="bm-delete" data-id="${bm.id}">✕</button>
        <div>${escapeHtml(bm.preview || 'Закладка')}...</div>
        ${bm.note ? `<div class="bm-note">${escapeHtml(bm.note)}</div>` : ''}
        <div class="bm-meta">${date} · ${Math.round((bm.percent || 0) * 100)}%</div>`;
      div.addEventListener('click', (e) => {
        if (e.target.classList.contains('bm-delete')) {
          e.stopPropagation();
          const newList = getBookmarks(state.currentBook.key || state.currentBook.path).filter(x => x.id !== bm.id);
          setBookmarks(state.currentBook.key || state.currentBook.path, newList);
          renderBookmarksPanel();
          toast('Закладка удалена');
          return;
        }
        // Jump
        if (state.currentType === 'pdf' && typeof bm.page === 'number') renderPDFPage(bm.page);
        else if (state.currentType === 'epub' && bm.page) state.epubRendition.display(bm.page);
        else if (typeof bm.page === 'number') {
          state.textPage = bm.page;
          renderTextPage();
        }
        $('#side-panel').classList.add('hidden');
      });
      box.appendChild(div);
    });
  }

  // ===== In-book search =====
  $('#search-in-book-btn').addEventListener('click', () => {
    $('#search-overlay').classList.remove('hidden');
    $('#in-book-search').value = '';
    $('#search-results').innerHTML = '';
    setTimeout(() => $('#in-book-search').focus(), 300);
  });
  $('#close-search').addEventListener('click', () => $('#search-overlay').classList.add('hidden'));

  let searchTimeout;
  $('#in-book-search').addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      const q = $('#in-book-search').value.trim().toLowerCase();
      const box = $('#search-results');
      box.innerHTML = '';
      if (q.length < 2) return;

      const source = state.fullText || state.textContent || '';
      if (!source) {
        box.innerHTML = '<div class="empty-side">Поиск доступен для текстовых книг и FB2</div>';
        return;
      }

      const results = [];
      let idx = 0;
      const lower = source.toLowerCase();
      while ((idx = lower.indexOf(q, idx)) !== -1 && results.length < 30) {
        const start = Math.max(0, idx - 40);
        const end = Math.min(source.length, idx + q.length + 40);
        let snippet = source.slice(start, end);
        // highlight
        const re = new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
        snippet = escapeHtml(snippet).replace(re, '<mark>$1</mark>');
        results.push({ idx, snippet });
        idx += q.length;
      }

      if (!results.length) {
        box.innerHTML = '<div class="empty-side">Ничего не найдено</div>';
        return;
      }
      results.forEach(r => {
        const div = document.createElement('div');
        div.className = 'search-result-item';
        div.innerHTML = '...' + r.snippet + '...';
        div.addEventListener('click', () => {
          // Approximate page
          if (['txt', 'html', 'htm', 'fb2'].includes(state.currentType) && state.textPages.length) {
            const pageSize = 2200;
            const page = Math.floor(r.idx / pageSize);
            state.textPage = Math.min(page, state.textPages.length - 1);
            renderTextPage();
          }
          $('#search-overlay').classList.add('hidden');
          toast('Переход к фрагменту');
        });
        box.appendChild(div);
      });
    }, 250);
  });

  // ===== Settings modal =====
  function refreshFavTagsUI() {
    if (!state.currentBook) return;
    const path = state.currentBook.key || state.currentBook.path;
    $('#toggle-favorite').checked = isFavorite(path);
    const tags = getTags(path);
    const box = $('#current-tags');
    box.innerHTML = '';
    tags.forEach(t => {
      const chip = document.createElement('span');
      chip.className = 'tag-chip active';
      chip.innerHTML = escapeHtml(t) + ' <span class="x">×</span>';
      chip.addEventListener('click', () => {
        setTags(path, getTags(path).filter(x => x !== t));
        refreshFavTagsUI();
        toast('Тег удалён');
      });
      box.appendChild(chip);
    });
    // Suggest existing tags
    getAllTags().filter(t => !tags.includes(t)).slice(0, 8).forEach(t => {
      const chip = document.createElement('span');
      chip.className = 'tag-chip';
      chip.textContent = t;
      chip.addEventListener('click', () => {
        setTags(path, [...getTags(path), t]);
        refreshFavTagsUI();
      });
      box.appendChild(chip);
    });
  }

  $('#reader-menu-btn').addEventListener('click', () => {
    refreshFavTagsUI();
    $('#modal-overlay').classList.remove('hidden');
  });

  $('#toggle-favorite').addEventListener('change', () => {
    if (!state.currentBook) return;
    const now = toggleFavorite(state.currentBook.key || state.currentBook.path);
    toast(now ? 'Добавлено в избранное ⭐' : 'Убрано из избранного');
  });

  $('#tag-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && state.currentBook) {
      e.preventDefault();
      const val = $('#tag-input').value.trim();
      if (!val) return;
      const tags = getTags(state.currentBook.key || state.currentBook.path);
      if (!tags.includes(val)) {
        setTags(state.currentBook.key || state.currentBook.path, [...tags, val]);
        refreshFavTagsUI();
        toast('Тег добавлен');
      }
      $('#tag-input').value = '';
    }
  });
  $('#close-modal').addEventListener('click', () => $('#modal-overlay').classList.add('hidden'));
  $('#modal-overlay').addEventListener('click', e => {
    if (e.target === $('#modal-overlay')) $('#modal-overlay').classList.add('hidden');
  });

  $$('.theme-opt').forEach(btn => {
    btn.addEventListener('click', () => applyTheme(btn.dataset.theme));
  });

  $('#font-size').addEventListener('input', e => {
    state.fontSize = parseInt(e.target.value, 10);
    localStorage.setItem('fontSize', state.fontSize);
    $('#font-size-label').textContent = state.fontSize + 'px';
    applyReaderStyles();
  });
  $('#line-height').addEventListener('input', e => {
    state.lineHeight = parseFloat(e.target.value);
    localStorage.setItem('lineHeight', state.lineHeight);
    $('#line-height-label').textContent = state.lineHeight.toFixed(1);
    applyReaderStyles();
  });
  $('#font-family').addEventListener('change', e => {
    state.fontFamily = e.target.value;
    localStorage.setItem('fontFamily', state.fontFamily);
    applyReaderStyles();
  });

  $('#tts-continuous').addEventListener('change', e => { state.continuousTTS = e.target.checked; });
  $('#tts-highlight').addEventListener('change', e => { state.highlightTTS = e.target.checked; });

  let wakeLock = null;
  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch (e) { console.warn('WakeLock', e); }
  }
  function releaseWakeLock() {
    if (wakeLock) { try { wakeLock.release(); } catch (e) {} wakeLock = null; }
  }
  $('#keep-screen-on').addEventListener('change', async (e) => {
    if (e.target.checked) await requestWakeLock();
    else releaseWakeLock();
  });
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && $('#keep-screen-on') && $('#keep-screen-on').checked) {
      await requestWakeLock();
    }
    if (document.visibilityState === 'visible' && synth && state.isSpeaking && synth.paused) {
      try { synth.resume(); } catch (e) {}
    }
  });

  // ===== Stats =====
  $('#stats-btn').addEventListener('click', () => {
    const s = getStats();
    const hours = Math.floor((s.totalMinutes || 0) / 60);
    const mins = Math.round((s.totalMinutes || 0) % 60);
    $('#stats-content').innerHTML = `
      <div class="stat-row"><span>Время чтения</span><span class="stat-value">${hours}ч ${mins}м</span></div>
      <div class="stat-row"><span>Открыто книг</span><span class="stat-value">${s.booksOpened || 0}</span></div>
      <div class="stat-row"><span>Страниц прочитано</span><span class="stat-value">${s.pagesRead || 0}</span></div>
      <div class="stat-row"><span>Книг в библиотеке</span><span class="stat-value">${state.books.length}</span></div>`;
    $('#stats-overlay').classList.remove('hidden');
  });
  $('#close-stats').addEventListener('click', () => $('#stats-overlay').classList.add('hidden'));

  // ===== Back =====
  $('#back-to-library').addEventListener('click', () => {
    // save reading time
    if (state.readingStart) {
      const mins = (Date.now() - state.readingStart) / 60000;
      if (mins > 0.1) addReadingTime(mins);
      state.readingStart = null;
    }
    if (synth) synth.cancel();
    state.isSpeaking = false;
    if (state.epubBook) {
      try { state.epubBook.destroy(); } catch (e) {}
      state.epubBook = null;
      state.epubRendition = null;
    }
    if (state._djvuPoll) {
      clearInterval(state._djvuPoll);
      state._djvuPoll = null;
    }
    djvuViewerInstance = null;
    state.pdfDoc = null;
    releaseWakeLock();
    $('#reader-screen').classList.remove('active');
    $('#library-screen').classList.add('active');
    $('#side-panel').classList.add('hidden');
    renderLibrary($('#search-books').value);
  });

  // Theme toggle
  $('#theme-toggle').addEventListener('click', () => {
    const order = ['dark', 'light', 'sepia'];
    const next = order[(order.indexOf(state.readerTheme) + 1) % 3];
    applyTheme(next);
  });

  // Keyboard
  document.addEventListener('keydown', e => {
    if (!$('#reader-screen').classList.contains('active')) return;
    if (e.key === 'ArrowLeft') goPrev();
    if (e.key === 'ArrowRight') goNext();
    if (e.key === ' ') { e.preventDefault(); $('#tts-play').click(); }
    if (e.key === 'b' || e.key === 'B') $('#bookmark-btn').click();
  });

  // Init
  applyTheme(state.readerTheme);
  $('#font-size').value = state.fontSize;
  $('#font-size-label').textContent = state.fontSize + 'px';
  $('#line-height').value = state.lineHeight;
  $('#line-height-label').textContent = state.lineHeight.toFixed(1);
  $('#font-family').value = state.fontFamily;
  $('#tts-rate').value = state.ttsRate;
  $('#tts-rate-label').textContent = state.ttsRate.toFixed(1) + '×';
  applyReaderStyles();

  console.log('Умный Читатель v2 готов 📚✨');
})();
