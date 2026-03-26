'use strict';

/* ──────────────────────────────────────
   Storage keys
────────────────────────────────────── */
const KEYS = {
  library:   'reads_library',
  positions: 'reads_positions',
  theme:     'reads_theme',
  settings:  'reads_settings',
};

/* ──────────────────────────────────────
   State
────────────────────────────────────── */
let library   = [];
let positions = {};
let activeIdx = null;
let words     = [];
let wordIdx   = 0;
let currentChapters = [];
let chapterStarts   = [];
let chapterIdx      = 0;

let wpm        = 250;
let chunkSize  = 1;
let focalMode  = 'auto';
let pausePunct = true;
let savePos    = true;
let theme      = 'dark';

let playing      = false;
let wordTimer    = null;
let elapsedTimer = null;
let elapsedSec   = 0;
let readerLayoutObserver = null;
let readerChromeTimer = null;

/* ──────────────────────────────────────
   Persistence
────────────────────────────────────── */
function loadAll() {
  try { library   = JSON.parse(localStorage.getItem(KEYS.library)   || '[]'); } catch { library = []; }
  try { positions = JSON.parse(localStorage.getItem(KEYS.positions) || '{}'); } catch { positions = {}; }

  theme = localStorage.getItem(KEYS.theme) || 'dark';

  try {
    const s = JSON.parse(localStorage.getItem(KEYS.settings) || '{}');
    if (s.wpm)       wpm       = s.wpm;
    if (s.chunkSize === 1 || s.chunkSize === 3) chunkSize = s.chunkSize;
    else if (s.chunkSize === 2) chunkSize = 3;
    if (s.focalMode) focalMode = s.focalMode;
    if (typeof s.pausePunct === 'boolean') pausePunct = s.pausePunct;
    if (typeof s.savePos    === 'boolean') savePos    = s.savePos;
  } catch { /* use defaults */ }
}

function saveLibrary()   { localStorage.setItem(KEYS.library,   JSON.stringify(library));   }
function savePositions() { localStorage.setItem(KEYS.positions, JSON.stringify(positions)); }

function saveSettings() {
  localStorage.setItem(KEYS.settings, JSON.stringify({ wpm, chunkSize, focalMode, pausePunct, savePos }));
}

/* ──────────────────────────────────────
   Theme
────────────────────────────────────── */
function applyTheme() {
  document.body.setAttribute('data-theme', theme);
  document.getElementById('theme-btn').textContent = theme === 'dark' ? '◐' : '◑';
  // Update theme-color meta for browser chrome
  const meta = document.getElementById('theme-meta');
  if (meta) meta.content = theme === 'dark' ? '#0a0a0a' : '#f5f0e8';
}

function toggleTheme() {
  theme = theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem(KEYS.theme, theme);
  applyTheme();
}

/* ──────────────────────────────────────
   Navigation
────────────────────────────────────── */
function goView(v) {
  document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
  document.getElementById(v + '-view').classList.add('active');
  document.querySelectorAll('.nav-tab').forEach(el =>
    el.classList.toggle('active', el.dataset.view === v)
  );
  if (v === 'library') renderLibrary();
  if (v === 'reader') updateReaderCentering();
  syncReaderChrome();
}

function switchTab(tab, btn) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('tab-paste').style.display = tab === 'paste' ? '' : 'none';
  document.getElementById('tab-file').style.display  = tab === 'file'  ? '' : 'none';
}

/* ──────────────────────────────────────
   Library
────────────────────────────────────── */
function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function renderLibrary() {
  const list = document.getElementById('text-list');
  if (!library.length) {
    list.innerHTML = '<div class="empty-state">your library is empty — add a text below</div>';
    return;
  }
  list.innerHTML = library.map((t, i) => `
    <div class="text-card ${activeIdx === i ? 'active-text' : ''}" onclick="selectText(${i})">
      <div class="card-info">
        <div class="card-title">${esc(t.title)}</div>
        <div class="card-meta">${t.wordCount} words${t.chapters?.length ? ` &middot; ${t.chapters.length} chapters` : ''} &middot; ~${Math.ceil(t.wordCount / wpm)} min at ${wpm} wpm</div>
      </div>
      <div class="card-actions">
        <button class="card-del" title="Remove"
          onclick="event.stopPropagation(); deleteText(${i})">✕</button>
      </div>
    </div>
  `).join('');
}

