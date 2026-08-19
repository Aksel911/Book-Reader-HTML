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
    readingMode: localStorage.getItem('readingMode') || 'scroll-vertical',
    progressCollapsed: localStorage.getItem('progressCollapsed') === 'true',
    ttsCollapsed: localStorage.getItem('ttsCollapsed') === 'true',
    chromeCollapsed: localStorage.getItem('chromeCollapsed') === 'true',
    ttsRate: parseFloat(localStorage.getItem('ttsRate') || '1'),
    ttsPitch: parseFloat(localStorage.getItem('ttsPitch') || '1'),
    ttsPause: parseInt(localStorage.getItem('ttsPause') || '220', 10),
    ttsSmartPause: localStorage.getItem('ttsSmartPause') !== 'false',
    continuousTTS: true,
    highlightTTS: true,
    sleepTimerId: null,
    sleepTimerEnd: null,
    readingStart: null,
    ttsSentences: [],
    ttsSentenceIdx: 0,
    ttsCharOffset: 0,
    ttsPendingResumeOffset: 0,
    ttsSession: 0,
    ttsActive: false,
    ttsPaused: false,
    ttsCurrentVoiceKey: '',
    pendingBookmark: null,
    // Archive navigation
    archiveStack: [],          // [{name, books: [...], path}]
    currentViewBooks: null,    // null = root library
    rootBooks: [],             // original imported files
    folderStack: [],            // actual imported-folder navigation [{name,path}]
    libraryRenderLimit: 60
  };

  // ===== DOM helpers =====
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  // ===== Library loaders (silent; engines preloaded in background) =====
  const _libPromises = {};
  function loadScriptOnce(src) {
    if (_libPromises[src]) return _libPromises[src];
    _libPromises[src] = new Promise((resolve, reject) => {
      // Already present via <script defer> or previous inject?
      const bySrc = document.querySelector(`script[src="${src}"]`);
      if (typeof pdfjsLib !== 'undefined' && src.includes('pdf.min')) return resolve();
      if (typeof ePub !== 'undefined' && src.includes('epub.min')) return resolve();
      if (typeof DjVu !== 'undefined' && src.includes('djvu.js') && !src.includes('viewer')) return resolve();

      const existing = document.querySelector(`script[data-lib="${src}"]`) || bySrc;
      if (existing) {
        if (existing.dataset.loaded === '1') return resolve();
        // defer script may still be loading
        if (existing.async || existing.defer || existing.dataset.lib) {
          existing.addEventListener('load', () => { existing.dataset.loaded = '1'; resolve(); });
          existing.addEventListener('error', () => reject(new Error('Failed: ' + src)));
          // If already complete
          if (existing.dataset.loaded === '1') return resolve();
          // Poll briefly for global (defer can finish without our listener if late)
          let n = 0;
          const timer = setInterval(() => {
            n++;
            if (src.includes('pdf.min') && typeof pdfjsLib !== 'undefined') { clearInterval(timer); resolve(); }
            else if (src.includes('epub.min') && typeof ePub !== 'undefined') { clearInterval(timer); resolve(); }
            else if (n > 100) { clearInterval(timer); reject(new Error('Timeout: ' + src)); }
          }, 50);
          return;
        }
      }
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.dataset.lib = src;
      s.onload = () => { s.dataset.loaded = '1'; resolve(); };
      s.onerror = () => reject(new Error('Не удалось загрузить ' + src));
      document.head.appendChild(s);
    });
    return _libPromises[src];
  }

  function warmFetch(url) {
    // Put file into HTTP cache without executing
    return fetch(url, { credentials: 'same-origin', cache: 'force-cache' }).then(r => r.ok ? r.arrayBuffer() : null).catch(() => null);
  }

  let _workerWarmed = false;
  function warmPdfWorker() {
    if (_workerWarmed) return;
    _workerWarmed = true;
    warmFetch('libs/pdf.worker.min.js');
  }

  async function ensurePDF() {
    // No modal "Загрузка PDF-движка" — openBook already shows "Открываю книгу…"
    if (typeof pdfjsLib === 'undefined') {
      await loadScriptOnce('libs/pdf.min.js');
    }
    if (typeof pdfjsLib === 'undefined') throw new Error('PDF.js не загружен');
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'libs/pdf.worker.min.js';
    warmPdfWorker();
  }
  async function ensureEPUB() {
    if (typeof ePub !== 'undefined') return;
    await loadScriptOnce('libs/epub.min.js');
    if (typeof ePub === 'undefined') throw new Error('epub.js не загружен');
  }
  async function ensureDJVU() {
    if (typeof DjVu !== 'undefined' && DjVu.Viewer) return;
    await loadScriptOnce('libs/djvu.js');
    await loadScriptOnce('libs/djvu_viewer.js');
    if (typeof DjVu === 'undefined' || !DjVu.Viewer) throw new Error('DjVu.js не загружен');
  }

  // Start warming heavy assets as soon as the main thread is free
  function scheduleEngineWarmup() {
    const run = () => {
      warmPdfWorker();
      // If pdf.min not yet there, pull it quietly
      if (typeof pdfjsLib === 'undefined') loadScriptOnce('libs/pdf.min.js').then(() => {
        if (typeof pdfjsLib !== 'undefined') pdfjsLib.GlobalWorkerOptions.workerSrc = 'libs/pdf.worker.min.js';
      }).catch(() => {});
      warmFetch('libs/epub.min.js');
    };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 1500 });
    else setTimeout(run, 400);
  }

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

  // Split text into short, speech-friendly units.
  // Keep paragraph boundaries and sentence punctuation so pauses sound natural in RU/EN.
  function splitSentences(text) {
    if (!text) return [];
    const normalized = String(text)
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/\s+([,.;!?…])/g, '$1')
      .trim();
    const paragraphs = normalized.split(/\n\s*\n/);
    const out = [];
    const rx = /[^.!?…]+(?:[.!?…]+(?=\s|$)|$)/g;
    for (const para of paragraphs) {
      const cleanPara = para.replace(/\s+/g, ' ').trim();
      if (!cleanPara) continue;
      const parts = cleanPara.match(rx) || [cleanPara];
      for (const raw of parts) {
        const s = raw.trim();
        if (!s) continue;
        if (s.length <= 300) out.push(s);
        else {
          // Prefer clause breaks over hard character cuts.
          const clauses = s.split(/(?<=[,;:—–])\s+/);
          let buf = '';
          for (const c of clauses) {
            if (!buf) buf = c;
            else if ((buf + ' ' + c).length <= 300) buf += ' ' + c;
            else { out.push(buf.trim()); buf = c; }
          }
          if (buf) out.push(buf.trim());
        }
      }
      // Paragraph pause marker is stored separately, not pronounced.
      if (out.length) out[out.length - 1] = { text: typeof out[out.length - 1] === 'string' ? out[out.length - 1] : out[out.length - 1].text, paragraphEnd: true };
    }
    return out.map(x => typeof x === 'string' ? { text:x, paragraphEnd:false } : x).filter(x => x.text);
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
    // Keep reading-history progress in sync for the continue panel
    try {
      const hist = loadJSON('readingHistory', []);
      const i = hist.findIndex(x => x.key === path);
      if (i >= 0) {
        hist[i].progress = p;
        saveJSON('readingHistory', hist);
      }
    } catch (e) {}
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
    const metaTheme = document.getElementById('meta-theme-color');
    if (metaTheme) {
      metaTheme.content = theme === 'light' ? '#f7f5f0' : theme === 'sepia' ? '#f1e7d3' : '#0a0a0b';
    }
  }

  function applyReaderStyles() {
    document.documentElement.style.setProperty('--reader-font-size', state.fontSize + 'px');
    document.documentElement.style.setProperty('--reader-line-height', state.lineHeight);
    document.documentElement.style.setProperty('--reader-font-family', state.fontFamily);
    document.documentElement.dataset.readingMode = state.readingMode;
    const el = $('#text-reader');
    if (el) {
      el.style.fontSize = state.fontSize + 'px';
      el.style.lineHeight = state.lineHeight;
      el.style.fontFamily = state.fontFamily;
    }
    $$('.reading-mode-opt').forEach(b => b.classList.toggle('active', b.dataset.readingMode === state.readingMode));
    // Ensure native scrolling behavior matches reading mode
    const rc = $('#reader-content');
    if (rc) {
      if (state.readingMode === 'scroll-vertical') {
        rc.style.touchAction = 'pan-y';
      } else if (state.readingMode === 'scroll-horizontal' || state.readingMode === 'paged') {
        rc.style.touchAction = 'pan-x';
      } else {
        rc.style.touchAction = 'pan-x';
      }
    }
  }

  function applyChromeState() {
    const progressWrap = $('#reading-progress-wrap');
    const bottom = $('#reader-bottom-chrome');
    const pill = $('#show-chrome-pill');
    const ttsBtn = $('#toggle-tts-btn');
    const progBtn = $('#toggle-progress-btn');
    const chromeBtn = $('#toggle-chrome-btn');

    if (progressWrap) {
      progressWrap.classList.toggle('collapsed', state.progressCollapsed || state.chromeCollapsed);
    }
    if (bottom) {
      bottom.classList.toggle('collapsed', state.chromeCollapsed);
      bottom.classList.toggle('tts-collapsed', state.ttsCollapsed && !state.chromeCollapsed);
    }
    if (pill) {
      pill.classList.toggle('hidden', !state.chromeCollapsed);
    }
    if (ttsBtn) {
      ttsBtn.textContent = state.ttsCollapsed ? '▴' : '▾';
      ttsBtn.title = state.ttsCollapsed ? 'Развернуть панель озвучки' : 'Свернуть панель озвучки';
    }
    if (progBtn) {
      progBtn.textContent = state.progressCollapsed ? '▾' : '▴';
      progBtn.title = state.progressCollapsed ? 'Развернуть прогресс' : 'Свернуть прогресс';
    }
    if (chromeBtn) {
      chromeBtn.textContent = state.chromeCollapsed ? '▢' : '▣';
      chromeBtn.title = state.chromeCollapsed ? 'Показать панели' : 'Скрыть панели';
    }
  }

  function setProgressCollapsed(v) {
    state.progressCollapsed = !!v;
    localStorage.setItem('progressCollapsed', state.progressCollapsed);
    applyChromeState();
  }
  function setTtsCollapsed(v) {
    state.ttsCollapsed = !!v;
    localStorage.setItem('ttsCollapsed', state.ttsCollapsed);
    applyChromeState();
  }
  function setChromeCollapsed(v) {
    state.chromeCollapsed = !!v;
    localStorage.setItem('chromeCollapsed', state.chromeCollapsed);
    // When showing all chrome, also expand progress/tts if user wants full UI
    if (!v) {
      // keep individual preferences; only uncollapse the whole chrome
    }
    applyChromeState();
  }

  function isIPhoneLike() {
    // iPhone / iPod; iPad is OK to keep extra modes
    const ua = navigator.userAgent || '';
    if (/iPhone|iPod/i.test(ua)) return true;
    // iPadOS 13+ can report as Mac — treat narrow touch Mac as phone-like
    if (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1 && Math.min(window.innerWidth, window.innerHeight) < 500) return true;
    return false;
  }

  function applyReadingModeAvailability() {
    const phone = isIPhoneLike();
    $$('.reading-mode-opt').forEach(btn => {
      const m = btn.dataset.readingMode;
      const hide = phone && (m === 'scroll-horizontal' || m === 'two-page');
      btn.classList.toggle('hidden', hide);
      btn.style.display = hide ? 'none' : '';
      if (hide) btn.setAttribute('aria-hidden', 'true');
      else btn.removeAttribute('aria-hidden');
    });
    // If current mode is unavailable on iPhone — fall back
    if (phone && (state.readingMode === 'scroll-horizontal' || state.readingMode === 'two-page')) {
      state.readingMode = 'scroll-vertical';
      localStorage.setItem('readingMode', 'scroll-vertical');
      applyReaderStyles();
      $$('.reading-mode-opt').forEach(b => b.classList.toggle('active', b.dataset.readingMode === 'scroll-vertical'));
    }
  }

  async function setReadingMode(mode, rerender = true) {
    const allowed = new Set(['scroll-vertical','paged','scroll-horizontal','two-page']);
    if (!allowed.has(mode)) mode = 'scroll-vertical';
    // iPhone: no horizontal / two-page
    if (isIPhoneLike() && (mode === 'scroll-horizontal' || mode === 'two-page')) {
      mode = 'scroll-vertical';
      toast('На iPhone доступны «Вертикально» и «Страницы»', 1800);
    }
    const prev = state.readingMode;
    state.readingMode = mode;
    localStorage.setItem('readingMode', mode);
    applyReaderStyles();
    // Visual feedback immediately (important on iOS where repaint can lag)
    $$('.reading-mode-opt').forEach(b => b.classList.toggle('active', b.dataset.readingMode === mode));

    if (!rerender || !state.currentType) return;

    try {
      if (['txt','html','htm','fb2'].includes(state.currentType)) {
        // Re-render after layout settles (settings modal may still be closing)
        const doRender = () => {
          renderTextPage(true);
          const el = $('#text-reader');
          const rc = $('#reader-content');
          if (el && rc) {
            void el.offsetHeight;
            void rc.offsetHeight;
            if (mode === 'scroll-horizontal') {
              rc.scrollLeft = 0;
              const track = $('#text-h-track') || el.querySelector('.text-h-track');
              if (track) {
                const w = track.clientWidth || rc.clientWidth || window.innerWidth;
                track.scrollLeft = (state.textPage || 0) * w;
              }
            } else if (mode !== 'scroll-vertical') {
              rc.scrollTop = 0;
            }
          }
        };
        doRender();
        setTimeout(doRender, 50);
        setTimeout(doRender, 200);
      } else if (state.currentType === 'epub' && state.epubBook) {
        const book = state.currentBook;
        let loc = null;
        try {
          loc = state.epubRendition?.currentLocation()?.start?.cfi || localStorage.getItem('epubLoc:' + (book?.key || book?.path));
        } catch (e) {}
        try { state.epubRendition?.destroy(); } catch (e) {}
        state.epubRendition = null;
        const area = $('#epub-area');
        if (area) area.innerHTML = '';
        const flow = state.readingMode === 'scroll-vertical' ? 'scrolled-continuous' : 'paginated';
        const spread = state.readingMode === 'two-page' ? 'always'
          : (state.readingMode === 'scroll-horizontal' ? 'none' : 'auto');
        state.epubRendition = state.epubBook.renderTo(area || $('#reader-content'), {
          width: '100%',
          height: '100%',
          flow,
          manager: state.readingMode === 'scroll-vertical' ? 'continuous' : 'default',
          spread
        });
        try { await state.epubRendition.display(loc || undefined); } catch (e) { console.warn('EPUB mode switch', e); }
        state.epubRendition.on('relocated', (loc2) => {
          try {
            const percent = loc2.start.percentage || 0;
            if (state.currentBook) {
              state.currentBook.progress = percent;
              setProgress(book.key || book.path, percent);
              localStorage.setItem('epubLoc:' + (book.key || book.path), loc2.start.cfi);
            }
            $('#page-num').textContent = Math.round(percent * 100) + '%';
            $('#page-count').textContent = '100%';
            updateProgressBar();
          } catch (e) {}
        });
      } else if (state.currentType === 'pdf' && state.pdfDoc) {
        await renderPDFByMode();
      }
    } catch (e) {
      console.warn('setReadingMode failed', e);
      // Restore previous mode on hard failure
      if (prev && prev !== mode) {
        state.readingMode = prev;
        localStorage.setItem('readingMode', prev);
        applyReaderStyles();
      }
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
    state.folderStack = [];
    state.currentViewBooks = null;
    // Remember catalog (metadata only — File handles cannot survive reload)
    saveLibraryCatalog(books, sourceLabel);
    hideLoading();
    renderLibrary();
    toast(`Найдено: ${books.length} поддерживаемых файлов`);
  }

  // ===== Session history (survives page reload; files must be re-selected) =====
  function saveLibraryCatalog(books, sourceLabel) {
    const catalog = {
      savedAt: Date.now(),
      sourceLabel: sourceLabel || 'файлов',
      count: books.length,
      books: books.slice(0, 500).map(b => ({
        key: b.key || b.path,
        name: b.name,
        path: b.path,
        type: b.type,
        size: b.size || 0,
        isArchive: !!b.isArchive
      }))
    };
    saveJSON('libraryCatalog', catalog);
  }

  function getLibraryCatalog() {
    return loadJSON('libraryCatalog', null);
  }

  function pushReadingHistory(book) {
    if (!book) return;
    const key = book.key || book.path;
    const list = loadJSON('readingHistory', []);
    const entry = {
      key,
      name: book.name,
      path: book.path,
      type: book.type,
      progress: typeof book.progress === 'number' ? book.progress : (getProgress(key) || 0),
      openedAt: Date.now()
    };
    const filtered = list.filter(x => x.key !== key);
    filtered.unshift(entry);
    saveJSON('readingHistory', filtered.slice(0, 40));
  }

  function getReadingHistory() {
    return loadJSON('readingHistory', []);
  }

  function clearSessionHistory() {
    try {
      localStorage.removeItem('libraryCatalog');
      localStorage.removeItem('readingHistory');
      // keep progress/favorites/bookmarks — only clear "session hint"
    } catch (e) {}
    renderContinueSession();
    toast('История сессий очищена (прогресс книг сохранён)');
  }

  // ===== Library deduplication (in-app only; never deletes disk files) =====
  const DUPLICATE_NAME_RE = /(?:\s*[-_.]?\s*copy(?:\s*\(\d+\))?|\s*[-_.]?\s*duplicate(?:\s*\(\d+\))?|\s*\(\s*copy\s*\)|\s*\(\s*\d+\s*\)|\s*[-_.]\s*copy\s*\d*|\s*[-_.]\s*dup(?:licate)?\s*\d*)$/i;

  function filenameQuality(book) {
    const name = (book.name || book.path || '').replace(/\.[^.]+$/, '');
    let score = 100;
    if (DUPLICATE_NAME_RE.test(name)) score -= 25;
    if (/\b(copy|duplicate|dup)\b/i.test(name)) score -= 20;
    if (/\(\d+\)$/.test(name)) score -= 15;
    if (/^(untitled|document|file|scan|book)\s*\d*$/i.test(name.trim())) score -= 18;
    const alnum = (name.match(/[\p{L}\p{N}]/gu) || []).length;
    if (alnum >= 10) score += 12;
    if (name.length < 3) score -= 20;
    // Prefer files with more progress / favorites
    const key = book.key || book.path;
    if (isFavorite(key)) score += 8;
    score += Math.round((book.progress || getProgress(key) || 0) * 10);
    // Prefer shallower paths
    score -= (String(book.path || '').split('/').length) * 0.5;
    return score;
  }

  function normalizeSemanticText(text) {
    let t = String(text || '');
    try { t = t.replace(/&[a-z]+;/gi, ' '); } catch (_) {}
    t = t.toLowerCase().replace(/[\u200b-\u200f\u202a-\u202e\ufeff]/g, '');
    t = t.replace(/\s+/g, ' ').trim();
    return t;
  }

  function textFingerprint(text) {
    const normalized = normalizeSemanticText(text);
    if (normalized.length < 200) return null;
    const tokens = normalized.match(/[0-9a-zа-яё]+/gi) || [];
    const tokenText = tokens.join(' ');
    if (tokenText.length < 200) return null;
    return { digest: simpleHash(tokenText), length: tokenText.length };
  }

  function simpleHash(str) {
    // FNV-1a 64-bit-ish hex for fast client-side fingerprinting
    let h1 = 0x811c9dc5, h2 = 0x811c9dc5 ^ 0xabcdef;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193);
      h2 = Math.imul(h2 ^ c, 0x01000193) ^ (h1 >>> 16);
    }
    return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
  }

  async function sha256Buffer(buf) {
    if (crypto?.subtle?.digest) {
      const hash = await crypto.subtle.digest('SHA-256', buf);
      return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
    }
    // Fallback: sample-based hash for huge files if SubtleCrypto missing
    const u8 = new Uint8Array(buf);
    let s = u8.length + ':';
    const step = Math.max(1, Math.floor(u8.length / 64));
    for (let i = 0; i < u8.length; i += step) s += u8[i] + ',';
    return simpleHash(s);
  }

  async function extractBookTextSample(book) {
    if (!book?.file) return null;
    const type = (book.type || '').toLowerCase();
    try {
      if (['txt', 'html', 'htm', 'fb2', 'md', 'csv', 'json'].includes(type)) {
        const text = await book.file.text();
        return text.slice(0, 400000);
      }
      if (type === 'epub' && typeof JSZip !== 'undefined') {
        const buf = await book.file.arrayBuffer();
        const zip = await JSZip.loadAsync(buf);
        const parts = [];
        const names = Object.keys(zip.files).filter(n => /\.(xhtml|html|htm|xml)$/i.test(n)).slice(0, 40);
        for (const n of names) {
          try {
            let raw = await zip.files[n].async('string');
            raw = raw.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
              .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
              .replace(/<[^>]+>/g, ' ');
            parts.push(raw);
            if (parts.join(' ').length > 300000) break;
          } catch (_) {}
        }
        return parts.join('\n');
      }
      // PDF: first few pages via pdf.js if loaded
      if (type === 'pdf' && typeof pdfjsLib !== 'undefined') {
        const buf = await book.file.arrayBuffer();
        const doc = await pdfjsLib.getDocument({ data: buf }).promise;
        const max = Math.min(doc.numPages, 8);
        const parts = [];
        for (let i = 1; i <= max; i++) {
          const page = await doc.getPage(i);
          const tc = await page.getTextContent();
          parts.push(tc.items.map(it => it.str).join(' '));
        }
        try { doc.destroy?.(); } catch (_) {}
        return parts.join('\n');
      }
    } catch (e) {
      console.debug('extractBookTextSample', book.name, e);
    }
    return null;
  }

  async function findAndRemoveDuplicates() {
    const books = (state.rootBooks || state.books || []).filter(b => b && b.file && !b.fromArchive);
    if (books.length < 2) {
      toast('Сначала загрузите библиотеку (2+ книги)');
      return { removed: 0, groups: 0 };
    }

    showLoading('Ищу дубликаты…');
    const resultEl = $('#dedupe-result');
    if (resultEl) resultEl.textContent = 'Сканирование…';

    const toRemove = new Set(); // keys
    const keepMap = new Map(); // key -> book kept
    let groups = 0;

    // 1) Exact SHA-256 (group by size first for speed)
    const bySize = new Map();
    for (const b of books) {
      const sz = b.size || b.file?.size || 0;
      if (!bySize.has(sz)) bySize.set(sz, []);
      bySize.get(sz).push(b);
    }
    for (const [, list] of bySize) {
      if (list.length < 2) continue;
      const byHash = new Map();
      for (const b of list) {
        try {
          const buf = await b.file.arrayBuffer();
          const h = await sha256Buffer(buf);
          if (!byHash.has(h)) byHash.set(h, []);
          byHash.get(h).push(b);
        } catch (e) {
          console.debug('hash fail', b.name, e);
        }
      }
      for (const group of byHash.values()) {
        if (group.length < 2) continue;
        groups++;
        group.sort((a, b) => filenameQuality(b) - filenameQuality(a));
        const keep = group[0];
        keepMap.set(keep.key || keep.path, keep);
        for (let i = 1; i < group.length; i++) toRemove.add(group[i].key || group[i].path);
      }
    }

    // 2) Smart semantic (text formats + epub + pdf sample)
    const remaining = books.filter(b => !toRemove.has(b.key || b.path));
    const smartBuckets = new Map();
    for (let i = 0; i < remaining.length; i++) {
      const b = remaining[i];
      if (i % 8 === 0) {
        showLoading(`Умный поиск… ${i + 1}/${remaining.length}`);
        await new Promise(r => setTimeout(r, 0)); // yield UI
      }
      const size = b.size || b.file?.size || 0;
      if (size < 2000) continue;
      const type = (b.type || '').toLowerCase();
      if (!['txt', 'html', 'htm', 'fb2', 'epub', 'pdf', 'md'].includes(type)) continue;
      try {
        const text = await extractBookTextSample(b);
        const fp = text ? textFingerprint(text) : null;
        if (!fp) continue;
        const bucketKey = fp.digest + ':' + Math.round(fp.length / 50);
        if (!smartBuckets.has(bucketKey)) smartBuckets.set(bucketKey, []);
        smartBuckets.get(bucketKey).push({ book: b, length: fp.length });
      } catch (_) {}
    }
    for (const items of smartBuckets.values()) {
      if (items.length < 2) continue;
      // length within 1%
      const base = items[0].length;
      const matched = items.filter(x => {
        const mx = Math.max(base, x.length);
        return mx && Math.abs(base - x.length) / mx <= 0.02;
      });
      if (matched.length < 2) continue;
      const group = matched.map(x => x.book);
      // skip if already exact-dup handled
      const fresh = group.filter(b => !toRemove.has(b.key || b.path));
      if (fresh.length < 2) continue;
      groups++;
      fresh.sort((a, b) => filenameQuality(b) - filenameQuality(a));
      for (let i = 1; i < fresh.length; i++) toRemove.add(fresh[i].key || fresh[i].path);
    }

    // Apply removal from in-memory library only
    if (toRemove.size) {
      const filterOut = (arr) => (arr || []).filter(b => !toRemove.has(b.key || b.path));
      state.books = filterOut(state.books);
      state.rootBooks = filterOut(state.rootBooks);
      if (state.currentViewBooks) state.currentViewBooks = filterOut(state.currentViewBooks);
      saveLibraryCatalog(state.rootBooks || state.books, 'после очистки дубликатов');
      renderLibrary($('#search-books')?.value || '');
    }

    hideLoading();
    const msg = toRemove.size
      ? `Убрано дубликатов: ${toRemove.size} (групп: ${groups}). Файлы на диске не удалялись.`
      : 'Дубликатов не найдено';
    if (resultEl) resultEl.textContent = msg;
    toast(msg);
    return { removed: toRemove.size, groups };
  }

  function formatRelativeTime(ts) {
    if (!ts) return '';
    const diff = Date.now() - ts;
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'только что';
    if (m < 60) return m + ' мин назад';
    const h = Math.floor(m / 60);
    if (h < 24) return h + ' ч назад';
    const d = Math.floor(h / 24);
    if (d < 14) return d + ' дн. назад';
    return new Date(ts).toLocaleDateString('ru');
  }

  function renderContinueSession() {
    const box = $('#continue-session');
    if (!box) return;
    const rawCatalog = getLibraryCatalog();
    const catalog = (rawCatalog && rawCatalog.count > 0) ? rawCatalog : null;
    const history = getReadingHistory();
    const recents = loadJSON('recentBooks', {});
    const recentKeys = Object.keys(recents).sort((a, b) => (recents[b] || 0) - (recents[a] || 0));

    if (!catalog && !history.length && !recentKeys.length) {
      box.classList.add('hidden');
      return;
    }
    box.classList.remove('hidden');

    const summary = $('#continue-summary');
    if (summary) {
      if (catalog && catalog.count) {
        const when = formatRelativeTime(catalog.savedAt);
        summary.innerHTML = `
          <div class="continue-stat">
            <strong>${catalog.count}</strong>
            <span>книг в прошлой сессии</span>
          </div>
          <div class="continue-meta">Обновлено ${when || 'ранее'} · ${escapeHtml(catalog.sourceLabel || 'файлы')}</div>`;
      } else {
        summary.innerHTML = `<div class="continue-meta">Есть сохранённый прогресс чтения. Откройте папку или файлы, чтобы продолжить.</div>`;
      }
    }

    const listEl = $('#continue-recent-list');
    if (listEl) {
      listEl.innerHTML = '';
      // Prefer explicit reading history; fall back to recentBooks keys + catalog names
      let items = history.slice(0, 8);
      if (!items.length && catalog && catalog.books) {
        items = recentKeys.slice(0, 8).map(key => {
          const meta = catalog.books.find(b => b.key === key || b.path === key) || { key, name: key.split('/').pop(), path: key, type: '' };
          return {
            key,
            name: meta.name || key,
            path: meta.path || key,
            type: meta.type || '',
            progress: getProgress(key) || 0,
            openedAt: recents[key]
          };
        });
      }
      if (!items.length) {
        listEl.innerHTML = '<div class="continue-empty">Пока нет открытых книг — после чтения они появятся здесь</div>';
      } else {
        items.forEach(item => {
          const pct = Math.round((item.progress || getProgress(item.key) || 0) * 100);
          const row = document.createElement('div');
          row.className = 'continue-row';
          row.innerHTML = `
            <div class="continue-row-main">
              <span class="continue-row-name">${escapeHtml(item.name || 'Книга')}</span>
              <span class="continue-row-meta">${escapeHtml((item.type || '').toUpperCase())}${item.openedAt ? ' · ' + formatRelativeTime(item.openedAt) : ''}</span>
            </div>
            <div class="continue-row-prog">
              <div class="continue-row-bar"><i style="width:${Math.min(100, pct)}%"></i></div>
              <span>${pct}%</span>
            </div>`;
          listEl.appendChild(row);
        });
      }
    }
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

  function normalizePath(path) {
    return String(path || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  }

  function getFolderPrefix() {
    return state.folderStack.length ? state.folderStack[state.folderStack.length - 1].path : '';
  }

  function getFolderItems(books) {
    const prefix = getFolderPrefix();
    const folders = new Map();
    const files = [];
    for (const book of books) {
      const path = normalizePath(book.path);
      if (prefix && !(path === prefix || path.startsWith(prefix + '/'))) continue;
      const rest = prefix ? path.slice(prefix.length).replace(/^\//, '') : path;
      if (!rest) continue;
      const parts = rest.split('/');
      if (parts.length > 1) {
        const folderName = parts[0];
        const folderPath = prefix ? `${prefix}/${folderName}` : folderName;
        if (!folders.has(folderPath)) folders.set(folderPath, { type:'folder', name:folderName, path:folderPath, count:0 });
        folders.get(folderPath).count++;
      } else {
        files.push(book);
      }
    }
    return { folders:[...folders.values()].sort((a,b)=>a.name.localeCompare(b.name,'ru')), files };
  }

  function renderFolderBreadcrumb() {
    const el = $('#folder-breadcrumb');
    if (!el) return;
    if (!state.folderStack.length) { el.classList.add('hidden'); el.innerHTML=''; return; }
    el.classList.remove('hidden');
    let html = '<button class="folder-crumb root" data-level="-1">⌂ Библиотека</button>';
    state.folderStack.forEach((f,i)=> {
      html += '<span class="folder-sep">/</span>';
      html += `<button class="folder-crumb ${i===state.folderStack.length-1?'current':''}" data-level="${i}">${escapeHtml(f.name)}</button>`;
    });
    el.innerHTML=html;
    el.querySelectorAll('.folder-crumb').forEach(btn=>btn.addEventListener('click',()=>{
      const level=Number(btn.dataset.level);
      if(level<0) state.folderStack=[]; else state.folderStack=state.folderStack.slice(0,level+1);
      renderLibrary($('#search-books').value);
    }));
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

  // ---- Low-cost, lazy PDF previews ----
  // Only a tiny number of pages are rendered at once. Preview JPEGs are cached in IndexedDB
  // so reopening a 474-book library does not re-render every PDF.
  const PREVIEW_CACHE = new Map();
  const PREVIEW_PENDING = new Set();
  const PREVIEW_QUEUE = [];
  let previewWorkers = 0;
  const PREVIEW_CONCURRENCY = 1;
  const PREVIEW_MAX_WIDTH = 112;
  let previewObserver = null;
  let previewDBPromise = null;

  function openPreviewDB() {
    if (!('indexedDB' in window)) return Promise.resolve(null);
    if (previewDBPromise) return previewDBPromise;
    previewDBPromise = new Promise(resolve => {
      const req = indexedDB.open('book-reader-previews', 1);
      req.onupgradeneeded = () => {
        try { req.result.createObjectStore('covers'); } catch (e) {}
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
    return previewDBPromise;
  }
  function previewDBKey(book) { return `${book.key || book.path}::${book.size || 0}::${book.modified || 0}`; }
  async function getCachedPreview(book) {
    const key = previewDBKey(book);
    if (PREVIEW_CACHE.has(key)) return PREVIEW_CACHE.get(key);
    const db = await openPreviewDB();
    if (!db) return null;
    return new Promise(resolve => {
      try {
        const req = db.transaction('covers','readonly').objectStore('covers').get(key);
        req.onsuccess = () => { if (req.result) PREVIEW_CACHE.set(key, req.result); resolve(req.result || null); };
        req.onerror = () => resolve(null);
      } catch (e) { resolve(null); }
    });
  }
  async function setCachedPreview(book, blob) {
    const key = previewDBKey(book);
    PREVIEW_CACHE.set(key, blob);
    const db = await openPreviewDB();
    if (!db) return;
    try {
      db.transaction('covers','readwrite').objectStore('covers').put(blob, key);
    } catch (e) {}
  }
  async function drainPreviewQueue() {
    while (previewWorkers < PREVIEW_CONCURRENCY && PREVIEW_QUEUE.length) {
      const job = PREVIEW_QUEUE.shift();
      previewWorkers++;
      try { await hydratePreviewNow(job.book, job.card); } catch (e) {}
      previewWorkers--;
      if (PREVIEW_QUEUE.length) drainPreviewQueue();
    }
  }
  async function hydratePreviewNow(book, card) {
    if (!card.isConnected) return;
    const host = card.querySelector('.book-cover');
    if (!host) return;
    const cached = await getCachedPreview(book);
    if (cached) {
      const url = URL.createObjectURL(cached);
      host.classList.add('has-preview');
      host.style.backgroundImage = `linear-gradient(180deg,rgba(4,4,6,.02),rgba(4,4,6,.50)),url(${url})`;
      host.dataset.previewUrl = url;
      return;
    }
    try { await ensurePDF(); } catch (e) { return; }
    if (!window.pdfjsLib) return;
    const buf = await book.file.arrayBuffer();
    const doc = await pdfjsLib.getDocument({data:buf, disableAutoFetch:true, disableStream:true}).promise;
    try {
      const page = await doc.getPage(1);
      const base = page.getViewport({scale:1});
      const targetWidth = PREVIEW_MAX_WIDTH;
      const scale = Math.min(0.36, targetWidth / Math.max(1, base.width));
      const vp = page.getViewport({scale});
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
      await page.render({canvasContext:canvas.getContext('2d',{alpha:false}), viewport:vp}).promise;
      const blob = await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',0.62));
      if (!blob) return;
      await setCachedPreview(book, blob);
      if (card.isConnected) {
        const url = URL.createObjectURL(blob);
        host.classList.add('has-preview');
        host.style.backgroundImage = `linear-gradient(180deg,rgba(4,4,6,.02),rgba(4,4,6,.50)),url(${url})`;
        host.dataset.previewUrl = url;
      }
      canvas.width=1; canvas.height=1;
    } finally { if (doc.destroy) await doc.destroy(); }
  }
  function queuePreview(book, card) {
    if (book.type !== 'pdf' || PREVIEW_PENDING.has(book.key||book.path)) return;
    PREVIEW_PENDING.add(book.key||book.path);
    PREVIEW_QUEUE.push({book,card});
    drainPreviewQueue().finally(()=>PREVIEW_PENDING.delete(book.key||book.path));
  }
  function observePreview(card, book) {
    if (book.type !== 'pdf') return;
    if (!previewObserver) {
      previewObserver = new IntersectionObserver(entries=>entries.forEach(entry=>{
        if (!entry.isIntersecting) return;
        previewObserver.unobserve(entry.target);
        const key=entry.target.dataset.previewKey;
        const source=(state.rootBooks||state.books).find(b=>(b.key||b.path)===key) || getCurrentBooks().find(b=>(b.key||b.path)===key);
        if(source) {
          const run = () => queuePreview(source, entry.target);
          if (window.requestIdleCallback) requestIdleCallback(run, {timeout: 900});
          else setTimeout(run, 120);
        }
      }), {rootMargin:'100px 0px', threshold:0.01});
    }
    card.dataset.previewKey=book.key||book.path;
    previewObserver.observe(card);
  }

  function getBookStatus(book) {
    const p = Number(book.progress || 0);
    if (p >= 0.98) return 'finished';
    if (p > 0.01) return 'reading';
    return 'unread';
  }

  function typeLabel(type) {
    const m = { pdf:'PDF', epub:'EPUB', fb2:'FB2', djvu:'DJVU', djv:'DJVU', txt:'TXT', html:'HTML', htm:'HTML', zip:'ZIP', rar:'RAR' };
    return m[type] || type.toUpperCase();
  }

  function bookCoverMarkup(book) {
    const title = escapeHtml(book.name || 'Без названия');
    const ext = typeLabel(book.type);
    const initials = escapeHtml((book.name || 'Book').split(/\s+/).slice(0,2).map(x => x[0] || '').join('').toUpperCase().slice(0,2));
    return `<div class="book-cover book-cover-${escapeHtml(book.type)}" data-book-key="${escapeHtml(book.key || book.path)}">
      <div class="cover-noise"></div>
      <div class="cover-spine"></div>
      <div class="cover-top"><span class="cover-format">${ext}</span></div>
      <div class="cover-center"><div class="cover-initials">${initials || 'BK'}</div><div class="cover-mini-title">${title}</div></div>
      <div class="cover-bottom"><span>LOCAL LIBRARY</span><span>OFFLINE</span></div>
    </div>`;
  }

  let loadMoreObserver = null;
  function renderLibrary(filter = '') {
    $('#welcome-card').classList.add('hidden');
    $('#library-content').classList.remove('hidden');
    $('#library-toolbar').classList.remove('hidden');
    renderFolderBreadcrumb();
    if (!state.archiveStack.length) { $('#archive-breadcrumb').classList.add('hidden'); } else { renderBreadcrumb(); }
    const source = getCurrentBooks();
    const q = filter.trim().toLowerCase();
    const type = $('#filter-type').value;
    const status = $('#filter-status').value;
    const folderView = !state.archiveStack.length && !state.currentViewBooks;
    const folderData = folderView && !q ? getFolderItems(source) : {folders:[], files:source};
    let list = folderData.files.filter(b => {
      const matchesQ=!q || b.name.toLowerCase().includes(q) || (b.path||'').toLowerCase().includes(q);
      const matchesType=type==='all' || (type==='archive'?b.isArchive:(b.type===type || (type==='djvu'&&b.type==='djv') || (type==='html'&&b.type==='htm')));
      const s=getBookStatus(b);
      const matchesStatus=status==='all' || (status==='favorites'?isFavorite(b.key||b.path):s===status);
      return matchesQ&&matchesType&&matchesStatus;
    });
    const sort=$('#sort-books').value;
    if(sort==='name') list.sort((a,b)=>a.name.localeCompare(b.name,'ru'));
    else if(sort==='progress') list.sort((a,b)=>(b.progress||0)-(a.progress||0));
    else if(sort==='type') list.sort((a,b)=>typeLabel(a.type).localeCompare(typeLabel(b.type))||a.name.localeCompare(b.name,'ru'));
    else if(sort==='recent') list.sort((a,b)=>(b.lastOpened||0)-(a.lastOpened||0));
    else if(sort==='size') list.sort((a,b)=>(b.size||0)-(a.size||0));

    const rootFiles=(state.rootBooks||state.books).length;
    const visibleFolders=folderData.folders.filter(f=>!q || f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q));
    $('#library-stats').textContent=`${state.folderStack.length?'В папке: ':''}${visibleFolders.length+list.length} элементов`;
    $('#hero-book-count').textContent=state.folderStack.length?`${list.length}`:rootFiles;
    $('#library-heading').textContent=state.folderStack.length?state.folderStack[state.folderStack.length-1].name:'Ваша библиотека';
    $('#library-subheading').textContent=state.folderStack.length?'Книги и подпапки внутри этой папки':'Книги сгруппированы по папкам — откройте папку, чтобы увидеть содержимое';

    const chipBox=$('#filter-chips'); chipBox.innerHTML='';
    const active=[];
    if(q) active.push(`Поиск: ${filter}`);
    if(type!=='all') active.push(type==='archive'?'Архивы':typeLabel(type));
    if(status!=='all') active.push(status==='favorites'?'Избранное':status==='reading'?'В процессе':status==='finished'?'Прочитано':'Не начато');
    active.forEach(t=>{const c=document.createElement('span');c.className='filter-chip';c.textContent=t;chipBox.appendChild(c);});

    const grid=$('#books-grid');
    grid.querySelectorAll('.book-cover[data-preview-url]').forEach(host => { try { URL.revokeObjectURL(host.dataset.previewUrl); } catch(e) {} });
    grid.innerHTML='';
    if(!visibleFolders.length && !list.length){
      grid.innerHTML=`<div class="empty-library"><div class="empty-icon">⌕</div><h3>Ничего не найдено</h3><p>Измените поиск или фильтры, либо добавьте ещё книги.</p></div>`;
      return;
    }
    // Folders are always rendered first and cost almost nothing.
    for(const folder of visibleFolders){
      const card=document.createElement('article');
      card.className='folder-card';
      card.title = folder.path;
      card.innerHTML=`<div class="folder-icon">▱</div><div class="folder-card-body"><div class="folder-name" title="${escapeHtml(folder.path)}">${escapeHtml(folder.name)}</div><div class="folder-meta">${folder.count} ${folder.count===1?'файл':'файлов'} · ${escapeHtml(folder.path)}</div></div><div class="folder-arrow">›</div>`;
      card.addEventListener('click',()=>{ state.folderStack.push({name:folder.name,path:folder.path}); renderLibrary($('#search-books').value); });
      grid.appendChild(card);
    }

    const initialLimit = window.innerWidth >= 900 ? 36 : 48;
    state.libraryRenderLimit=Math.max(initialLimit,state.libraryRenderLimit||initialLimit);
    const renderSlice=()=>{
      const oldMore=grid.querySelector('.books-load-more'); if(oldMore) oldMore.remove();
      const end=Math.min(state.libraryRenderLimit,list.length);
      for(const book of list.slice(0,end)){
        const key=book.key||book.path; const card=document.createElement('article'); const st=getBookStatus(book);
        card.className=`book-card status-${st}`+(getBookmarks(key).length?' has-bookmark':'');
        const fav=isFavorite(key); const tags=getTags(key); const progress=Math.min(100,Math.round((book.progress||0)*100));
        card.innerHTML=`<button type="button" class="fav-star" title="${fav?'Убрать из избранного':'В избранное'}">${fav?'★':'☆'}</button>${bookCoverMarkup(book)}<div class="book-info"><div class="book-name" title="${escapeHtml(book.name)}">${escapeHtml(book.name)}</div><div class="book-meta"><span>${typeLabel(book.type)}</span><span>•</span><span>${formatSize(book.size||0)}</span></div>${book.path&&book.path.includes('/')?`<div class="book-path" title="${escapeHtml(book.path)}">${escapeHtml(book.path)}</div>`:''}${tags.length?`<div class="book-tags">${tags.slice(0,2).map(t=>`<span class="book-tag">${escapeHtml(t)}</span>`).join('')}</div>`:''}<div class="book-progress"><div class="book-progress-bar" style="width:${progress}%"></div></div></div>`;
        card.querySelector('.fav-star').addEventListener('click',e=>{e.stopPropagation();toggleFavorite(key);renderLibrary($('#search-books').value);});
        card.addEventListener('click',()=>openBook(book)); grid.appendChild(card); observePreview(card,book);
      }
      if(end<list.length){
        const sentinel=document.createElement('div'); sentinel.className='books-load-more'; sentinel.innerHTML=`<button type="button">Показать ещё · ${Math.min(60,list.length-end)} книг</button>`; grid.appendChild(sentinel);
        sentinel.querySelector('button').addEventListener('click',()=>{state.libraryRenderLimit+=60;renderSlice();});
      }
    };
    renderSlice();
  }

  $('#search-books').addEventListener('input', () => renderLibrary($('#search-books').value));
  $('#sort-books').addEventListener('change', () => renderLibrary($('#search-books').value));
  $('#filter-type').addEventListener('change', () => renderLibrary($('#search-books').value));
  $('#filter-status').addEventListener('change', () => renderLibrary($('#search-books').value));
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
    pushReadingHistory(book);
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
    await ensureDJVU();

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
    await ensurePDF();
    const buf = await book.file.arrayBuffer();
    state.pdfDoc = await pdfjsLib.getDocument({ data: buf }).promise;
    state.pdfTotal = state.pdfDoc.numPages;
    state.pdfPage = Math.max(1, Math.min(state.pdfTotal, Math.round(book.progress * state.pdfTotal) || 1));
    $('#reader-content').innerHTML = '<div id="pdf-viewer"></div>';
    $('#page-count').textContent = state.pdfTotal;
    await renderPDFByMode();
  }

  function isPdfContinuous() {
    return state.readingMode === 'scroll-vertical' || state.readingMode === 'scroll-horizontal';
  }

  async function renderPDFByMode() {
    if (!state.pdfDoc) return;
    if (isPdfContinuous()) await renderPDFContinuous();
    else await renderPDFPage(state.pdfPage);
  }

  async function paintPdfPageToWrap(num, containerWidth) {
    const page = await state.pdfDoc.getPage(num);
    const dpr = Math.min(Math.max(window.devicePixelRatio || 1, 1), 3);
    const baseVp = page.getViewport({ scale: 1 });
    const cssScale = Math.min(3.0, containerWidth / Math.max(1, baseVp.width));
    const viewport = page.getViewport({ scale: cssScale });

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { alpha: false });
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = Math.floor(viewport.width) + 'px';
    canvas.style.height = Math.floor(viewport.height) + 'px';
    canvas.style.imageRendering = '-webkit-optimize-contrast';

    const pageWrap = document.createElement('div');
    pageWrap.className = 'pdf-page-wrap';
    pageWrap.dataset.pageNum = String(num);
    pageWrap.style.width = Math.floor(viewport.width) + 'px';
    pageWrap.style.height = Math.floor(viewport.height) + 'px';
    pageWrap.appendChild(canvas);

    if (dpr !== 1) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    await page.render({ canvasContext: ctx, viewport, intent: 'display' }).promise;

    // Text layer only for the active/current page to keep continuous mode light
    if (num === state.pdfPage) {
      try {
        const tc = await page.getTextContent();
        const textLayer = document.createElement('div');
        textLayer.id = 'pdf-text-layer';
        textLayer.className = 'pdf-text-layer';
        pageWrap.appendChild(textLayer);
        if (pdfjsLib.renderTextLayer) {
          const task = pdfjsLib.renderTextLayer({ textContentSource: tc, container: textLayer, viewport });
          if (task?.promise) await task.promise;
        }
        const pageText = tc.items.map(i => i.str).join(' ');
        state.textContent = pageText;
        state.fullText = pageText;
        if (pageText.length > 40) state.detectedLang = detectLanguage(pageText);
      } catch (e) { console.debug('PDF text layer', e); }
    }
    return pageWrap;
  }

  async function renderPDFPage(num) {
    if (!state.pdfDoc) return;
    state.pdfPage = num;
    $('#page-num').textContent = num;
    $('#page-count').textContent = state.pdfTotal;
    const container = $('#reader-content');
    const containerWidth = Math.max(280, (container?.clientWidth || window.innerWidth) - 20);
    const viewer = $('#pdf-viewer');
    if (!viewer) return;
    viewer.className = 'pdf-viewer pdf-viewer-paged';
    viewer.innerHTML = '';
    const wrap = await paintPdfPageToWrap(num, containerWidth);
    viewer.appendChild(wrap);

    const prog = num / state.pdfTotal;
    if (state.currentBook) {
      state.currentBook.progress = prog;
      setProgress(state.currentBook.key || state.currentBook.path, prog);
    }
    updateProgressBar();
    incStat('pagesRead');
  }

  async function renderPDFContinuous() {
    if (!state.pdfDoc) return;
    const viewer = $('#pdf-viewer');
    if (!viewer) return;
    const container = $('#reader-content');
    const containerWidth = Math.max(280, (container?.clientWidth || window.innerWidth) - 20);
    const horizontal = state.readingMode === 'scroll-horizontal';

    viewer.className = horizontal ? 'pdf-viewer pdf-viewer-horizontal' : 'pdf-viewer pdf-viewer-continuous';
    viewer.innerHTML = '';

    // Horizontal PDF: scroll the content area, not overflow:hidden from text mode CSS
    if (container) {
      if (horizontal) {
        container.style.overflowX = 'auto';
        container.style.overflowY = 'hidden';
        container.style.webkitOverflowScrolling = 'touch';
      } else {
        container.style.overflowX = '';
        container.style.overflowY = '';
      }
    }

    // Placeholders first for fast layout, then paint nearby pages
    const placeholders = [];
    for (let n = 1; n <= state.pdfTotal; n++) {
      const ph = document.createElement('div');
      ph.className = 'pdf-page-placeholder';
      ph.dataset.pageNum = String(n);
      if (horizontal) {
        ph.style.minWidth = Math.min(containerWidth, window.innerWidth - 24) + 'px';
        ph.style.width = Math.min(containerWidth, window.innerWidth - 24) + 'px';
        ph.style.minHeight = '70vh';
        ph.style.flex = '0 0 auto';
      } else {
        ph.style.minHeight = '40vh';
      }
      ph.innerHTML = `<span class="pdf-ph-label">${n}</span>`;
      viewer.appendChild(ph);
      placeholders.push(ph);
    }

    const rendered = new Set();
    const renderOne = async (n) => {
      if (rendered.has(n) || n < 1 || n > state.pdfTotal) return;
      rendered.add(n);
      const ph = viewer.querySelector(`.pdf-page-placeholder[data-page-num="${n}"]`);
      if (!ph) return;
      try {
        const wrap = await paintPdfPageToWrap(n, containerWidth);
        ph.replaceWith(wrap);
      } catch (e) {
        rendered.delete(n);
        console.warn('PDF page', n, e);
      }
    };

    // Initial: current page ± 2
    const start = Math.max(1, state.pdfPage - 1);
    const end = Math.min(state.pdfTotal, state.pdfPage + 2);
    for (let n = start; n <= end; n++) await renderOne(n);

    // Scroll to current page
    requestAnimationFrame(() => {
      const target = viewer.querySelector(`[data-page-num="${state.pdfPage}"]`);
      if (target) target.scrollIntoView({ block: horizontal ? 'nearest' : 'start', inline: horizontal ? 'start' : 'nearest', behavior: 'auto' });
    });

    // Lazy render on scroll
    if (state._pdfIO) { try { state._pdfIO.disconnect(); } catch (e) {} }
    state._pdfIO = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        const n = parseInt(entry.target.dataset.pageNum, 10);
        if (n) {
          renderOne(n);
          // update current page indicator
          state.pdfPage = n;
          $('#page-num').textContent = n;
          if (state.currentBook) {
            const prog = n / state.pdfTotal;
            state.currentBook.progress = prog;
            setProgress(state.currentBook.key || state.currentBook.path, prog);
          }
          updateProgressBar();
        }
      });
    }, { root: container, rootMargin: '200px 100px', threshold: 0.15 });

    viewer.querySelectorAll('[data-page-num]').forEach(el => state._pdfIO.observe(el));
    $('#page-num').textContent = state.pdfPage;
    $('#page-count').textContent = state.pdfTotal;
    updateProgressBar();
    // Expose renderOne for navigation fallback when page not yet rendered
    state._pdfRenderOne = renderOne;
  }

  // ===== EPUB =====
  async function openEPUB(book) {
    await ensureEPUB();
    const buf = await book.file.arrayBuffer();
    state.epubBook = ePub(buf);
    await state.epubBook.ready;

    $('#reader-content').innerHTML = '<div id="epub-area"></div>';
    const flow = state.readingMode === 'scroll-vertical' ? 'scrolled-continuous' : 'paginated';
    const spread = state.readingMode === 'two-page' ? 'always'
      : (state.readingMode === 'scroll-horizontal' ? 'none' : 'auto');
    state.epubRendition = state.epubBook.renderTo($('#epub-area'), {
      width: '100%', height: '100%', flow,
      manager: state.readingMode === 'scroll-vertical' ? 'continuous' : 'default',
      spread
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

  function normalizeReadableParagraph(text) {
    return String(text || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\s+([,.;!?…])/g, '$1')
      .trim();
  }

  function tokenizeParagraph(text) {
    const clean = normalizeReadableParagraph(text);
    if (!clean) return [];
    const parts = clean.match(/[^.!?…]+(?:[.!?…]+(?=\s|$)|$)/g) || [clean];
    const out = [];
    for (const raw of parts) {
      const s = raw.trim();
      if (!s) continue;
      if (s.length <= 300) { out.push(s); continue; }
      let buf = '';
      for (const clause of s.split(/(?<=[,;:—–])\s+/)) {
        if (!buf) buf = clause;
        else if ((buf + ' ' + clause).length <= 300) buf += ' ' + clause;
        else { out.push(buf.trim()); buf = clause; }
      }
      if (buf) out.push(buf.trim());
    }
    return out;
  }

  function buildTTSUnits(text) {
    const normalized = String(text || '').replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ');
    const paragraphs = normalized.split(/\n\s*\n/);
    const units = [];
    paragraphs.forEach((raw, paragraphIndex) => {
      const sentences = tokenizeParagraph(raw);
      sentences.forEach((sentence, sentenceIndex) => {
        units.push({
          text: sentence,
          paragraphIndex,
          sentenceIndex,
          paragraphEnd: sentenceIndex === sentences.length - 1
        });
      });
    });
    return units;
  }

  function estimateCharsPerPage(widthFactor = 1) {
    const rc = $('#reader-content');
    const h = Math.max(240, (rc?.clientHeight || window.innerHeight) - 24);
    const baseW = Math.max(200, Math.min(720, (rc?.clientWidth || window.innerWidth) - 40));
    const w = Math.max(160, baseW * (widthFactor || 1));
    const fs = state.fontSize || 18;
    const lh = state.lineHeight || 1.7;
    const lines = Math.max(10, Math.floor(h / (fs * lh)));
    // Cyrillic is wider on average
    const charsPerLine = Math.max(18, Math.floor(w / (fs * 0.58)));
    return Math.max(400, Math.min(3500, lines * charsPerLine));
  }

  function splitTextIntoPages(text, pageSize) {
    const pages = [];
    const normalized = String(text || '').replace(/\r\n?/g, '\n');
    // Prefer breaking on paragraph boundaries
    const paras = normalized.split(/\n\s*\n/);
    let buf = '';
    for (const para of paras) {
      const chunk = para.trim();
      if (!chunk) continue;
      if (!buf) {
        buf = chunk;
      } else if ((buf.length + 2 + chunk.length) <= pageSize) {
        buf += '\n\n' + chunk;
      } else {
        if (buf.length > pageSize * 1.4) {
          // hard-split oversized buffer
          for (let i = 0; i < buf.length; i += pageSize) pages.push(buf.slice(i, i + pageSize));
        } else {
          pages.push(buf);
        }
        buf = chunk;
      }
    }
    if (buf) {
      if (buf.length > pageSize * 1.4) {
        for (let i = 0; i < buf.length; i += pageSize) pages.push(buf.slice(i, i + pageSize));
      } else pages.push(buf);
    }
    return pages.length ? pages : [''];
  }

  function fillParagraphs(container, text, baseParagraphIndex = 0) {
    const frag = document.createDocumentFragment();
    // Split on blank lines first; if almost no paragraphs, fall back to single newlines
    let paragraphs = String(text || '').replace(/\r\n?/g, '\n').split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
    if (paragraphs.length <= 1) {
      const alt = String(text || '').replace(/\r\n?/g, '\n').split(/\n/).map(s => s.trim()).filter(Boolean);
      if (alt.length > 1) paragraphs = alt;
    }
    paragraphs.forEach((raw, i) => {
      const paragraphIndex = baseParagraphIndex + i;
      const p = document.createElement('p');
      p.className = 'read-paragraph';
      p.dataset.paragraphIndex = String(paragraphIndex);
      p.title = 'Нажмите, чтобы читать с этого абзаца';
      const sentences = tokenizeParagraph(raw);
      sentences.forEach((sentence, sentenceIndex) => {
        const span = document.createElement('span');
        span.className = 'read-sentence';
        span.dataset.ttsId = `${paragraphIndex}:${sentenceIndex}`;
        span.textContent = sentence;
        p.appendChild(span);
        if (sentenceIndex < sentences.length - 1) p.appendChild(document.createTextNode(' '));
      });
      if (!sentences.length) p.appendChild(document.createTextNode(normalizeReadableParagraph(raw)));
      p.addEventListener('click', () => startTTSFromParagraph(paragraphIndex));
      frag.appendChild(p);
    });
    container.appendChild(frag);
    return paragraphs.length;
  }

  function paginateText(text, book) {
    state.fullText = text;
    const pageSize = estimateCharsPerPage();
    state.textPages = splitTextIntoPages(text, pageSize);
    state.textPage = Math.min(state.textPages.length - 1, Math.floor((book.progress || 0) * state.textPages.length) || 0);
    state.textContent = state.textPages[state.textPage] || '';
    $('#reader-content').innerHTML = '<div class="text-reader" id="text-reader" aria-label="Текст книги"></div>';
    renderTextPage(true);
  }

  function renderTextPage(skipProgress) {
    const el = $('#text-reader');
    if (!el) return;
    const mode = state.readingMode;
    const isContinuous = mode === 'scroll-vertical';
    const isHorizontal = mode === 'scroll-horizontal';
    // Two-page works on all widths (side-by-side ≥560px, stacked on phones via CSS)
    const isTwoPage = mode === 'two-page';
    const isPaged = mode === 'paged';
    const sideBySide = isTwoPage && window.innerWidth >= 560;

    // Always re-paginate for page-based modes so viewport/font changes apply
    if ((isPaged || isHorizontal || isTwoPage) && state.fullText) {
      const widthFactor = sideBySide ? 0.46 : 1;
      const pageSize = estimateCharsPerPage(widthFactor);
      const ratio = state.textPages.length
        ? (state.textPage / Math.max(1, state.textPages.length))
        : (state.currentBook?.progress || 0);
      state.textPages = splitTextIntoPages(state.fullText, pageSize);
      // Align to even index for two-page spreads
      let idx = Math.min(state.textPages.length - 1, Math.floor(ratio * state.textPages.length) || 0);
      if (isTwoPage && idx % 2 === 1) idx = Math.max(0, idx - 1);
      state.textPage = idx;
    }

    el.className = 'text-reader';
    el.classList.toggle('reading-continuous', isContinuous);
    el.classList.toggle('reading-paged', isPaged);
    el.classList.toggle('reading-horizontal', isHorizontal);
    el.classList.toggle('reading-two-page', isTwoPage);
    el.innerHTML = '';

    // Ensure reader-content can host absolute children
    const rc = $('#reader-content');
    if (rc) {
      if (isHorizontal || isTwoPage) {
        rc.style.position = 'relative';
        rc.scrollTop = 0;
        rc.scrollLeft = 0;
      } else {
        rc.style.position = '';
      }
    }

    if (isContinuous) {
      state.textContent = state.fullText || state.textPages.join('\n\n');
      fillParagraphs(el, state.textContent, 0);
      $('#page-num').textContent = '∞';
      $('#page-count').textContent = '∞';
    } else if (isHorizontal) {
      const track = document.createElement('div');
      track.className = 'text-h-track';
      track.setAttribute('id', 'text-h-track');
      // Build pages — use measured width after mount
      state.textPages.forEach((pageText, idx) => {
        const page = document.createElement('div');
        page.className = 'text-h-page';
        page.dataset.pageIndex = String(idx);
        fillParagraphs(page, pageText, 0);
        track.appendChild(page);
      });
      el.appendChild(track);
      state.textContent = state.textPages[state.textPage] || '';

      const syncFromScroll = () => {
        const w = track.clientWidth || 1;
        const idx = Math.round(track.scrollLeft / w);
        if (idx !== state.textPage && idx >= 0 && idx < state.textPages.length) {
          state.textPage = idx;
          state.textContent = state.textPages[idx] || '';
          $('#page-num').textContent = idx + 1;
          if (state.currentBook) {
            state.currentBook.progress = (idx + 1) / Math.max(1, state.textPages.length);
            setProgress(state.currentBook.key || state.currentBook.path, state.currentBook.progress);
          }
          updateProgressBar();
        }
      };
      track.onscroll = syncFromScroll;

      // Force layout then snap to current page (double rAF for iOS Safari)
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const w = track.clientWidth || el.clientWidth || window.innerWidth;
          // Explicit pixel widths help iOS scroll-snap
          [...track.children].forEach(page => {
            page.style.flex = `0 0 ${w}px`;
            page.style.width = w + 'px';
            page.style.minWidth = w + 'px';
          });
          track.scrollLeft = (state.textPage || 0) * w;
          $('#page-num').textContent = (state.textPage || 0) + 1;
          $('#page-count').textContent = state.textPages.length;
        });
      });
      $('#page-num').textContent = (state.textPage || 0) + 1;
      $('#page-count').textContent = state.textPages.length;
    } else if (isTwoPage) {
      const spread = document.createElement('div');
      spread.className = 'text-two-page-spread';
      const left = document.createElement('div');
      left.className = 'text-two-page-col';
      const right = document.createElement('div');
      right.className = 'text-two-page-col';
      // Keep even page as left
      if (state.textPage % 2 === 1) state.textPage = Math.max(0, state.textPage - 1);
      const leftIdx = state.textPage;
      const rightIdx = Math.min(state.textPages.length - 1, leftIdx + 1);
      fillParagraphs(left, state.textPages[leftIdx] || '', 0);
      if (rightIdx > leftIdx) fillParagraphs(right, state.textPages[rightIdx] || '', 0);
      else right.innerHTML = '<div class="text-empty-col"></div>';
      spread.appendChild(left);
      spread.appendChild(right);
      el.appendChild(spread);
      state.textContent = (state.textPages[leftIdx] || '') + '\n\n' + (state.textPages[rightIdx] || '');
      $('#page-num').textContent = (leftIdx + 1) + (rightIdx > leftIdx ? '–' + (rightIdx + 1) : '');
      $('#page-count').textContent = state.textPages.length;
    } else {
      state.textContent = state.textPages[state.textPage] || '';
      fillParagraphs(el, state.textContent, 0);
      $('#page-num').textContent = state.textPage + 1;
      $('#page-count').textContent = state.textPages.length;
    }

    applyReaderStyles();

    if (!skipProgress && state.currentBook) {
      let prog = 0;
      if (isContinuous) {
        const box = $('#reader-content');
        prog = (box?.scrollTop || 0) / Math.max(1, (box?.scrollHeight || 1) - (box?.clientHeight || 1));
      } else {
        prog = (state.textPage + 1) / Math.max(1, state.textPages.length);
      }
      state.currentBook.progress = Math.min(1, Math.max(0, prog));
      setProgress(state.currentBook.key || state.currentBook.path, state.currentBook.progress);
    }
    updateProgressBar();
  }

  // ===== Navigation =====
  function goTextPage(delta) {
    if (!['txt', 'html', 'htm', 'fb2'].includes(state.currentType)) return false;
    const mode = state.readingMode;
    if (mode === 'scroll-vertical') {
      const rc = $('#reader-content');
      if (!rc) return false;
      // One viewport step only (was ~0.88 and sometimes felt like a double jump on iOS)
      const step = Math.max(100, Math.floor(rc.clientHeight * 0.92));
      const expectedScrollTop = rc.scrollTop + delta * step;
      rc.scrollBy({ top: delta * step, behavior: 'smooth' });
      // Estimate new textPage based on expected scroll position
      const maxScroll = rc.scrollHeight - rc.clientHeight;
      if (maxScroll > 0 && state.textPages.length) {
        const ratio = Math.min(1, Math.max(0, expectedScrollTop / maxScroll));
        state.textPage = Math.min(state.textPages.length - 1, Math.round(ratio * (state.textPages.length - 1)) || 0);
        updateProgressBar();
      }
      return true;
    }
    if (mode === 'scroll-horizontal') {
      const track = document.querySelector('#text-h-track') || document.querySelector('.text-h-track');
      if (track) {
        const w = track.clientWidth || window.innerWidth;
        const next = Math.max(0, Math.min(state.textPages.length - 1, (state.textPage || 0) + delta));
        state.textPage = next;
        track.scrollTo({ left: next * w, behavior: 'smooth' });
        state.textContent = state.textPages[next] || '';
        $('#page-num').textContent = next + 1;
        $('#page-count').textContent = state.textPages.length;
        if (state.currentBook) {
          state.currentBook.progress = (next + 1) / Math.max(1, state.textPages.length);
          setProgress(state.currentBook.key || state.currentBook.path, state.currentBook.progress);
        }
        updateProgressBar();
        return true;
      }
      // Fallback if track missing
      const next = state.textPage + delta;
      if (next < 0 || next >= state.textPages.length) return false;
      state.textPage = next;
      renderTextPage();
      return true;
    }
    // paged / two-page: two-page always advances by 2
    const step = mode === 'two-page' ? 2 : 1;
    let next = state.textPage + delta * step;
    if (mode === 'two-page' && next % 2 === 1) next -= 1;
    if (next < 0) {
      if (state.textPage > 0) {
        state.textPage = 0;
        renderTextPage();
        return true;
      }
      return false;
    }
    if (next >= state.textPages.length) return false;
    state.textPage = next;
    renderTextPage();
    const el = $('#text-reader');
    if (el) el.scrollTop = 0;
    const rc = $('#reader-content');
    if (rc) rc.scrollTop = 0;
    return true;
  }

  // Prevent double-page jumps from ghost clicks / double touchend on iOS
  let _navLockUntil = 0;
  let _swipeJustHappened = false;
  function canNavigate() {
    const now = Date.now();
    if (now < _navLockUntil) return false;
    _navLockUntil = now + 320;
    return true;
  }

  async function goPrev() {
    if (!canNavigate()) return;
    if (state.currentType === 'pdf' && state.pdfPage > 1) {
      if (isPdfContinuous()) {
        state.pdfPage--;
        const tryScroll = () => {
          const el = document.querySelector(`#pdf-viewer [data-page-num="${state.pdfPage}"]`);
          if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'start', inline: 'start' });
            return true;
          }
          return false;
        };
        if (!tryScroll() && state._pdfRenderOne) {
          try { await state._pdfRenderOne(state.pdfPage); } catch (e) { console.warn(e); }
          // Wait for layout before scrolling to newly rendered page
          await new Promise(resolve => requestAnimationFrame(resolve));
          tryScroll();
        }
        $('#page-num').textContent = state.pdfPage;
      } else await renderPDFPage(state.pdfPage - 1);
    }
    else if (state.currentType === 'epub' && state.epubRendition) {
      try { await state.epubRendition.prev(); } catch (e) { console.warn(e); }
    }
    else if ((state.currentType === 'djvu' || state.currentType === 'djv') && djvuViewerInstance) {
      try {
        const p = djvuViewerInstance.getPageNumber ? djvuViewerInstance.getPageNumber() : 1;
        if (p > 1 && djvuViewerInstance.configure) djvuViewerInstance.configure({ pageNumber: p - 1 });
        else if (djvuViewerInstance.goToPreviousPage) djvuViewerInstance.goToPreviousPage();
      } catch (e) { console.warn(e); }
    }
    else goTextPage(-1);
  }
  async function goNext() {
    if (!canNavigate()) return;
    if (state.currentType === 'pdf' && state.pdfPage < state.pdfTotal) {
      if (isPdfContinuous()) {
        state.pdfPage++;
        const tryScroll = () => {
          const el = document.querySelector(`#pdf-viewer [data-page-num="${state.pdfPage}"]`);
          if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'start', inline: 'start' });
            return true;
          }
          return false;
        };
        if (!tryScroll() && state._pdfRenderOne) {
          try { await state._pdfRenderOne(state.pdfPage); } catch (e) { console.warn(e); }
          // Wait for layout before scrolling to newly rendered page
          await new Promise(resolve => requestAnimationFrame(resolve));
          tryScroll();
        }
        $('#page-num').textContent = state.pdfPage;
      } else await renderPDFPage(state.pdfPage + 1);
    }
    else if (state.currentType === 'epub' && state.epubRendition) {
      try { await state.epubRendition.next(); } catch (e) { console.warn(e); }
    }
    else if ((state.currentType === 'djvu' || state.currentType === 'djv') && djvuViewerInstance) {
      try {
        const p = djvuViewerInstance.getPageNumber ? djvuViewerInstance.getPageNumber() : 1;
        const total = djvuViewerInstance.getPagesCount ? djvuViewerInstance.getPagesCount() : 9999;
        if (p < total && djvuViewerInstance.configure) djvuViewerInstance.configure({ pageNumber: p + 1 });
        else if (djvuViewerInstance.goToNextPage) djvuViewerInstance.goToNextPage();
      } catch (e) { console.warn(e); }
    }
    else goTextPage(1);
  }

  $('#prev-page').addEventListener('click', goPrev);
  $('#next-page').addEventListener('click', goNext);

  // Collapsible progress / TTS / full chrome
  $('#toggle-progress-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    setProgressCollapsed(!state.progressCollapsed);
  });
  $('#toggle-tts-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    setTtsCollapsed(!state.ttsCollapsed);
  });
  $('#toggle-chrome-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    setChromeCollapsed(!state.chromeCollapsed);
  });
  $('#show-chrome-pill')?.addEventListener('click', (e) => {
    e.stopPropagation();
    setChromeCollapsed(false);
  });
  // Tap empty area of content to toggle chrome (reader-friendly on iPhone)
  let lastChromeTap = 0;
  $('#reader-content')?.addEventListener('click', (e) => {
    if (_swipeJustHappened) return;
    // Ignore interactive elements inside content
    if (e.target.closest('a, button, input, select, textarea, .read-paragraph, .ctrl-btn')) return;
    const now = Date.now();
    if (now - lastChromeTap < 350) {
      setChromeCollapsed(!state.chromeCollapsed);
      lastChromeTap = 0;
    } else {
      lastChromeTap = now;
    }
  });

  // Swipe (skip in vertical mode — native scroll handles paging)
  let touchX = 0;
  let touchY = 0;
  $('#reader-content').addEventListener('touchstart', e => {
    if (e.changedTouches && e.changedTouches[0]) {
      touchX = e.changedTouches[0].screenX;
      touchY = e.changedTouches[0].screenY;
    }
  }, { passive: true });
  $('#reader-content').addEventListener('touchend', e => {
    if (state.readingMode === 'scroll-vertical') return;
    if (state.readingMode === 'scroll-horizontal' && e.target.closest('.text-h-track')) return;
    if (!e.changedTouches || !e.changedTouches[0]) return;
    const dx = e.changedTouches[0].screenX - touchX;
    const dy = e.changedTouches[0].screenY - touchY;
    // Only trigger navigation for clearly horizontal swipes
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 55) {
      _swipeJustHappened = true;
      setTimeout(() => { _swipeJustHappened = false; }, 400);
      (dx < 0 ? goNext : goPrev)();
    }
  }, { passive: true });

  // Track scroll position for text page updates in vertical scroll mode
  let _scrollTick = false;
  $('#reader-content')?.addEventListener('scroll', () => {
    if (_scrollTick) return;
    _scrollTick = true;
    requestAnimationFrame(() => {
      _scrollTick = false;
      if (state.readingMode !== 'scroll-vertical') return;
      if (!['txt', 'html', 'htm', 'fb2'].includes(state.currentType)) return;
      if (!state.textPages.length) return;
      const rc = $('#reader-content');
      if (!rc) return;
      const maxScroll = rc.scrollHeight - rc.clientHeight;
      if (maxScroll <= 0) return;
      const ratio = Math.min(1, Math.max(0, rc.scrollTop / maxScroll));
      state.textPage = Math.min(state.textPages.length - 1, Math.round(ratio * (state.textPages.length - 1)) || 0);
      updateProgressBar();
    });
  });

  // ===== TTS: paragraph-aware, resumable, in-book highlighting =====
  const synth = window.speechSynthesis || null;

  function voiceKey(v) { return v ? `${v.name}|${v.lang}|${v.localService ? 'local' : 'remote'}` : ''; }

  function loadVoices() {
    if (!synth) return;
    state.voices = synth.getVoices() || [];
    const sel = $('#tts-voice');
    if (!sel) return;
    const savedKey = localStorage.getItem('ttsVoiceKey') || state.ttsCurrentVoiceKey;
    sel.innerHTML = '';
    if (!state.voices.length) {
      sel.innerHTML = '<option value="">Голоса загружаются…</option>';
      return;
    }
    const langPref = (state.detectedLang || localStorage.getItem('ttsLang') || 'ru-RU').slice(0, 2).toLowerCase();
    // Prefer local high-quality voices, then language match
    const score = (v) => {
      let s = 0;
      const lang = (v.lang || '').toLowerCase();
      if (lang.startsWith(langPref)) s += 100;
      if (lang.startsWith('ru')) s += 40;
      if (v.localService) s += 30;
      if (/premium|enhanced|neural|natural|siri|yandex|milena|katya|irina|pavel/i.test(v.name)) s += 20;
      return s;
    };
    const sorted = [...state.voices].sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name, 'ru'));
    const ruCount = sorted.filter(v => (v.lang || '').toLowerCase().startsWith('ru')).length;
    sorted.forEach(v => {
      const opt = document.createElement('option');
      opt.value = state.voices.indexOf(v);
      const local = v.localService ? ' · локальный' : '';
      opt.textContent = `${v.name} (${v.lang}${local})`;
      opt.dataset.voiceKey = voiceKey(v);
      sel.appendChild(opt);
    });
    // Hint when few Russian voices (common on iOS without extra downloads)
    if (ruCount <= 2 && langPref === 'ru') {
      const hint = document.createElement('option');
      hint.disabled = true;
      hint.textContent = `— Русских голосов: ${ruCount}. Добавьте в Настройки → Универсальный доступ → Живая речь / Голос —`;
      sel.appendChild(hint);
    }
    const preferredIndex = state.voices.findIndex(v => voiceKey(v) === savedKey);
    if (preferredIndex >= 0) sel.value = String(preferredIndex);
    else {
      const bestRu = sorted.find(v => (v.lang || '').toLowerCase().startsWith('ru'));
      if (bestRu) sel.value = String(state.voices.indexOf(bestRu));
    }
  }
  if (synth && synth.onvoiceschanged !== undefined) synth.onvoiceschanged = loadVoices;
  loadVoices();

  function prepareTTS() { loadVoices(); }

  function getCurrentText() {
    if (['pdf', 'txt', 'html', 'htm', 'fb2'].includes(state.currentType)) return state.textContent || '';
    if (state.currentType === 'epub') {
      try { const iframe = document.querySelector('#epub-area iframe'); if (iframe?.contentDocument) return iframe.contentDocument.body.innerText || state.textContent; } catch (e) {}
      return state.textContent || '';
    }
    return state.textContent || '';
  }

  function clearTextSentenceHighlights() {
    const el = $('#text-reader');
    if (!el) return;
    el.querySelectorAll('.read-sentence.is-speaking').forEach(x => x.classList.remove('is-speaking'));
    el.querySelectorAll('.read-paragraph.is-speaking').forEach(x => x.classList.remove('is-speaking'));
  }

  function highlightSentence(idx) {
    const item = state.ttsSentences[idx];
    if (!item) return;
    clearTextSentenceHighlights();
    if (['txt','html','htm','fb2'].includes(state.currentType)) {
      const el = document.querySelector(`#text-reader .read-sentence[data-tts-id="${CSS.escape(`${item.paragraphIndex}:${item.sentenceIndex}`)}"]`);
      const p = document.querySelector(`#text-reader .read-paragraph[data-paragraph-index="${item.paragraphIndex}"]`);
      if (p) p.classList.add('is-speaking');
      if (el) {
        el.classList.add('is-speaking');
        el.scrollIntoView({behavior:'smooth', block:'center', inline:'nearest'});
      }
      return;
    }
    if (state.currentType === 'pdf') {
      const layer = document.querySelector('#pdf-text-layer');
      if (!layer) return;
      layer.querySelectorAll('.tts-pdf-active').forEach(x => x.classList.remove('tts-pdf-active'));
      // Improved matching: sequential token scoring (PDF text layer spans are often single words)
      const raw = (item.text || '').toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' ').replace(/\s+/g, ' ').trim();
      const tokens = raw.split(' ').filter(w => w.length > 2);
      if (!tokens.length) return;
      const spans = [...layer.querySelectorAll('span')];
      const spanTexts = spans.map(s => (s.textContent || '').toLowerCase().replace(/\s+/g, ' ').trim());
      let bestStart = -1, bestScore = 0;
      for (let i = 0; i < spans.length; i++) {
        let score = 0, ti = 0;
        for (let j = i; j < Math.min(spans.length, i + tokens.length + 4) && ti < tokens.length; j++) {
          if (spanTexts[j].includes(tokens[ti]) || tokens[ti].includes(spanTexts[j])) {
            score += 1 + Math.min(3, tokens[ti].length / 4);
            ti++;
          }
        }
        if (score > bestScore) { bestScore = score; bestStart = i; }
      }
      if (bestStart >= 0 && bestScore >= 1) {
        const end = Math.min(spans.length, bestStart + Math.max(4, tokens.length + 2));
        for (let k = bestStart; k < end; k++) spans[k].classList.add('tts-pdf-active');
        spans[bestStart].scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else {
        const long = tokens.filter(t => t.length > 4).slice(0, 6);
        spans.forEach((span, i) => {
          if (long.some(t => spanTexts[i].includes(t))) span.classList.add('tts-pdf-active');
        });
        const first = layer.querySelector('.tts-pdf-active');
        if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      return;
    }
    if (state.currentType === 'epub') highlightEpubSentence(item.text);
  }

  function clearEpubHighlight() {
    try {
      document.querySelectorAll('#epub-area iframe').forEach(iframe => {
        const doc=iframe.contentDocument;
        doc?.querySelectorAll('.tts-book-highlight').forEach(m=>m.replaceWith(doc.createTextNode(m.textContent||'')));
        doc?.body?.normalize();
      });
    } catch(e) {}
  }

  function highlightEpubSentence(text) {
    if (!text) return;
    try {
      const iframe=document.querySelector('#epub-area iframe'); const doc=iframe?.contentDocument; if(!doc) return;
      clearEpubHighlight();
      const needle = normalizeReadableParagraph(text);
      const walker=doc.createTreeWalker(doc.body,NodeFilter.SHOW_TEXT);
      const nodes=[]; let n; let total=0;
      while(n=walker.nextNode()){ nodes.push({n,start:total}); total += (n.nodeValue||'').length; }
      const raw = nodes.map(x=>x.n.nodeValue||'').join('');
      const normalized = raw.replace(/\s+/g,' ');
      const idx = normalized.indexOf(needle.replace(/\s+/g,' '));
      if(idx<0) return;
      // Fallback: find exact substring inside the first matching text node where possible.
      let cursor=0;
      for(const item of nodes){
        const val=item.n.nodeValue||''; const hit=val.indexOf(text);
        if(hit>=0){
          const r=doc.createRange(); r.setStart(item.n,hit); r.setEnd(item.n,hit+text.length);
          const mark=doc.createElement('span'); mark.className='tts-book-highlight'; r.surroundContents(mark); mark.scrollIntoView({behavior:'smooth',block:'center'}); return;
        }
        cursor += val.length;
      }
    } catch(e) {}
  }

  function clearHighlights() {
    clearTextSentenceHighlights();
    document.querySelectorAll('#pdf-text-layer .tts-pdf-active').forEach(x=>x.classList.remove('tts-pdf-active'));
    clearEpubHighlight();
  }

  function speechFriendlyText(s) {
    return String(s).replace(/\s*[—–]\s*/g, ', — ').replace(/\s*:\s*/g, ': ').replace(/\s*;\s*/g, '; ').replace(/\.{4,}/g, '…').trim();
  }

  function smartPauseMs(item) {
    if (!state.ttsSmartPause) return state.ttsPause;
    let pause = state.ttsPause;
    const t = item.text;
    if (item.paragraphEnd) pause += 180;
    if (/^[\dIVXLC]+[.)]|^(глава|chapter|часть|part)\b/i.test(t)) pause += 220;
    if (/[!?…]$/.test(t)) pause += 80;
    return pause;
  }

  function speakSentences(sentences, startIdx = 0, resumeChar = 0) {
    if (!synth) { toast('Озвучка недоступна в этом браузере'); return; }
    if (!sentences.length) { toast('Нет текста для озвучки'); return; }
    state.ttsSentences = sentences.map(x => typeof x === 'string' ? {text:x,paragraphEnd:false,paragraphIndex:0,sentenceIndex:0} : x);
    state.ttsSentenceIdx = Math.max(0, Math.min(startIdx, state.ttsSentences.length - 1));
    state.ttsCharOffset = Math.max(0, resumeChar || 0);
    state.ttsPendingResumeOffset = state.ttsCharOffset;
    state.ttsActive = true;
    state.ttsPaused = false;
    speakNextSentence(state.ttsCharOffset);
  }

  function selectedVoice() {
    const idx = parseInt($('#tts-voice').value,10);
    return !isNaN(idx) && state.voices[idx] ? state.voices[idx] : null;
  }

  function speakNextSentence(resumeChar = 0) {
    if (!state.ttsActive || state.ttsSentenceIdx >= state.ttsSentences.length) {
      state.ttsActive = false; state.ttsPaused = false; state.isSpeaking = false; $('#tts-play').textContent='▶'; clearHighlights();
      if (state.continuousTTS) {
        setTimeout(() => {
          if (!state.ttsActive && state.currentType === 'pdf' && state.pdfPage < state.pdfTotal) renderPDFPage(state.pdfPage + 1).then(()=>speakSentences(buildTTSUnits(getCurrentText())));
          else if (!state.ttsActive && state.currentType === 'epub' && state.epubRendition) state.epubRendition.next().then(()=>setTimeout(()=>speakSentences(buildTTSUnits(getCurrentText())),450));
          else if (!state.ttsActive && ['txt','html','htm','fb2'].includes(state.currentType) && state.textPage < state.textPages.length - 1) { state.textPage++; renderTextPage(); speakSentences(buildTTSUnits(state.textContent)); }
        }, Math.max(140, state.ttsPause));
      }
      return;
    }

    const item = state.ttsSentences[state.ttsSentenceIdx];
    const sourceText = speechFriendlyText(item.text);
    const offset = Math.max(0, Math.min(resumeChar || 0, sourceText.length - 1));
    const text = offset > 0 ? sourceText.slice(offset) : sourceText;
    const session = ++state.ttsSession;
    state.ttsCharOffset = offset;
    highlightSentence(state.ttsSentenceIdx);
    if (synth) synth.cancel();

    const u = new SpeechSynthesisUtterance(text);
    const override = $('#tts-lang-override').value;
    const lang = override === 'auto' ? state.detectedLang : override;
    u.lang = lang; u.rate = state.ttsRate;
    const emotion = /[!?]$/.test(text) ? 0.05 : (/…$/.test(text) ? -0.025 : 0);
    u.pitch = Math.max(0.75, Math.min(1.28, state.ttsPitch + emotion)); u.volume=1;
    const v = selectedVoice(); if (v) { u.voice=v; state.ttsCurrentVoiceKey=voiceKey(v); localStorage.setItem('ttsVoiceKey',state.ttsCurrentVoiceKey); }

    u.onboundary = e => {
      if (session !== state.ttsSession || typeof e.charIndex !== 'number') return;
      state.ttsCharOffset = offset + e.charIndex;
      state.ttsPendingResumeOffset = state.ttsCharOffset;
    };
    u.onpause = e => {
      if (session !== state.ttsSession) return;
      if (typeof e.charIndex === 'number') { state.ttsCharOffset = offset + e.charIndex; state.ttsPendingResumeOffset = state.ttsCharOffset; }
      state.ttsPaused = true; state.isSpeaking = true; $('#tts-play').textContent='▶';
    };
    u.onresume = () => { if(session===state.ttsSession){ state.ttsPaused=false; state.isSpeaking=true; $('#tts-play').textContent='⏸'; } };
    u.onend = () => {
      if (session !== state.ttsSession || !state.ttsActive) return;
      state.ttsCharOffset = 0; state.ttsPendingResumeOffset = 0; state.ttsSentenceIdx++;
      if (state.isSpeaking && !state.ttsPaused) setTimeout(()=>speakNextSentence(), smartPauseMs(item));
    };
    u.onerror = e => { if(session!==state.ttsSession) return; if(e.error==='canceled') return; state.ttsActive=false; state.isSpeaking=false; state.ttsPaused=false; $('#tts-play').textContent='▶'; toast('Не удалось продолжить озвучку'); };
    state.ttsUtterance = u; state.isSpeaking=true; state.ttsPaused=false; $('#tts-play').textContent='⏸';
    synth.speak(u);
  }

  function startTTS() { speakSentences(buildTTSUnits(getCurrentText())); }

  function startTTSFromParagraph(paragraphIndex) {
    const units = buildTTSUnits(getCurrentText()).filter(u => u.paragraphIndex >= paragraphIndex);
    const first = units.findIndex(u => u.paragraphIndex === paragraphIndex);
    if (first < 0) return toast('В этом абзаце нет текста для озвучки');
    if (synth) synth.cancel();
    state.ttsActive = false; state.ttsSession++;
    speakSentences(units, first, 0);
    toast(`Чтение с абзаца ${paragraphIndex + 1}`);
  }

  $('#tts-play').addEventListener('click', () => {
    if (!synth) return;
    if (state.ttsActive && synth.paused) {
      if (state.ttsPendingResumeOffset > 0 || state.ttsPendingVoiceRebuild) {
        const idx = state.ttsSentenceIdx; const off = state.ttsPendingResumeOffset;
        state.ttsPendingVoiceRebuild = false; state.ttsSession++; synth.cancel();
        setTimeout(()=>{ state.isSpeaking=true; state.ttsPaused=false; speakNextSentence(off); }, 40);
      } else { synth.resume(); state.ttsPaused=false; state.isSpeaking=true; $('#tts-play').textContent='⏸'; }
    } else if (state.ttsActive && synth.speaking) {
      synth.pause();
    } else {
      startTTS();
    }
  });

  $('#tts-stop').addEventListener('click', () => {
    state.ttsActive=false; state.ttsPaused=false; state.ttsSession++;
    if (synth) synth.cancel();
    state.isSpeaking=false; state.ttsCharOffset=0; state.ttsPendingResumeOffset=0;
    $('#tts-play').textContent='▶'; clearHighlights();
  });

  $('#tts-voice').addEventListener('change', () => {
    const v=selectedVoice(); if(!v) return;
    state.ttsCurrentVoiceKey=voiceKey(v); localStorage.setItem('ttsVoiceKey',state.ttsCurrentVoiceKey);
    // A voice cannot be swapped inside an existing utterance. Preserve exact character position,
    // cancel the old utterance, and rebuild from that offset. This prevents "jump to start".
    if (state.ttsActive) {
      const off = state.ttsPendingResumeOffset || state.ttsCharOffset || 0;
      state.ttsPendingResumeOffset = off;
      state.ttsPendingVoiceRebuild = true;
      if (!synth?.paused && synth?.speaking) {
        state.ttsSession++; synth.cancel();
        setTimeout(()=>{ if(state.ttsActive){ state.ttsPendingVoiceRebuild=false; state.isSpeaking=true; speakNextSentence(off); } }, 50);
      }
    }
  });

  $('#tts-rate').addEventListener('input', e => { state.ttsRate=parseFloat(e.target.value); localStorage.setItem('ttsRate',state.ttsRate); $('#tts-rate-label').textContent=state.ttsRate.toFixed(1)+'×'; });
  $('#tts-more-btn').addEventListener('click', () => $('#tts-settings-overlay').classList.remove('hidden'));
  $('#close-tts-settings').addEventListener('click', () => $('#tts-settings-overlay').classList.add('hidden'));
  $('#tts-settings-overlay').addEventListener('click', e => { if(e.target===$('#tts-settings-overlay')) $('#tts-settings-overlay').classList.add('hidden'); });
  $('#tts-pitch').value=state.ttsPitch; $('#tts-pitch-label').textContent=state.ttsPitch.toFixed(2);
  $('#tts-pause').value=state.ttsPause; $('#tts-pause-label').textContent=state.ttsPause+' мс'; $('#tts-smart-pause').checked=state.ttsSmartPause;
  $('#tts-pitch').addEventListener('input',e=>{state.ttsPitch=parseFloat(e.target.value);localStorage.setItem('ttsPitch',state.ttsPitch);$('#tts-pitch-label').textContent=state.ttsPitch.toFixed(2);});
  $('#tts-pause').addEventListener('input',e=>{state.ttsPause=parseInt(e.target.value,10);localStorage.setItem('ttsPause',state.ttsPause);$('#tts-pause-label').textContent=state.ttsPause+' мс';});
  $('#tts-smart-pause').addEventListener('change',e=>{state.ttsSmartPause=e.target.checked;localStorage.setItem('ttsSmartPause',e.target.checked);});

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
              try {
                await state.epubRendition.display(item.href);
              } catch (e) { console.warn('TOC jump', e); }
              $('#side-panel').classList.add('hidden');
              // Ensure navigation still works after TOC jump
              requestAnimationFrame(() => {
                try { state.epubRendition?.reportLocation?.(); } catch (_) {}
              });
            }
          });
          box.appendChild(div);
          if (item.subitems && item.subitems.length) addItems(item.subitems, level + 1);
        });
      }
      addItems(state.epubToc);
    } else if (['txt', 'html', 'htm', 'fb2'].includes(state.currentType)) {
      // Simple page list — jump preserves current reading mode
      const total = Math.max(1, state.textPages.length || 1);
      for (let i = 0; i < total; i++) {
        const div = document.createElement('div');
        div.className = 'toc-item level-1';
        div.textContent = `Страница ${i + 1}`;
        div.addEventListener('click', () => {
          state.textPage = Math.min(i, total - 1);
          renderTextPage();
          // Re-sync horizontal track / scroll after TOC jump so swipe & buttons work
          requestAnimationFrame(() => {
            const track = document.querySelector('.text-h-track');
            if (track && state.readingMode === 'scroll-horizontal') {
              const pageEl = track.children[state.textPage];
              if (pageEl) pageEl.scrollIntoView({ inline: 'start', block: 'nearest', behavior: 'auto' });
            } else {
              const rc = $('#reader-content');
              if (rc) rc.scrollTop = 0;
            }
          });
          $('#side-panel').classList.add('hidden');
        });
        box.appendChild(div);
      }
    } else if (state.currentType === 'pdf') {
      for (let i = 1; i <= state.pdfTotal; i++) {
        const div = document.createElement('div');
        div.className = 'toc-item level-1';
        div.textContent = `Страница ${i}`;
        div.addEventListener('click', async () => {
          // Always use mode-aware render so continuous/horizontal stay consistent
          // (previously always called renderPDFPage → broke buttons/swipe until mode switch)
          state.pdfPage = i;
          await renderPDFByMode();
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

  $('#reader-content').addEventListener('scroll', () => {
    if (!state.currentBook || !['txt','html','htm','fb2'].includes(state.currentType)) return;
    if (!['scroll-vertical','scroll-horizontal'].includes(state.readingMode)) return;
    const max = Math.max(1, (state.readingMode === 'scroll-horizontal' ? $('#text-reader')?.scrollWidth - $('#text-reader')?.clientWidth : $('#reader-content').scrollHeight - $('#reader-content').clientHeight));
    const pos = state.readingMode === 'scroll-horizontal' ? ($('#reader-content').scrollLeft || 0) : ($('#reader-content').scrollTop || 0);
    const prog = Math.min(1, Math.max(0, pos / max));
    state.currentBook.progress = prog;
    setProgress(state.currentBook.key || state.currentBook.path, prog);
    updateProgressBar();
  }, { passive: true });

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

  function openSettingsModal() {
    refreshFavTagsUI();
    // Hide book-specific section when opened from library
    const favSec = $('#fav-tags-section');
    if (favSec) favSec.style.display = state.currentBook ? '' : 'none';
    $('#modal-overlay').classList.remove('hidden');
  }
  $('#reader-menu-btn').addEventListener('click', openSettingsModal);
  const readerSettingsBtn = $('#reader-settings-btn');
  if (readerSettingsBtn) readerSettingsBtn.addEventListener('click', openSettingsModal);
  const librarySettingsBtn = $('#library-settings-btn');
  if (librarySettingsBtn) librarySettingsBtn.addEventListener('click', openSettingsModal);

  // Quick filter: Избранное from library header
  const favFilterBtn = $('#favorites-filter-btn');
  if (favFilterBtn) {
    favFilterBtn.addEventListener('click', () => {
      const sel = $('#filter-status');
      if (!sel) return;
      if (sel.value === 'favorites') {
        sel.value = 'all';
        favFilterBtn.classList.remove('active');
        toast('Показаны все книги');
      } else {
        sel.value = 'favorites';
        favFilterBtn.classList.add('active');
        toast('⭐ Избранное');
      }
      sel.dispatchEvent(new Event('change'));
    });
  }

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

  const dedupeBtn = $('#dedupe-library-btn');
  if (dedupeBtn) {
    dedupeBtn.addEventListener('click', async () => {
      dedupeBtn.disabled = true;
      try {
        await findAndRemoveDuplicates();
      } finally {
        dedupeBtn.disabled = false;
      }
    });
  }

  // Library toolbar: stay sticky, smoothly hide on scroll down, show on scroll up
  (function setupLibraryToolbarAutoHide() {
    const main = document.querySelector('.library-main');
    const bar = $('#library-toolbar');
    if (!main || !bar) return;
    let lastY = main.scrollTop;
    let ticking = false;
    const THRESHOLD = 8;
    const TOP_SHOW = 16;

    const update = () => {
      ticking = false;
      const y = main.scrollTop;
      const dy = y - lastY;
      bar.classList.toggle('is-scrolled', y > TOP_SHOW);
      if (y <= TOP_SHOW) {
        bar.classList.remove('is-hidden');
      } else if (dy > THRESHOLD) {
        // scrolling down → hide
        bar.classList.add('is-hidden');
      } else if (dy < -THRESHOLD) {
        // scrolling up → show
        bar.classList.remove('is-hidden');
      }
      lastY = y;
    };

    main.addEventListener('scroll', () => {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(update);
      }
    }, { passive: true });
  })();

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

  $$('.reading-mode-opt').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const mode = btn.dataset.readingMode;
      if (!mode) return;
      if (isIPhoneLike() && (mode === 'scroll-horizontal' || mode === 'two-page')) {
        toast('На iPhone этот вид недоступен', 1600);
        return;
      }
      // Immediate UI feedback (iOS Safari sometimes delays class updates)
      $$('.reading-mode-opt').forEach(b => b.classList.toggle('active', b === btn));
      await setReadingMode(mode);
      toast('Вид: ' + (btn.querySelector('strong')?.textContent || mode), 1400);
      // On narrow screens close settings so user sees the change right away
      if (window.innerWidth <= 700) {
        const overlay = $('#modal-overlay');
        if (overlay) overlay.classList.add('hidden');
      }
    });
  });
  applyReadingModeAvailability();

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
  setReadingMode(state.readingMode, false);
  $('#tts-rate').value = state.ttsRate;
  $('#tts-rate-label').textContent = state.ttsRate.toFixed(1) + '×';
  applyReaderStyles();
  applyChromeState();
  scheduleEngineWarmup();

  // Re-layout page modes on rotate / resize
  let _resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(() => {
      if (!$('#reader-screen')?.classList.contains('active')) return;
      if (!['txt', 'html', 'htm', 'fb2'].includes(state.currentType)) return;
      if (!['scroll-horizontal', 'two-page', 'paged'].includes(state.readingMode)) return;
      renderTextPage(true);
    }, 180);
  });

  // Restore session hint / reading history on welcome screen
  renderContinueSession();
  const clearHistBtn = $('#clear-history-btn');
  if (clearHistBtn) clearHistBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    clearSessionHistory();
  });

  // Keep history progress fresh when leaving reader
  const _origBack = $('#back-to-library');
  if (_origBack) {
    _origBack.addEventListener('click', () => {
      if (state.currentBook) {
        const key = state.currentBook.key || state.currentBook.path;
        state.currentBook.progress = getProgress(key) || state.currentBook.progress || 0;
        pushReadingHistory(state.currentBook);
      }
    }, true);
  }

  console.log('Умный Читатель v6.10 готов 📚✨');
})();
