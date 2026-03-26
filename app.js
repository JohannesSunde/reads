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
    if (s.chunkSize) chunkSize = s.chunkSize;
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
        <div class="card-meta">${t.wordCount} words &middot; ~${Math.ceil(t.wordCount / wpm)} min at ${wpm} wpm</div>
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
  const ws      = tokenize(raw);

  library.push({ title, raw, wordCount: ws.length });
  saveLibrary();

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
  wordIdx     = (savePos && positions[i] != null)
                  ? Math.min(positions[i], words.length - 1)
                  : 0;
  elapsedSec  = 0;

  if (playing) stopPlayback();
  showWord();
  goView('reader');
}

/* ──────────────────────────────────────
   Tokenisation
────────────────────────────────────── */
function tokenize(text) {
  return text.split(/\s+/).filter(w => w.length > 0);
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

  const chunk = words.slice(wordIdx, wordIdx + chunkSize);
  const word  = chunk[0] || '';

  if (chunkSize > 1) {
    document.getElementById('w-before').textContent = '';
    document.getElementById('w-focal').textContent  = chunk.join(' ');
    document.getElementById('w-after').textContent  = '';
  } else {
    const fi = focalIndex(word);
    document.getElementById('w-before').textContent = word.slice(0, fi);
    document.getElementById('w-focal').textContent  = word[fi] || '';
    document.getElementById('w-after').textContent  = word.slice(fi + 1);
  }

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
}

function resetDisplay() {
  const hasText = words.length > 0;
  document.getElementById('idle-msg').style.display     = hasText ? 'none' : '';
  document.getElementById('focus-marker').style.display = hasText ? '' : 'none';
  document.getElementById('w-before').textContent = '';
  document.getElementById('w-focal').textContent  = '';
  document.getElementById('w-after').textContent  = '';
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
  scheduleNext();
  startElapsed();
}

function stopPlayback() {
  playing = false;
  document.getElementById('play-btn').textContent = '▶';
  clearTimeout(wordTimer);
  clearInterval(elapsedTimer);
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
    wordIdx = Math.min(wordIdx + chunkSize, words.length - 1);
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
function handleFile(file) {
  if (!file) return;

  if (file.name.endsWith('.txt')) {
    const reader = new FileReader();
    reader.onload = e => {
      const raw   = e.target.result.trim();
      const ws    = tokenize(raw);
      const title = file.name.replace(/\.txt$/i, '');
      library.push({ title, raw, wordCount: ws.length });
      saveLibrary();
      selectText(library.length - 1);
    };
    reader.readAsText(file);
  } else {
    alert('Only .txt files are supported in this version.');
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
    const sample = `Speed reading is a skill that can be developed with practice. The human eye can capture words in rapid succession when the brain is trained to process them without subvocalization. Most people read at around two hundred and fifty words per minute, but with practice and focus, five hundred or even six hundred words per minute is achievable without sacrificing comprehension. The key is to trust your brain. It processes language faster than you think. Let the words flow through you like a river. Each one lands in its place. You do not need to hear every word to understand it. The meaning assembles itself in the spaces between flashes. This is the principle behind RSVP reading. One word at a time. Perfectly centred. The red letter holds your gaze. The rest follows naturally, without effort, without strain. Just breath and words and the quiet hum of a mind in motion.`;
    library.push({ title: 'the art of reading fast', raw: sample, wordCount: tokenize(sample).length });
    saveLibrary();
  }

  selectText(0);
}

init();