function addText() {
  const raw = (document.getElementById('new-text').value || '').trim();
  if (!raw) return;

  const titleEl = document.getElementById('new-title');
  const title   = titleEl.value.trim() || 'untitled — ' + new Date().toLocaleDateString();
  addLibraryEntry(title, raw);

  titleEl.value = '';
  document.getElementById('new-text').value = '';

  selectText(library.length - 1);
  goView('reader');
}

function deleteText(i) {
  if (!confirm(`Remove "${library[i].title}"?`)) return;
  library.splice(i, 1);

  if (activeIdx === i) {
    activeIdx = null; words = []; wordIdx = 0;
    resetDisplay();
  } else if (activeIdx > i) {
    activeIdx--;
  }

  delete positions[i];
  // Re-key positions after splice
  const newPos = {};
  Object.entries(positions).forEach(([k, v]) => {
    const n = +k;
    if (n < i) newPos[n] = v;
    else if (n > i) newPos[n - 1] = v;
  });
  positions = newPos;

  saveLibrary();
  savePositions();
  renderLibrary();
}

function selectText(i) {
  activeIdx   = i;
  const entry = library[i];
  words       = tokenize(entry.raw);
  currentChapters = Array.isArray(entry.chapters) ? entry.chapters : [];
  chapterStarts   = buildChapterStarts(currentChapters);
  chapterIdx      = 0;
  wordIdx     = (savePos && positions[i] != null)
                  ? Math.min(positions[i], words.length - 1)
                  : 0;
  elapsedSec  = 0;

  if (playing) stopPlayback();
  renderChapterSelect();
  showWord();
  goView('reader');
  syncReaderChrome();
}

/* ──────────────────────────────────────
   Tokenisation
────────────────────────────────────── */
function tokenize(text) {
  return text.split(/\s+/).filter(w => w.length > 0);
}

