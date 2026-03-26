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
  if (v === 'reader') refreshReaderLayout();
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
  updateWordDisplayLayout();

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

function updateWordDisplayLayout() {
  const wordDisplay = document.getElementById('word-display');
  const centerWord = document.getElementById('w-center');
  if (!wordDisplay || !centerWord) return;

  if (wordDisplay.dataset.mode !== 'context') {
    wordDisplay.style.removeProperty('--center-half');
    return;
  }

  const centerWidth = centerWord.getBoundingClientRect().width;
  wordDisplay.style.setProperty('--center-half', `${centerWidth / 2}px`);
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

function refreshReaderLayout() {
  updateReaderCentering();
  updateWordDisplayLayout();
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
  document.getElementById('word-display').style.removeProperty('--center-half');
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
  {
    const sampleTitle = 'the rose-bush';
    const oldSeedTitle = 'the art of reading fast';
    const sample = [
      `The Rose-bush did not know where she was born and where she spent her early days - it is a well known fact that flowers have a bad memory, but to make up for that they can see into the future. When she first became conscious of herself, she stood in the middle of a magnificent green lawn. To one side of her she saw a great white stone house, that gleamed thru the branches of linden trees, to the other side stood a high trellised gate thru which she could see the street.`,
      `A thin tall man carefully tended the Rose-bush; he brought manure, bound the drooping twigs of the Rose-bush together with bark, brought water for the thirsty roots of the Rose-bush to drink. The Rose-bush was grateful to the man, and as the buds she was covered with opened into dainty red roses, she said to her friend, "You have taken care of me, it is because of you that I have become so beautiful. Take some of my loveliest blossoms in return."`,
      `The man shook his head. "You mean well, dear Rose-bush, and I would gladly take some of your beautiful blossoms for my sick wife. But I dare not do it. You don't belong to me."`,
      `"I don't belong to you!" exclaimed the Rose-bush. "Don't I belong to the person who has taken care of me and troubled himself about me? Then to whom do I belong?"`,
      `The man pointed with his hand to the gleaming white house among the trees and replied, "To the gracious lady who lives there."`,
      `"That can't be," replied the Rose-bush. "I have never seen this lady. It is not she who has sprinkled water on me, loosened the earth at my roots, bound together my twigs. Then how can I belong to her?"`,
      `"That is something different. Then the poor woman must have worked hard to save so much money. Good! Half of my blossoms shall belong to her."`,
      `The man laughed a little sadly, saying, "Oh, beloved Rose-bush, you don't yet know the world, I can see that. The lady did not lift a finger to earn the money."`,
      `"Then how did she get it?"`,
      `"She owns a great factory in which countless workers drudge; from there comes her wealth."`,
      `The Rose-bush became angry, lifted a bough up high, threatened the man with her thorn-claws, shouting, "I see you enjoy yourself at my expense because I am still young and inexperienced, telling me untruths about the world of men. Still I am not so stupid, I have observed ants and bees, and know that to each belongs the things for which he has worked."`,
      `"That may be so among bees and ants," the man sighed deeply, "yet among men it is different. There the people receive just enough to keep them from starving - all else belongs to the master. The master builds splendid mansions, plants lovely gardens, buys flowers."`,
      `"Is that really true?"`,
      `"Yes."`,
      `The man went back to his work and the Rose-bush began to meditate. Yet the longer she thought, the worse her temper grew. Yes, even tho she usually had very fine manners, she spoke roughly to a bee who wished to visit her. The bee was still young and timid, and flew off in fright as fast as his wings could carry him. Then the Rose-bush was sorry for her rough behavior, because she was naturally friendly, and also because she might have asked the bee whether the man had spoken the truth.`,
      `While she was so engrossed in thought, suddenly some one shook her and a mischievous voice asked, "Well, my friend, what are you dreaming about?"`,
      `The Rose-bush looked up with her countless eyes and recognized the Wind, that stood laughing before her shaking his head so that his long hair flew about.`,
      `"Wind, beloved Wind!" joyfully exclaimed the Rose-bush, "You come as tho you had been called. Tell me whether the man has spoken the truth." And she reported everything the man had said to her.`,
      `The Wind suddenly became serious and whistled thru his teeth so violently that the branches of the Rose-bush began to tremble. "Yes," declared he, "all this is true, and even worse. I come here from all over the whole world and see everything. Often I am so seized with anger that I begin to rave; then the stupid people say, 'My! what a storm!'`,
      `"And the rich people can really buy everything?"`,
      `"Yes," growled the wind. Then suddenly he laughed. "Not me. They can't capture and imprison me. I am the friend of the poor. I fly to all lands. In big cities, I station myself before ill-smelling cellars and roar into them 'Freedom! Justice!' To tired, overworked people I sing a lullaby, 'Be courageous, keep together, fight, you will conquer!' Then they feel new strength, they know a comrade has spoken to them." He tittered, and all the leaves in the garden stirred. "The rich would like to imprison me, because I carry the message, but I whistle at them. At night I rattle their windows so that they become frightened in their soft beds, and then I cry, 'Ho ho, you idlers, your time is coming. Make room for the workers of the world!' At that they are very frightened, draw the silken covers over their ears, try to comfort themselves: 'It was only the wind!'."`,
      `The Wind lifted one of his legs high and pushed it with all his weight against the magnificent white house. The windows clattered, many things in the house were broken, a woman's voice shrieked. The Wind laughed, then drew his leg back and said to the Rose-bush: "You also can do something, you flowers. Do not bloom for the rich idlers, and the fruit trees should not bear fruit. But you are pleasure-loving and lazy creatures. Look at the Tulips that stand up so sturdily all day, always saying nothing but 'How lovely we are!' They have no other interests."`,
      `The petals of the Rose-bush became a deeper red, so ashamed was she of her sister-flower.`,
      `The Wind noticed this and tried to comfort her. "You appear to be a sensible, kind-hearted bush. I shall visit you more often. Give me one of your petals as a parting gift." He took a deep red petal from a full blown rose. "Be happy - now I must leave."`,
      `At that moment two poorly-dressed pale children came along the street. They stopped before the gate and cried as tho with one voice, "Oh, the beautiful roses!" The little girl stretched her hands longingly toward the blossoms.`,
      `"Wind, beloved Wind," called the Rose-bush, as loud as she could. "Before you fly away, break off two of my loveliest roses and throw them to the children. But be careful that the petals do not drop off."`,
      `"Do you think I am so clumsy?" grumbled the insulted Wind, breaking off two handsome roses, and blew them lightly, gently to the children.`,
      `The children shouted joyfully, the Wind flew away, and the Rose-bush enjoyed the happiness of the children. Her enjoyment did not last long. An angry voice scolded the children. "What impudence is this, to steal the flowers out of my garden!"`,
      `The Rose-bush saw a silk-clad lady with fingers that were covered with rings threatening the children. Her smooth face was red with anger. The children were frightened and ran off crying.`,
      `The Rose-bush breathed deep with indignation and her breath blew sweeter perfume towards the lady's face. She stepped closer. "Ah, the beautiful roses. I had better pick them, otherwise the rabble from the streets will steal them. And they are such an expensive kind."`,
      `At this the Rose-bush became enraged, so that her blossoms blazed a fiery red. "If I were only strong as the wind," thought she, "I would get hold of this evil woman and shake her so that she would become deaf and blind. Such a common creature has a whole garden full of the most gorgeous flowers and begrudges the children for two paltry roses. But you shall not have even one of my blossoms, you bad woman, just wait."`,
      `And as the woman bent down to pick the flowers, the Rose-bush hit her in the face with a twig, stretching out all her thorns like a cat stretches out its claws, and scratched up the woman's face.`,
      `The Rose-bush was completely tired from the heated struggle. Her many green arms hung limply, her flowers were paler, she sighed softly. Yet she thought more deeply and arrived at a mighty resolution.`,
      `Late in the evening the Wind came flying to bid the Rose-bush good-night, and the Rose-bush said to him solemnly, "Listen to me, Brother Wind, I will follow your advice, I will no longer bloom for the idlers."`,
      `The Wind caressed the leaves and flowers of the Rose-bush with gentle hands, saying earnestly, "Poor little Rose-bush, will you have the strength for that? You will have to suffer a great deal."`,
      `"Yes," replied the Rose-bush, "I know it. But I will have the strength. Only you must come every day and sing your song of freedom, so as always to renew my courage."`,
      `The Wind promised to do this.`,
      `Then followed bad days for the Rose-bush, for she had decided not to drink any water, that she might cease blooming. When her friend came with the water pot she drew her little roots close to herself, that no drops might touch them. Ah, how she suffered! she thought she would faint. In the day-time the sun shone, and she became more thirsty every hour, always longing more for water. And at last, at evening came the longed for drink, but she dared not sip the full draught, she had to turn away from the cool precious liquid, to thirst again. After a while she thought she could not endure it. But the wind came flying, fanning her, singing softly and gently, "Be brave, be brave! You will conquer!"`,
      `Day after day the Rose-bush gazed at the gleaming white house in which lived people who had everything they wanted and then looked at the street where others passed by with thin, pale faces that were tired and sad, and this brought new strength to her heart.`,
      `She became constantly more sick and more weak; her arms hung down feebly, her blossoms dropped their petals, her leaves became wrinkled and yellow. The man who tended her watched her sadly and asked, "What is wrong, my poor Rose-bush?" and he tried every remedy he knew of to help her. But all in vain. One morning, instead of a handsome, blooming Rose-bush, he found a miserable, withered, dead bush.`,
      `That could not remain there, the withered branches and flowers spoiled the handsome garden. The gracious lady commanded that the Rose-bush be thrown out. As the man dug her up, the Rose-bush gathered her remaining strength and whispered beseechingly, "Take me home! Please, please take me home!"`,
      `The man fulfilled her wish. He planted the Rose-bush in a flower pot and took her to the poor, small room where he lived. His sick wife sat up in bed and said, "Ah, the poor Rose-bush, she is as sick as I am, but you will nurse us both back to health."`,
      `The withered leaves and twigs moaned, "Water! Water!" And the man understood them and brought in a jar of water. The Rose-bush drank. Oh! what delight this was! Eagerly her roots sucked up the water, the delicious moisture passing thru all her branches gave her new life. The next morning she could lift up her branches; the sick woman was as happy as a child and cried, "She will get well!"`,
      `And the Rose-bush really got well. In a short while she again became so beautiful that the poor little room was as fragrant as a garden. The pale cheeks of the woman became rosier every day, her strength was returning. "The Rose-bush has made me well," said she, and all the flowers on the Rose-bush glowed deep red with joy when she heard these words.`,
      `The man and his wife were kind people, they gladly shared the little they had, and carefully broke off some roses to bring joy to tired people in other lonely rooms.`,
      `The roses had other magic powers; the Rose-bush, in her days of struggle and suffering, had learned the songs of the Wind. Now her flowers sang them very softly for their friends, "Keep together! Fight! You will conquer!" Then the people said, "How strange! The perfume of the flowers brings us new strength. We will fight together for a better world."`,
      `But to the little children the roses sang in a tender, loving voice: "Little children, when you are grown up, you will no longer stand sadly before the gate. The whole world will belong to those who work, the whole world!"`,
    ].join('\n\n');

    const existingIdx = library.findIndex(t => t.title === oldSeedTitle);
    if (existingIdx >= 0) {
      library[existingIdx] = { title: sampleTitle, raw: sample, wordCount: tokenize(sample).length };
      saveLibrary();
      activeIdx = existingIdx;
    } else if (!library.length) {
      addLibraryEntry(sampleTitle, sample);
      activeIdx = 0;
    }

    if (activeIdx != null) selectText(activeIdx);
    else if (library.length) selectText(0);
  }

  refreshReaderLayout();
  syncReaderChrome();
  if (readerLayoutObserver) readerLayoutObserver.disconnect();
  if ('ResizeObserver' in window) {
    readerLayoutObserver = new ResizeObserver(refreshReaderLayout);
    const footer = document.querySelector('.reader-footer');
    const progress = document.querySelector('.progress-bar-wrap');
    if (footer) readerLayoutObserver.observe(footer);
    if (progress) readerLayoutObserver.observe(progress);
  }
  window.addEventListener('resize', refreshReaderLayout);
}

init();