function normalizeImportedText(text) {
  return String(text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function addLibraryEntry(title, raw, extra = {}) {
  const normalized = normalizeImportedText(raw);
  const ws = tokenize(normalized);
  library.push({ title, raw: normalized, wordCount: ws.length, ...extra });
  saveLibrary();
}

function fileTitleFromName(name) {
  return name
    .replace(/\.[^.]+$/, '')
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'untitled';
}

function markdownToText(md) {
  let text = normalizeImportedText(md);
  text = text.replace(/^\uFEFF/, '');
  text = text.replace(/^\s*---[\s\S]*?\n---\s*\n?/, '');
  text = text.replace(/```[\s\S]*?```/g, block => block.replace(/```[a-z0-9_-]*\n?/ig, '\n').replace(/\n?```/g, '\n'));
  text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1');
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  text = text.replace(/^#{1,6}\s+/gm, '');
  text = text.replace(/^\s{0,3}>\s?/gm, '');
  text = text.replace(/^\s{0,3}[-*+]\s+/gm, '');
  text = text.replace(/^\s{0,3}\d+[.)]\s+/gm, '');
  text = text.replace(/`([^`]+)`/g, '$1');
  text = text.replace(/(\*\*|__)(.*?)\1/g, '$2');
  text = text.replace(/(\*|_)(.*?)\1/g, '$2');
  text = text.replace(/~~(.*?)~~/g, '$1');
  text = text.replace(/<[^>]+>/g, '');
  text = text.replace(/\|/g, ' ');
  return normalizeImportedText(text);
}

function resolveEpubPath(basePath, relativePath) {
  const baseParts = (basePath || '').split('/').filter(Boolean);
  if (baseParts.length) baseParts.pop();
  const parts = baseParts.concat(String(relativePath || '').split('/'));
  const resolved = [];

  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }

  return resolved.join('/');
}

function htmlToText(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style,noscript').forEach(el => el.remove());
  return normalizeImportedText(doc.body?.innerText || doc.body?.textContent || '');
}

function extractChapterTitle(doc, fallback) {
  const title =
    doc.querySelector('title')?.textContent ||
    doc.querySelector('h1')?.textContent ||
    doc.querySelector('h2')?.textContent ||
    doc.querySelector('h3')?.textContent ||
    fallback;

  return normalizeImportedText(title || fallback);
}

async function readPdfText(file) {
  if (window.__pdfjsReady) await window.__pdfjsReady;
  if (!window.pdfjsLib) throw new Error('PDF support is unavailable.');
  const data = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  const chunks = [];

  for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
    const page = await pdf.getPage(pageNo);
    const content = await page.getTextContent();
    const pageText = content.items
      .map(item => item.str)
      .filter(Boolean)
      .join(' ')
      .replace(/\s+\n/g, '\n')
      .trim();
    if (pageText) chunks.push(pageText);
  }

  return normalizeImportedText(chunks.join('\n\n'));
}

async function readEpubText(file) {
  if (!window.JSZip) throw new Error('EPUB support is unavailable.');
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const containerFile = zip.file('META-INF/container.xml');
  if (!containerFile) throw new Error('Invalid EPUB: missing container.');

  const containerDoc = new DOMParser().parseFromString(await containerFile.async('text'), 'application/xml');
  const rootfile = containerDoc.getElementsByTagName('rootfile')[0]?.getAttribute('full-path');
  if (!rootfile) throw new Error('Invalid EPUB: missing package file.');

  const packageFile = zip.file(rootfile);
  if (!packageFile) throw new Error('Invalid EPUB: package file not found.');

  const packageDoc = new DOMParser().parseFromString(await packageFile.async('text'), 'application/xml');
  const titleNode = packageDoc.getElementsByTagNameNS('*', 'title')[0];
  const title = normalizeImportedText(titleNode?.textContent || '') || fileTitleFromName(file.name);

  const manifest = new Map();
  Array.from(packageDoc.getElementsByTagNameNS('*', 'item')).forEach(item => {
    const id = item.getAttribute('id');
    const href = item.getAttribute('href');
    const mediaType = item.getAttribute('media-type') || '';
    if (id && href) manifest.set(id, { href, mediaType });
  });

  const spineRefs = Array.from(packageDoc.getElementsByTagNameNS('*', 'itemref'))
    .map(item => item.getAttribute('idref'))
    .filter(Boolean);

  const basePath = rootfile.replace(/[^/]+$/, '');
  const chapters = [];

  for (const idref of spineRefs) {
    const item = manifest.get(idref);
    if (!item) continue;
    if (!/(xhtml|html|htm|xml)/i.test(item.mediaType || item.href)) continue;

    const path = resolveEpubPath(basePath, item.href);
    const chapterFile = zip.file(path);
    if (!chapterFile) continue;

    const chapterHtml = await chapterFile.async('text');
    const chapterDoc = new DOMParser().parseFromString(chapterHtml, 'text/html');
    chapterDoc.querySelectorAll('script,style,noscript').forEach(el => el.remove());

    const chapterText = htmlToText(chapterHtml);
    if (chapterText) {
      chapters.push({
        title: extractChapterTitle(chapterDoc, item.href),
        raw: chapterText,
        wordCount: tokenize(chapterText).length,
      });
    }
  }

  return {
    title,
    raw: normalizeImportedText(chapters.map(ch => ch.raw).join('\n\n')),
    chapters,
  };
}

/* ──────────────────────────────────────
   ORP — Optimal Recognition Point
   Returns index of focal letter inside word
────────────────────────────────────── */
function focalIndex(word) {
  if (focalMode === 'first') return 0;
  const clean = word.replace(/[^a-zA-Z]/g, '');
  const len   = clean.length || 1;
  if (len <= 1) return 0;
  if (len <= 5) return 1;
  if (len <= 9) return 2;
  return 3;
}

/* ──────────────────────────────────────
   Display
────────────────────────────────────── */
function showWord() {
  if (!words.length) { resetDisplay(); return; }

  document.getElementById('idle-msg').style.display    = 'none';
  document.getElementById('focus-marker').style.display = '';

  const wordDisplay = document.getElementById('word-display');
  const leftWord  = chunkSize === 3 ? (words[wordIdx - 1] || '') : '';
  const word      = words[wordIdx] || '';
  const rightWord = chunkSize === 3 ? (words[wordIdx + 1] || '') : '';
  const fi        = focalIndex(word);

  wordDisplay.dataset.mode = chunkSize === 3 ? 'context' : 'single';
  document.getElementById('w-left').textContent   = leftWord;
  document.getElementById('w-before').textContent = word.slice(0, fi);
  document.getElementById('w-focal').textContent  = word[fi] || '';
  document.getElementById('w-after').textContent  = word.slice(fi + 1);
  document.getElementById('w-right').textContent  = rightWord;

  // Progress
  const pct = words.length > 1 ? (wordIdx / (words.length - 1)) * 100 : 100;
  document.getElementById('progress-fill').style.width = pct.toFixed(2) + '%';

  // Stats
  document.getElementById('stat-pos').textContent = (wordIdx + 1) + ' / ' + words.length;

  const wordsLeft = words.length - wordIdx;
  const secLeft   = Math.round((wordsLeft / wpm) * 60);
  document.getElementById('stat-remain').textContent =
    secLeft < 60 ? secLeft + 's' : Math.ceil(secLeft / 60) + ' min';

  // Persist position
  if (savePos && activeIdx !== null) {
    positions[activeIdx] = wordIdx;
    savePositions();
  }

  updateChapterSelection();
}

function buildChapterStarts(chapters) {
  let pos = 0;
  return chapters.map(ch => {
    const start = pos;
    pos += ch.wordCount || tokenize(ch.raw || '').length;
    return start;
  });
}

function renderChapterSelect() {
  const wrap = document.getElementById('chapter-wrap');
  const select = document.getElementById('chapter-select');
  if (!wrap || !select) return;

  if (currentChapters.length <= 1) {
    wrap.style.display = 'none';
    select.innerHTML = '';
    return;
  }

  wrap.style.display = '';
  select.innerHTML = currentChapters.map((ch, i) =>
    `<option value="${i}">${esc(ch.title || `chapter ${i + 1}`)}</option>`
  ).join('');
  updateChapterSelection();
}

function updateChapterSelection() {
  const select = document.getElementById('chapter-select');
  if (!select || currentChapters.length <= 1) return;

  let idx = 0;
  for (let i = 0; i < chapterStarts.length; i++) {
    if (wordIdx >= chapterStarts[i]) idx = i;
  }

  chapterIdx = idx;
  select.value = String(idx);
}

function jumpChapter(i) {
  if (!currentChapters.length) return;
  const idx = Math.max(0, Math.min(currentChapters.length - 1, i));
  chapterIdx = idx;
  wordIdx = chapterStarts[idx] || 0;
  showWord();
  if (playing) {
    clearTimeout(wordTimer);
    scheduleNext();
  }
}

function updateReaderCentering() {
  const footer = document.querySelector('.reader-footer');
  const progress = document.querySelector('.progress-bar-wrap');
  if (!footer || !progress) return;

  const shift = (footer.getBoundingClientRect().height + progress.getBoundingClientRect().height) / 2;
  document.documentElement.style.setProperty('--reader-center-shift', `${shift}px`);
}

function syncReaderChrome() {
  clearTimeout(readerChromeTimer);
  const shouldDim = playing && document.getElementById('reader-view')?.classList.contains('active');
  document.body.classList.toggle('reader-chrome-dimmed', shouldDim);
}

function revealReaderChrome() {
  clearTimeout(readerChromeTimer);
  document.body.classList.remove('reader-chrome-dimmed');
  if (!playing || !document.getElementById('reader-view')?.classList.contains('active')) return;

  readerChromeTimer = setTimeout(() => {
    document.body.classList.add('reader-chrome-dimmed');
  }, 1800);
}

function handleReaderStagePress() {
  if (!words.length) {
    goView('library');
    return;
  }

  revealReaderChrome();
  if (!playing) togglePlay();
}

function resetDisplay() {
  const hasText = words.length > 0;
  document.getElementById('idle-msg').style.display     = hasText ? 'none' : '';
  document.getElementById('focus-marker').style.display = hasText ? '' : 'none';
  document.getElementById('word-display').dataset.mode = 'single';
  document.getElementById('w-left').textContent   = '';
  document.getElementById('w-before').textContent = '';
  document.getElementById('w-focal').textContent  = '';
  document.getElementById('w-after').textContent  = '';
  document.getElementById('w-right').textContent  = '';
  document.getElementById('progress-fill').style.width = '0%';
  document.getElementById('stat-pos').textContent    = '0 / 0';
  document.getElementById('stat-remain').textContent = '—';
  document.getElementById('stat-elapsed').textContent = '0:00';
}

/* ──────────────────────────────────────
   Playback
────────────────────────────────────── */
function togglePlay() {
  if (!words.length) { goView('library'); return; }
  playing ? stopPlayback() : startPlayback();
}

function startPlayback() {
  playing = true;
  document.getElementById('play-btn').textContent = '⏸';
  revealReaderChrome();
  scheduleNext();
  startElapsed();
}

function stopPlayback() {
  playing = false;
  document.getElementById('play-btn').textContent = '▶';
  clearTimeout(wordTimer);
  clearInterval(elapsedTimer);
  syncReaderChrome();
}

function getDelay() {
  let ms = (60 / wpm) * 1000;
  if (pausePunct) {
    const w = words[wordIdx] || '';
    if (/[.!?…]$/.test(w)) ms *= 2.4;
    else if (/[,;:\-–—]$/.test(w)) ms *= 1.5;
  }
  return ms;
}

function scheduleNext() {
  wordTimer = setTimeout(() => {
    wordIdx = Math.min(wordIdx + 1, words.length - 1);
    showWord();

    if (wordIdx >= words.length - 1) {
      stopPlayback();
      return;
    }
    scheduleNext();
  }, getDelay());
}

function startElapsed() {
  clearInterval(elapsedTimer);
  const startMs = Date.now() - elapsedSec * 1000;

  elapsedTimer = setInterval(() => {
    elapsedSec = Math.floor((Date.now() - startMs) / 1000);
    const m = Math.floor(elapsedSec / 60);
    const s = elapsedSec % 60;
    document.getElementById('stat-elapsed').textContent =
      m + ':' + String(s).padStart(2, '0');
  }, 500);
}

/* ──────────────────────────────────────
   Navigation controls
────────────────────────────────────── */
function skipWord(n) {
  if (!words.length) return;
  wordIdx = Math.max(0, Math.min(words.length - 1, wordIdx + n));
  showWord();
  if (playing) { clearTimeout(wordTimer); scheduleNext(); }
}

function skipSentence(dir) {
  if (!words.length) return;

  if (dir > 0) {
    let i = wordIdx + 1;
    while (i < words.length - 1 && !/[.!?…]/.test(words[i - 1])) i++;
    wordIdx = Math.min(i, words.length - 1);
  } else {
    let i = wordIdx - 2;
    while (i > 0 && !/[.!?…]/.test(words[i - 1])) i--;
    wordIdx = Math.max(0, i);
  }

  showWord();
  if (playing) { clearTimeout(wordTimer); scheduleNext(); }
}

function restartText() {
  if (!words.length) return;
  wordIdx = 0; elapsedSec = 0;
  if (playing) stopPlayback();
  showWord();
}

/* ──────────────────────────────────────
   WPM
────────────────────────────────────── */
function setWpm(v) {
  wpm = v;
  document.getElementById('wpm-display').textContent = v;
  saveSettings();
  if (playing) { clearTimeout(wordTimer); scheduleNext(); }
}

/* ──────────────────────────────────────
   File import
────────────────────────────────────── */
async function handleFile(file) {
  if (!file) return;

  try {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    let title = fileTitleFromName(file.name);
    let raw = '';
    let extra = {};

    if (ext === 'txt') {
      raw = await file.text();
    } else if (ext === 'md' || ext === 'markdown') {
      raw = markdownToText(await file.text());
    } else if (ext === 'pdf') {
      raw = await readPdfText(file);
    } else if (ext === 'epub') {
      const epub = await readEpubText(file);
      title = epub.title;
      raw = epub.raw;
      extra = { chapters: epub.chapters };
    } else {
      throw new Error('Only .txt, .md, .pdf, and .epub files are supported.');
    }

    if (!raw) throw new Error('No readable text was found in that file.');
    addLibraryEntry(title, raw, extra);
    selectText(library.length - 1);
  } catch (err) {
    alert(err?.message || 'Could not import that file.');
  }
}

function handleDrop(ev) {
  ev.preventDefault();
  document.getElementById('drop-zone').classList.remove('drag-over');
  const file = ev.dataTransfer.files[0];
  if (file) handleFile(file);
}

/* ──────────────────────────────────────
   Keyboard shortcuts
────────────────────────────────────── */
document.addEventListener('keydown', e => {
  const tag = document.activeElement.tagName;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return;

  switch (e.key) {
    case ' ':
      e.preventDefault();
      togglePlay();
      break;
    case 'ArrowRight':
      e.shiftKey ? skipSentence(1) : skipWord(5);
      break;
    case 'ArrowLeft':
      e.shiftKey ? skipSentence(-1) : skipWord(-5);
      break;
    case 'ArrowUp':
      wpm = Math.min(800, wpm + 50);
      document.getElementById('wpm-slider').value = wpm;
      setWpm(wpm);
      break;
    case 'ArrowDown':
      wpm = Math.max(60, wpm - 50);
      document.getElementById('wpm-slider').value = wpm;
      setWpm(wpm);
      break;
    case 'r':
    case 'R':
      restartText();
      break;
  }
});

/* ──────────────────────────────────────
   Service Worker registration
────────────────────────────────────── */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .catch(err => console.warn('SW registration failed:', err));
  });
}

/* ──────────────────────────────────────
   Initialise
────────────────────────────────────── */
function init() {
  loadAll();
  applyTheme();

  // Apply saved settings to UI
  document.getElementById('wpm-slider').value    = wpm;
  document.getElementById('wpm-display').textContent = wpm;
  document.getElementById('chunk-select').value  = chunkSize;
  document.getElementById('focal-select').value  = focalMode;
  document.getElementById('pause-punct').checked = pausePunct;
  document.getElementById('save-pos').checked    = savePos;

  // Seed library on first run
  if (!library.length) {
    const sample = `The Rose-bush did not know where she was born and where she spent her early days - it is a well known fact that flowers have a bad memory, but to make up for that they can see into the future. When she first became conscious of herself, she stood in the middle of a magnificent green lawn. To one side of her she saw a great white stone house, that gleamed through the branches of linden trees, to the other side stood a high trellised gate through which she could see the street. "She has bought you."

"That is something different. Then the poor woman must have worked hard to save so much money. Good! Half of my blossoms shall belong to her."

The man laughed a little sadly, saying, "Oh, beloved Rose-bush, you don't yet know the world, I can see that. The lady did not lift a finger to earn the money."

"Then how did she get it?"

"She owns a great factory in which countless workers drudge; from there comes her wealth."`;
    addLibraryEntry('the rose-bush', sample);
  }

  selectText(0);

  updateReaderCentering();
  syncReaderChrome();
  if (readerLayoutObserver) readerLayoutObserver.disconnect();
  if ('ResizeObserver' in window) {
    readerLayoutObserver = new ResizeObserver(updateReaderCentering);
    const footer = document.querySelector('.reader-footer');
    const progress = document.querySelector('.progress-bar-wrap');
    if (footer) readerLayoutObserver.observe(footer);
    if (progress) readerLayoutObserver.observe(progress);
  }
  window.addEventListener('resize', updateReaderCentering);
}

init();
