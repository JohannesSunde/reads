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
let reviewOpenIdx   = null;

let wpm        = 250;
let chunkSize  = 1;
let focalMode  = 'auto';
let pausePunct = true;
let savePos    = true;
let textScale  = 100;
let cleanApaCitations = false;
let cleanPdfPageChrome = true;
let theme      = 'dark';

let playing      = false;
let wordTimer    = null;
let readerLayoutObserver = null;
let readerChromeTimer = null;
let noteworthyFlashTimer = null;
let noteworthyFlashPending = false;
let supabaseClient = null;
let authUser = null;
let authReady = false;
let syncTimer = null;
let syncInFlight = null;
let syncSchedulingSuspended = false;
let syncStatus = {
  tone: 'muted',
  text: 'local-only mode',
};

function nowIso() {
  return new Date().toISOString();
}

function createClientId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return 'reads-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function isIsoDate(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function toTimestamp(value, fallback = 0) {
  const ts = Date.parse(value || '');
  return Number.isNaN(ts) ? fallback : ts;
}

function normalizeProgressEntry(value) {
  if (Number.isInteger(value)) {
    return {
      wordIdx: Math.max(0, value),
      updatedAt: nowIso(),
    };
  }

  if (value && typeof value === 'object') {
    return {
      wordIdx: Math.max(0, Number(value.wordIdx) || 0),
      updatedAt: isIsoDate(value.updatedAt) ? value.updatedAt : nowIso(),
    };
  }

  return null;
}

function getSupabaseConfig() {
  const config = window.READS_SUPABASE_CONFIG || {};
  return {
    url: typeof config.url === 'string' ? config.url.trim() : '',
    key: typeof config.key === 'string' ? config.key.trim() : '',
  };
}

function hasSupabaseConfig() {
  const config = getSupabaseConfig();
  return Boolean(config.url && config.key && window.supabase?.createClient);
}

function getActiveEntry() {
  return activeIdx === null ? null : library[activeIdx] || null;
}

function getStoredProgress(entryId) {
  const record = normalizeProgressEntry(positions[entryId]);
  return record || { wordIdx: 0, updatedAt: null };
}

function setStoredProgress(entryId, nextWordIdx, updatedAt = nowIso()) {
  positions[entryId] = {
    wordIdx: Math.max(0, Number(nextWordIdx) || 0),
    updatedAt,
  };
}

function touchEntry(entry, updatedAt = nowIso()) {
  if (!entry) return;
  entry.updatedAt = updatedAt;
}

function withSyncSchedulingSuspended(fn) {
  syncSchedulingSuspended = true;
  try {
    return fn();
  } finally {
    syncSchedulingSuspended = false;
  }
}

function isMobileLandscapeViewport() {
  const isLandscape = window.matchMedia('(orientation: landscape)').matches;
  const hasCoarsePointer = window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
  const isCompactViewport = window.innerHeight <= 600;
  return isLandscape && hasCoarsePointer && isCompactViewport;
}

/* ──────────────────────────────────────
   Persistence
────────────────────────────────────── */
function loadAll() {
  try { library   = JSON.parse(localStorage.getItem(KEYS.library)   || '[]'); } catch { library = []; }
  try { positions = JSON.parse(localStorage.getItem(KEYS.positions) || '{}'); } catch { positions = {}; }
  library = Array.isArray(library) ? library.map(normalizeLibraryEntry) : [];
  positions = migratePositions(positions, library);

  theme = localStorage.getItem(KEYS.theme) || 'dark';

  try {
    const s = JSON.parse(localStorage.getItem(KEYS.settings) || '{}');
    if (s.wpm)       wpm       = s.wpm;
    if (s.chunkSize === 1 || s.chunkSize === 3) chunkSize = s.chunkSize;
    else if (s.chunkSize === 2) chunkSize = 3;
    if (s.focalMode) focalMode = s.focalMode;
    if (typeof s.pausePunct === 'boolean') pausePunct = s.pausePunct;
    if (typeof s.savePos    === 'boolean') savePos    = s.savePos;
    if (typeof s.textScale  === 'number' && s.textScale >= 50 && s.textScale <= 140) textScale = s.textScale;
    if (typeof s.cleanApaCitations === 'boolean') cleanApaCitations = s.cleanApaCitations;
    if (typeof s.cleanPdfPageChrome === 'boolean') cleanPdfPageChrome = s.cleanPdfPageChrome;
  } catch { /* use defaults */ }
}

function saveLibrary() {
  localStorage.setItem(KEYS.library, JSON.stringify(library));
  if (!syncSchedulingSuspended) queueCloudSync(1200);
}

function savePositions() {
  localStorage.setItem(KEYS.positions, JSON.stringify(positions));
  if (!syncSchedulingSuspended) queueCloudSync(5000);
}

function saveSettings() {
  localStorage.setItem(KEYS.settings, JSON.stringify({
    wpm,
    chunkSize,
    focalMode,
    pausePunct,
    savePos,
    textScale,
    cleanApaCitations,
    cleanPdfPageChrome,
  }));
}

function normalizeLibraryEntry(entry) {
  const createdAt = isIsoDate(entry?.createdAt) ? entry.createdAt : nowIso();
  const normalized = {
    ...entry,
    id: String(entry?.id || entry?.clientId || createClientId()),
    createdAt,
    updatedAt: isIsoDate(entry?.updatedAt) ? entry.updatedAt : createdAt,
    chapters: Array.isArray(entry?.chapters) ? entry.chapters : [],
    noteworthy: Array.isArray(entry?.noteworthy)
      ? entry.noteworthy
          .filter(mark => Number.isInteger(mark?.start) && Number.isInteger(mark?.end))
          .map(mark => ({
            start: mark.start,
            end: mark.end,
            text: String(mark.text || '').trim(),
          }))
      : [],
  };

  if (!normalized.wordCount) {
    normalized.wordCount = tokenize(normalized.raw || '').length;
  }

  return normalized;
}

function migratePositions(rawPositions, entries) {
  const migrated = {};
  if (!rawPositions || typeof rawPositions !== 'object') return migrated;

  Object.entries(rawPositions).forEach(([key, value]) => {
    const normalized = normalizeProgressEntry(value);
    if (!normalized) return;

    const idx = Number(key);
    if (Number.isInteger(idx) && entries[idx]?.id) {
      migrated[entries[idx].id] = normalized;
      return;
    }

    migrated[key] = normalized;
  });

  return migrated;
}

/* ──────────────────────────────────────
   Theme
────────────────────────────────────── */
function applyTheme() {
  document.body.setAttribute('data-theme', theme);
  const themeIcon = theme === 'dark' ? '◐' : '◑';
  document.getElementById('theme-btn').textContent = themeIcon;
  document.querySelectorAll('.nav-theme-btn').forEach(btn => {
    btn.innerHTML = `<span class="nav-icon">${themeIcon}</span>theme`;
  });
  const themeSettingBtn = document.getElementById('theme-setting-btn');
  if (themeSettingBtn) themeSettingBtn.textContent = theme === 'dark' ? 'use light' : 'use dark';
  // Update theme-color meta for browser chrome
  const meta = document.getElementById('theme-meta');
  if (meta) meta.content = theme === 'dark' ? '#0a0a0a' : '#f5f0e8';
}

function toggleTheme() {
  theme = theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem(KEYS.theme, theme);
  applyTheme();
}

function applyTextScale() {
  document.documentElement.style.setProperty('--reader-type-scale', String(textScale / 100));
}

function setSyncStatus(tone, text) {
  syncStatus = { tone, text };
  updateCloudUi();
}

function updateCloudUi() {
  const badge = document.getElementById('cloud-status-badge');
  const detail = document.getElementById('cloud-auth-detail');
  const summary = document.getElementById('cloud-auth-summary');
  const emailInput = document.getElementById('cloud-email');
  const sendLinkBtn = document.getElementById('cloud-send-link');
  const syncBtn = document.getElementById('cloud-sync-now');
  const signOutBtn = document.getElementById('cloud-sign-out');
  if (!badge || !detail || !summary || !emailInput || !sendLinkBtn || !syncBtn || !signOutBtn) return;

  badge.textContent = syncStatus.text;
  badge.dataset.tone = syncStatus.tone;

  const configured = hasSupabaseConfig();
  const signedIn = Boolean(authUser);

  if (!configured) {
    detail.textContent = 'Add your Supabase publishable key in supabase-config.js to enable cloud sync.';
    summary.textContent = 'Local reading stays available even when cloud sync is disabled.';
    emailInput.disabled = true;
    sendLinkBtn.disabled = true;
    syncBtn.disabled = true;
    signOutBtn.disabled = true;
    return;
  }

  if (!authReady) {
    detail.textContent = 'Checking cloud sync...';
    summary.textContent = 'Invite-only accounts can sync libraries, highlights, and reading progress.';
    emailInput.disabled = true;
    sendLinkBtn.disabled = true;
    syncBtn.disabled = true;
    signOutBtn.disabled = true;
    return;
  }

  if (!signedIn) {
    detail.textContent = 'Invite-only sync. Enter an invited email to receive a sign-in link.';
    summary.textContent = 'No account is required to keep using the app locally on this device.';
    emailInput.disabled = false;
    sendLinkBtn.disabled = false;
    syncBtn.disabled = true;
    signOutBtn.disabled = true;
    return;
  }

  detail.textContent = `Signed in as ${authUser.email || 'an invited reader'}.`;
  summary.textContent = 'Your local library remains the primary copy until a cloud sync completes.';
  emailInput.disabled = true;
  sendLinkBtn.disabled = true;
  syncBtn.disabled = false;
  signOutBtn.disabled = false;
}

function queueCloudSync(delay = 1500) {
  if (!supabaseClient || !authUser) return;
  clearTimeout(syncTimer);
  syncTimer = window.setTimeout(() => {
    syncLibraryWithCloud({ silent: true });
  }, delay);
}

function buildRemotePayload(entry) {
  const progress = getStoredProgress(entry.id);
  return {
    user_id: authUser.id,
    client_id: entry.id,
    title: entry.title,
    raw_text: entry.raw,
    word_count: entry.wordCount,
    chapters: entry.chapters || [],
    noteworthy: entry.noteworthy || [],
    progress_word_idx: progress.wordIdx,
    progress_updated_at: progress.updatedAt || entry.updatedAt || nowIso(),
    created_at: entry.createdAt || nowIso(),
    updated_at: entry.updatedAt || nowIso(),
    last_synced_at: nowIso(),
  };
}

function buildLocalEntryFromRemote(row) {
  return {
    entry: normalizeLibraryEntry({
      id: row.client_id,
      title: row.title,
      raw: row.raw_text,
      wordCount: row.word_count,
      chapters: row.chapters,
      noteworthy: row.noteworthy,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }),
    progress: {
      wordIdx: Math.max(0, Number(row.progress_word_idx) || 0),
      updatedAt: isIsoDate(row.progress_updated_at) ? row.progress_updated_at : row.updated_at,
    },
  };
}

function mergeLocalAndRemote(localEntries, localPositions, remoteRows) {
  const mergedLibrary = localEntries.map(entry => normalizeLibraryEntry({ ...entry }));
  const mergedPositions = { ...localPositions };
  const localById = new Map(mergedLibrary.map(entry => [entry.id, entry]));

  remoteRows.forEach(row => {
    const remote = buildLocalEntryFromRemote(row);
    const local = localById.get(remote.entry.id);

    if (!local) {
      mergedLibrary.push(remote.entry);
      mergedPositions[remote.entry.id] = remote.progress;
      localById.set(remote.entry.id, remote.entry);
      return;
    }

    if (toTimestamp(remote.entry.updatedAt) > toTimestamp(local.updatedAt)) {
      local.title = remote.entry.title;
      local.raw = remote.entry.raw;
      local.wordCount = remote.entry.wordCount;
      local.chapters = remote.entry.chapters;
      local.noteworthy = remote.entry.noteworthy;
      local.createdAt = remote.entry.createdAt;
      local.updatedAt = remote.entry.updatedAt;
    }

    const localProgress = getStoredProgress(local.id);
    if (toTimestamp(remote.progress.updatedAt) > toTimestamp(localProgress.updatedAt)) {
      mergedPositions[local.id] = remote.progress;
    }
  });

  return { mergedLibrary, mergedPositions };
}

function applyMergedLibrary(mergedLibrary, mergedPositions, preferredActiveId = null) {
  const currentView = document.querySelector('.view.active')?.id?.replace('-view', '') || 'reader';
  const activeId = preferredActiveId || getActiveEntry()?.id || null;

  withSyncSchedulingSuspended(() => {
    library = mergedLibrary.map(entry => normalizeLibraryEntry(entry));
    positions = migratePositions(mergedPositions, library);
    saveLibrary();
    savePositions();
  });

  renderLibrary();

  if (!library.length) {
    activeIdx = null;
    words = [];
    wordIdx = 0;
    resetDisplay();
    return;
  }

  const nextIdx = activeId ? library.findIndex(entry => entry.id === activeId) : -1;
  if (nextIdx >= 0) {
    selectText(nextIdx);
    if (currentView !== 'reader') goView(currentView);
  } else if (activeIdx !== null && library[activeIdx]) {
    selectText(activeIdx);
    if (currentView !== 'reader') goView(currentView);
  }
}

async function deleteRemoteLibraryItem(entryId) {
  if (!supabaseClient || !authUser || !entryId) return;

  const { error } = await supabaseClient
    .from('library_items')
    .delete()
    .eq('user_id', authUser.id)
    .eq('client_id', entryId);

  if (error) {
    console.warn('Remote delete failed:', error.message || error);
    setSyncStatus('error', 'delete pending sync retry');
    queueCloudSync(1500);
  }
}

async function syncLibraryWithCloud({ silent = false } = {}) {
  if (!supabaseClient || !authUser) return false;
  if (syncInFlight) return syncInFlight;

  syncInFlight = (async () => {
    if (!silent) setSyncStatus('working', 'syncing...');

    const activeId = getActiveEntry()?.id || null;
    const { data: remoteRows, error: fetchError } = await supabaseClient
      .from('library_items')
      .select('client_id, title, raw_text, word_count, chapters, noteworthy, progress_word_idx, progress_updated_at, created_at, updated_at')
      .eq('user_id', authUser.id)
      .order('updated_at', { ascending: false });

    if (fetchError) throw fetchError;

    const { mergedLibrary, mergedPositions } = mergeLocalAndRemote(library, positions, remoteRows || []);
    applyMergedLibrary(mergedLibrary, mergedPositions, activeId);

    if (mergedLibrary.length) {
      const payload = mergedLibrary.map(buildRemotePayload);
      const { error: upsertError } = await supabaseClient
        .from('library_items')
        .upsert(payload, { onConflict: 'user_id,client_id' });

      if (upsertError) throw upsertError;
    }

    setSyncStatus('success', `synced ${mergedLibrary.length} item${mergedLibrary.length === 1 ? '' : 's'}`);
    return true;
  })().catch(err => {
    console.warn('Cloud sync failed:', err?.message || err);
    setSyncStatus('error', 'cloud sync failed');
    return false;
  }).finally(() => {
    syncInFlight = null;
  });

  return syncInFlight;
}

async function sendCloudMagicLink() {
  if (!supabaseClient) return;
  const emailInput = document.getElementById('cloud-email');
  const email = String(emailInput?.value || '').trim();
  if (!email) {
    setSyncStatus('error', 'enter an invited email');
    return;
  }

  setSyncStatus('working', 'sending sign-in link...');

  const redirectUrl = window.location.href.split('#')[0];
  const { error } = await supabaseClient.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: false,
      emailRedirectTo: redirectUrl,
    },
  });

  if (error) {
    setSyncStatus('error', 'no invite found for that email');
    return;
  }

  setSyncStatus('success', 'check your inbox');
}

async function signOutCloud() {
  if (!supabaseClient) return;
  const { error } = await supabaseClient.auth.signOut();
  if (error) {
    setSyncStatus('error', 'sign-out failed');
    return;
  }
  setSyncStatus('muted', 'local-only mode');
}

async function initCloudSync() {
  if (!hasSupabaseConfig()) {
    authReady = true;
    setSyncStatus('muted', 'cloud not configured');
    return;
  }

  const { url, key } = getSupabaseConfig();
  supabaseClient = window.supabase.createClient(url, key, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });

  const { data, error } = await supabaseClient.auth.getSession();
  if (error) {
    console.warn('Could not restore auth session:', error.message || error);
  }

  authUser = data?.session?.user || null;
  authReady = true;

  supabaseClient.auth.onAuthStateChange((_event, session) => {
    authUser = session?.user || null;
    if (authUser) {
      setSyncStatus('working', 'connected to cloud');
      syncLibraryWithCloud();
    } else {
      setSyncStatus(hasSupabaseConfig() ? 'muted' : 'error', hasSupabaseConfig() ? 'local-only mode' : 'cloud not configured');
      updateCloudUi();
    }
  });

  setSyncStatus(authUser ? 'working' : 'muted', authUser ? 'connected to cloud' : 'local-only mode');
  updateCloudUi();

  if (authUser) {
    await syncLibraryWithCloud({ silent: true });
  }
}

/* ──────────────────────────────────────
   Navigation
────────────────────────────────────── */
function goView(v) {
  document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
  document.getElementById(v + '-view').classList.add('active');
  document.body.classList.toggle('reader-view-active', v === 'reader');
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

function renderLibraryLegacyOriginal() {
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
  const entry = library[i];
  library.splice(i, 1);
  if (reviewOpenIdx === i) reviewOpenIdx = null;
  else if (reviewOpenIdx > i) reviewOpenIdx--;

  if (activeIdx === i) {
    activeIdx = null; words = []; wordIdx = 0;
    resetDisplay();
  } else if (activeIdx > i) {
    activeIdx--;
  }

  if (entry?.id) delete positions[entry.id];

  saveLibrary();
  savePositions();
  if (entry?.id && authUser) {
    deleteRemoteLibraryItem(entry.id);
  }
  renderLibrary();
}

function renderLibraryLegacySimple() {
  const list = document.getElementById('text-list');
  if (!library.length) {
    list.innerHTML = '<div class="empty-state">your library is empty â€” add a text below</div>';
    return;
  }

  list.innerHTML = library.map((t, i) => `
    <div class="text-card-wrap ${reviewOpenIdx === i ? 'review-open' : ''}">
      <div class="text-card ${activeIdx === i ? 'active-text' : ''}" onclick="selectText(${i})">
        <div class="card-info">
          <div class="card-title">${esc(t.title)}</div>
          <div class="card-meta">${t.wordCount} words${t.chapters?.length ? ` &middot; ${t.chapters.length} chapters` : ''} &middot; ~${Math.ceil(t.wordCount / wpm)} min at ${wpm} wpm${t.noteworthy?.length ? ` &middot; ${t.noteworthy.length} noteworthy` : ''}</div>
        </div>
        <div class="card-actions">
          ${t.noteworthy?.length ? `<button class="card-review" title="Review noteworthy passages" onclick="event.stopPropagation(); toggleReview(${i})">${reviewOpenIdx === i ? 'hide' : 'review'}</button>` : ''}
          <button class="card-del" title="Remove" onclick="event.stopPropagation(); deleteText(${i})">âœ•</button>
        </div>
      </div>
      ${reviewOpenIdx === i ? renderReviewPanel(t, i) : ''}
    </div>
  `).join('');
}

function renderReviewPanel(entry, idx) {
  if (!entry.noteworthy?.length) return '';
  const noteworthyTexts = entry.noteworthy
    .map(mark => mark.text || buildStoredSentenceText(idx, mark.start, mark.end))
    .filter(Boolean);

  const paragraphs = String(entry.raw || '')
    .split(/\n{2,}/)
    .map(paragraph => paragraph.trim())
    .filter(Boolean)
    .map(paragraph => `<p class="review-paragraph">${highlightReviewText(paragraph, noteworthyTexts)}</p>`)
    .join('');

  return `
    <div class="review-panel">
      <div class="review-panel-title">full text</div>
      <div class="review-fulltext">${paragraphs}</div>
    </div>
  `;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function highlightReviewText(text, noteworthyTexts = []) {
  let html = esc(text);
  noteworthyTexts
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .forEach(sentence => {
      const sentenceText = esc(sentence);
      if (html.includes(sentenceText)) {
        html = html.split(sentenceText).join(`<mark>${sentenceText}</mark>`);
        return;
      }

      const pattern = sentenceText
        .trim()
        .split(/\s+/)
        .map(escapeRegExp)
        .join('\\s+');

      if (!pattern) return;
      html = html.replace(new RegExp(pattern, 'g'), match => `<mark>${match}</mark>`);
    });
  return html;
}

function buildStoredSentenceText(entryIdx, start, end) {
  const entry = library[entryIdx];
  if (!entry?.raw) return '';
  return tokenize(entry.raw).slice(start, end + 1).join(' ').trim();
}

function toggleReview(i) {
  reviewOpenIdx = reviewOpenIdx === i ? null : i;
  renderLibrary();
}

function jumpToNoteworthy(i, startIdx) {
  selectText(i);
  setWordPosition(startIdx);
  goView('reader');
}

function renderLibrary() {
  const list = document.getElementById('text-list');
  if (!library.length) {
    list.innerHTML = '<div class="empty-state">your library is empty - add a text below</div>';
    return;
  }

  list.innerHTML = library.map((t, i) => `
    <div class="text-card-wrap ${reviewOpenIdx === i ? 'review-open' : ''}">
      <div class="text-card ${activeIdx === i ? 'active-text' : ''}" onclick="selectText(${i})">
        <div class="card-info">
          <div class="card-title">${esc(t.title)}</div>
          <div class="card-meta">${t.wordCount} words${t.chapters?.length ? ` &middot; ${t.chapters.length} chapters` : ''} &middot; ~${Math.ceil(t.wordCount / wpm)} min at ${wpm} wpm${t.noteworthy?.length ? ` &middot; ${t.noteworthy.length} noteworthy` : ''}</div>
        </div>
        <div class="card-actions">
          ${t.noteworthy?.length ? `<button class="card-review" title="Review noteworthy passages" onclick="event.stopPropagation(); toggleReview(${i})">${reviewOpenIdx === i ? 'hide' : 'review'}</button>` : ''}
          <button class="card-del" title="Remove" onclick="event.stopPropagation(); deleteText(${i})">x</button>
        </div>
      </div>
      ${reviewOpenIdx === i ? renderReviewPanel(t, i) : ''}
    </div>
  `).join('');
}

function selectText(i) {
  activeIdx   = i;
  const entry = library[i];
  words       = tokenize(entry.raw);
  currentChapters = Array.isArray(entry.chapters) ? entry.chapters : [];
  chapterStarts   = buildChapterStarts(currentChapters);
  chapterIdx      = 0;
  const storedProgress = getStoredProgress(entry.id);
  wordIdx     = (savePos && storedProgress.wordIdx != null)
                  ? Math.min(storedProgress.wordIdx, words.length - 1)
                  : 0;

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
  return String(text || '')
    .replace(/([\p{L}\p{N}])([-–—])([\p{L}\p{N}])/gu, '$1$2 $3')
    .split(/\s+/)
    .filter(w => w.length > 0);
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

function setCleanApaCitations(enabled) {
  cleanApaCitations = Boolean(enabled);
  saveSettings();
}

function setCleanPdfPageChrome(enabled) {
  cleanPdfPageChrome = Boolean(enabled);
  saveSettings();
}

function normalizePdfLineKey(line) {
  return String(line || '')
    .toLowerCase()
    .replace(/\b(?:page|pp?)\.?\s*\d+\b/gi, 'page #')
    .replace(/\b\d+\b/g, '#')
    .replace(/\b[ivxlcdm]+\b/gi, '#')
    .replace(/[^\p{L}\p{N}#]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function shouldConsiderPdfChromeLine(line) {
  const normalized = normalizeImportedText(line);
  if (!normalized) return false;
  if (normalized.length > 160) return false;
  return normalizePdfLineKey(normalized).length >= 4;
}

function isLikelyApaCitationSegment(segment) {
  const trimmed = String(segment || '').trim();
  if (!trimmed) return false;

  const cleaned = trimmed
    .replace(/^(?:see(?: also)?|e\.g\.,?|i\.e\.,?|cf\.|compare|for reviews?, see)\s+/i, '')
    .trim();

  const yearMatch = cleaned.match(/\b(?:17|18|19|20)\d{2}[a-z]?\b/);
  if (!yearMatch) return false;

  const beforeYear = cleaned.slice(0, yearMatch.index).trim().replace(/[,\s]+$/, '');
  const afterYear = cleaned.slice((yearMatch.index || 0) + yearMatch[0].length).trim();

  if (!beforeYear) return false;
  if (beforeYear.split(/\s+/).length > 12) return false;

  const hasAuthorPattern =
    /\bet al\.\b/i.test(beforeYear) ||
    /(?:^|[\s,(])(?:[A-Z][\p{L}'-]+)(?:\s*,\s*(?:[A-Z][\p{L}'-]+))*\s*(?:&|and)\s*(?:[A-Z][\p{L}'-]+)$/u.test(beforeYear) ||
    /(?:^|[\s,(])(?:[A-Z][\p{L}'-]+)$/u.test(beforeYear);

  if (!hasAuthorPattern) return false;

  if (!afterYear) return true;

  return /^[,;\s]*(?:(?:p|pp|chap|chapter|sec|section|para|paras|figure|fig|table|tables|appendix|appendices|n)\.?\s*)?[\d\-–, ]*[a-z]?[,;\s]*$/i.test(afterYear);
}

function isLikelyApaCitation(body) {
  const trimmed = String(body || '').trim();
  if (!trimmed || trimmed.length > 220 || /\n/.test(trimmed)) return false;

  const segments = trimmed.split(/\s*;\s*/).filter(Boolean);
  if (!segments.length) return false;

  return segments.every(isLikelyApaCitationSegment);
}

function stripApaCitations(text) {
  let previous = String(text || '');
  let current = previous.replace(/\(([^()\n]{3,220})\)/g, (match, body) => (
    isLikelyApaCitation(body) ? '' : match
  ));

  while (current !== previous) {
    previous = current;
    current = current.replace(/\(([^()\n]{3,220})\)/g, (match, body) => (
      isLikelyApaCitation(body) ? '' : match
    ));
  }

  current = current
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\(\s*\)/g, '')
    .replace(/,\s*,/g, ',')
    .replace(/\n{3,}/g, '\n\n');

  return normalizeImportedText(current);
}

function extractPdfLines(items) {
  const positioned = (items || [])
    .map(item => ({
      str: String(item?.str || '').trim(),
      x: Number(item?.transform?.[4] || 0),
      y: Number(item?.transform?.[5] || 0),
    }))
    .filter(item => item.str);

  if (!positioned.length) return [];

  positioned.sort((a, b) => {
    if (Math.abs(b.y - a.y) > 2.5) return b.y - a.y;
    return a.x - b.x;
  });

  const lines = [];
  let current = [];
  let currentY = null;

  for (const item of positioned) {
    if (currentY === null || Math.abs(item.y - currentY) <= 2.5) {
      current.push(item);
      currentY = currentY === null ? item.y : (currentY + item.y) / 2;
      continue;
    }

    lines.push(current);
    current = [item];
    currentY = item.y;
  }

  if (current.length) lines.push(current);

  return lines
    .map(lineItems => lineItems
      .sort((a, b) => a.x - b.x)
      .map(item => item.str)
      .join(' '))
    .map(normalizeImportedText)
    .filter(Boolean);
}

function stripRepeatedPdfPageChrome(pages) {
  if (!Array.isArray(pages) || pages.length < 2) return pages;

  const topCounts = new Map();
  const bottomCounts = new Map();
  const edgeDepth = 3;

  for (const page of pages) {
    const topLines = (page.lines || []).slice(0, edgeDepth);
    const bottomLines = (page.lines || []).slice(-edgeDepth);

    for (const line of topLines) {
      if (!shouldConsiderPdfChromeLine(line)) continue;
      const key = normalizePdfLineKey(line);
      topCounts.set(key, (topCounts.get(key) || 0) + 1);
    }

    for (const line of bottomLines) {
      if (!shouldConsiderPdfChromeLine(line)) continue;
      const key = normalizePdfLineKey(line);
      bottomCounts.set(key, (bottomCounts.get(key) || 0) + 1);
    }
  }

  const threshold = Math.max(2, Math.ceil(pages.length * 0.5));
  const repeatedTop = new Set([...topCounts.entries()].filter(([, count]) => count >= threshold).map(([key]) => key));
  const repeatedBottom = new Set([...bottomCounts.entries()].filter(([, count]) => count >= threshold).map(([key]) => key));

  return pages.map(page => {
    const lines = [...(page.lines || [])];

    while (lines.length) {
      const key = normalizePdfLineKey(lines[0]);
      if (!repeatedTop.has(key)) break;
      lines.shift();
    }

    while (lines.length) {
      const key = normalizePdfLineKey(lines[lines.length - 1]);
      if (!repeatedBottom.has(key)) break;
      lines.pop();
    }

    return {
      ...page,
      lines,
    };
  });
}

function applyImportCleanup(text, options = {}) {
  let cleaned = normalizeImportedText(text);

  if (options.cleanApaCitations) {
    cleaned = stripApaCitations(cleaned);
  }

  return normalizeImportedText(cleaned);
}

function addLibraryEntry(title, raw, extra = {}) {
  const normalized = normalizeImportedText(raw);
  const ws = tokenize(normalized);
  const entry = normalizeLibraryEntry({ title, raw: normalized, wordCount: ws.length, noteworthy: [], ...extra });
  library.push(entry);
  setStoredProgress(entry.id, 0);
  saveLibrary();
  savePositions();
}

function trimTrailingClosers(word) {
  return String(word || '').replace(/["')\]\}\u2019\u201d\u00bb]+$/u, '');
}

function hasSentencePause(word) {
  return /[.!?\u2026]$/u.test(trimTrailingClosers(word));
}

function hasClausePause(word) {
  return /[,;:\-\u2013\u2014]$/u.test(trimTrailingClosers(word));
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
  const normalizedBase = normalizeArchivePath(basePath);
  const baseParts = normalizedBase.split('/').filter(Boolean);
  if (baseParts.length && !normalizedBase.endsWith('/')) baseParts.pop();
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

function normalizeArchivePath(path) {
  return String(path || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .trim();
}

function safeDecodeArchivePath(path) {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function getZipFileByPath(zip, path) {
  const candidates = new Set(
    [normalizeArchivePath(path), normalizeArchivePath(safeDecodeArchivePath(path))]
      .filter(Boolean)
  );

  for (const candidate of candidates) {
    const direct = zip.file(candidate);
    if (direct) return direct;
  }

  const lowerCandidates = new Set([...candidates].map(candidate => candidate.toLowerCase()));
  return Object.values(zip.files || {}).find(entry => (
    !entry.dir && lowerCandidates.has(normalizeArchivePath(entry.name).toLowerCase())
  )) || null;
}

function parseEpubDocument(markup) {
  const parser = new DOMParser();
  const xhtmlDoc = parser.parseFromString(markup, 'application/xhtml+xml');
  if (!xhtmlDoc.querySelector('parsererror')) return xhtmlDoc;
  return parser.parseFromString(markup, 'text/html');
}

function extractEpubBodyText(doc) {
  if (!doc) return '';
  const body =
    doc.querySelector?.('body') ||
    doc.getElementsByTagNameNS?.('*', 'body')?.[0] ||
    doc.documentElement;

  if (!body) return '';

  const clone = body.cloneNode(true);
  clone.querySelectorAll?.('script,style,noscript').forEach(el => el.remove());
  return normalizeImportedText(clone.textContent || '');
}

function getFirstDocumentText(doc, selectors = []) {
  for (const selector of selectors) {
    const node =
      doc.querySelector?.(selector) ||
      doc.getElementsByTagNameNS?.('*', selector)?.[0] ||
      doc.getElementsByTagName?.(selector)?.[0];

    const text = normalizeImportedText(node?.textContent || '');
    if (text) return text;
  }

  return '';
}

function extractChapterTitle(doc, fallback) {
  return getFirstDocumentText(doc, ['title', 'h1', 'h2', 'h3']) || normalizeImportedText(fallback || '');
}

function isEpubContentDocument(item) {
  const mediaType = String(item?.mediaType || '').toLowerCase();
  const href = String(item?.href || '').toLowerCase();

  if (/application\/(?:xhtml\+xml|xml|x-dtbook\+xml)|text\/html/.test(mediaType)) return true;
  if (/\.(?:xhtml|html|htm|xml)$/i.test(href)) return true;
  return false;
}

function shouldSkipEpubManifestItem(item) {
  const properties = String(item?.properties || '').toLowerCase();
  const href = String(item?.href || '').toLowerCase();
  return (
    /\bnav\b/.test(properties) ||
    /(?:^|\/)(?:toc|nav)(?:[._-]|$)/.test(href)
  );
}

function buildEpubChapter(zip, basePath, item, fallbackTitle) {
  if (!isEpubContentDocument(item) || shouldSkipEpubManifestItem(item)) return null;

  const path = resolveEpubPath(basePath, item.href);
  const chapterFile = getZipFileByPath(zip, path);
  if (!chapterFile) return null;

  return chapterFile.async('text').then(chapterHtml => {
    const chapterDoc = parseEpubDocument(chapterHtml);
    const chapterText = extractEpubBodyText(chapterDoc);
    if (!chapterText) return null;

    return {
      title: extractChapterTitle(chapterDoc, fallbackTitle || item.href),
      raw: chapterText,
      wordCount: tokenize(chapterText).length,
    };
  });
}

async function readPdfText(file, options = {}) {
  if (window.__pdfjsReady) await window.__pdfjsReady;
  if (!window.pdfjsLib) throw new Error('PDF support is unavailable.');
  const data = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  let pages = [];

  for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
    const page = await pdf.getPage(pageNo);
    const content = await page.getTextContent();
    const lines = extractPdfLines(content.items);
    if (lines.length) pages.push({ lines });
  }

  if (options.cleanPdfPageChrome) {
    pages = stripRepeatedPdfPageChrome(pages);
  }

  const text = pages
    .map(page => normalizeImportedText((page.lines || []).join('\n')))
    .filter(Boolean)
    .join('\n\n');

  return applyImportCleanup(text, options);
}

async function readEpubText(file) {
  if (!window.JSZip) throw new Error('EPUB support is unavailable.');
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const containerFile = getZipFileByPath(zip, 'META-INF/container.xml');
  if (!containerFile) throw new Error('Invalid EPUB: missing container.');

  const containerDoc = new DOMParser().parseFromString(await containerFile.async('text'), 'application/xml');
  const rootfile = Array.from(containerDoc.getElementsByTagName('rootfile'))
    .find(node => node.getAttribute('full-path'))
    ?.getAttribute('full-path');
  if (!rootfile) throw new Error('Invalid EPUB: missing package file.');

  const packageFile = getZipFileByPath(zip, rootfile);
  if (!packageFile) throw new Error('Invalid EPUB: package file not found.');

  const packageDoc = new DOMParser().parseFromString(await packageFile.async('text'), 'application/xml');
  const titleNode = packageDoc.getElementsByTagNameNS('*', 'title')[0];
  const title = normalizeImportedText(titleNode?.textContent || '') || fileTitleFromName(file.name);

  const manifest = new Map();
  Array.from(packageDoc.getElementsByTagNameNS('*', 'item')).forEach(item => {
    const id = item.getAttribute('id');
    const href = item.getAttribute('href');
    const mediaType = item.getAttribute('media-type') || '';
    const properties = item.getAttribute('properties') || '';
    if (id && href) manifest.set(id, { id, href, mediaType, properties });
  });

  const spineRefs = Array.from(packageDoc.getElementsByTagNameNS('*', 'itemref'))
    .map(item => item.getAttribute('idref'))
    .filter(Boolean);

  const basePath = rootfile.replace(/[^/]+$/, '');
  const chapters = [];
  const seenHrefs = new Set();

  for (const idref of spineRefs) {
    const item = manifest.get(idref);
    if (!item) continue;
    seenHrefs.add(normalizeArchivePath(item.href).toLowerCase());
    const chapter = await buildEpubChapter(zip, basePath, item, item.href);
    if (chapter) chapters.push(chapter);
  }

  if (!chapters.length) {
    for (const item of manifest.values()) {
      if (seenHrefs.has(normalizeArchivePath(item.href).toLowerCase())) continue;
      const chapter = await buildEpubChapter(zip, basePath, item, item.href);
      if (chapter) chapters.push(chapter);
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
  const chars = Array.from(word || '');
  const letterIndexes = chars
    .map((char, idx) => (/\p{L}/u.test(char) ? idx : -1))
    .filter(idx => idx >= 0);

  if (!letterIndexes.length) return 0;
  if (focalMode === 'first') return letterIndexes[0];

  const len = letterIndexes.length;
  let target = 0;
  if (len <= 1) target = 0;
  else if (len <= 5) target = 1;
  else if (len <= 9) target = 2;
  else target = 3;

  return letterIndexes[Math.min(target, len - 1)];
}

function clampWordIndex(idx) {
  return Math.max(0, Math.min(Math.max(words.length - 1, 0), idx));
}

function syncProgressScrubber() {
  const scrubber = document.getElementById('progress-scrubber');
  if (!scrubber) return;

  scrubber.max = String(Math.max(words.length - 1, 0));
  scrubber.value = String(clampWordIndex(wordIdx));
  scrubber.disabled = !words.length;
  scrubber.setAttribute('aria-valuetext', words.length ? `Word ${wordIdx + 1} of ${words.length}` : 'No text selected');
}

function setWordPosition(nextIdx) {
  if (!words.length) return;
  wordIdx = clampWordIndex(nextIdx);
  showWord();
  if (playing) {
    clearTimeout(wordTimer);
    scheduleNext();
  }
}

function scrubToWord(nextIdx) {
  if (!words.length) return;
  revealReaderChrome();
  setWordPosition(nextIdx);
}

function setReaderStat(name, value) {
  document.querySelectorAll(`[data-stat="${name}"]`).forEach(el => {
    el.textContent = value;
  });
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
  if (noteworthyFlashPending) flashNoteworthyConfirmation();

  // Progress
  const pct = words.length > 1 ? (wordIdx / (words.length - 1)) * 100 : 100;
  document.getElementById('progress-fill').style.width = pct.toFixed(2) + '%';
  syncProgressScrubber();

  // Stats
  setReaderStat('pos', (wordIdx + 1) + ' / ' + words.length);

  const wordsLeft = words.length - wordIdx;
  const secLeft   = Math.round((wordsLeft / wpm) * 60);
  setReaderStat('remain', secLeft < 60 ? secLeft + 's' : Math.ceil(secLeft / 60) + ' min');

  // Persist position
  if (savePos && activeIdx !== null) {
    const activeEntry = getActiveEntry();
    if (activeEntry?.id) setStoredProgress(activeEntry.id, wordIdx);
    savePositions();
  }

  updateChapterSelection();
}

function updateWordDisplayLayout() {
  const wordDisplay = document.getElementById('word-display');
  const centerWord = document.getElementById('w-center');
  const beforeWord = document.getElementById('w-before');
  const focalWord = document.getElementById('w-focal');
  if (!wordDisplay || !centerWord || !beforeWord || !focalWord) return;

  if (!['context', 'single'].includes(wordDisplay.dataset.mode)) {
    wordDisplay.style.removeProperty('--orp-left');
    wordDisplay.style.removeProperty('--orp-right');
    return;
  }

  const beforeWidth = beforeWord.getBoundingClientRect().width;
  const focalWidth = focalWord.getBoundingClientRect().width;
  const centerWidth = centerWord.getBoundingClientRect().width;
  const orpLeft = beforeWidth + (focalWidth / 2);
  const orpRight = centerWidth - orpLeft;

  wordDisplay.style.setProperty('--orp-left', `${orpLeft}px`);
  wordDisplay.style.setProperty('--orp-right', `${orpRight}px`);
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
  setWordPosition(chapterStarts[idx] || 0);
}

function updateReaderCentering() {
  const footer = document.querySelector('.reader-footer');
  const progress = document.querySelector('.progress-bar-wrap');
  const stage = document.getElementById('reader-stage');
  if (!footer || !progress) return;

  const shift = (footer.getBoundingClientRect().height + progress.getBoundingClientRect().height) / 2;
  document.documentElement.style.setProperty('--reader-center-shift', `${shift}px`);

  let horizontalShift = 0;
  if (stage && document.body.classList.contains('mobile-landscape')) {
    const rect = stage.getBoundingClientRect();
    horizontalShift = (window.innerWidth / 2) - (rect.left + (rect.width / 2));
  }
  document.documentElement.style.setProperty('--reader-horizontal-shift', `${horizontalShift}px`);
}

function refreshReaderLayout() {
  document.body.classList.toggle('mobile-landscape', isMobileLandscapeViewport());
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
  togglePlay();
}

function resetDisplay() {
  const hasText = words.length > 0;
  document.getElementById('idle-msg').style.display     = hasText ? 'none' : '';
  document.getElementById('focus-marker').style.display = hasText ? '' : 'none';
  document.getElementById('word-display').dataset.mode = 'single';
  document.getElementById('word-display').style.removeProperty('--orp-left');
  document.getElementById('word-display').style.removeProperty('--orp-right');
  document.getElementById('w-left').textContent   = '';
  document.getElementById('w-before').textContent = '';
  document.getElementById('w-focal').textContent  = '';
  document.getElementById('w-after').textContent  = '';
  document.getElementById('w-right').textContent  = '';
  document.getElementById('progress-fill').style.width = '0%';
  syncProgressScrubber();
  setReaderStat('pos', '0 / 0');
  setReaderStat('remain', '—');
  clearTimeout(noteworthyFlashTimer);
  noteworthyFlashPending = false;
  document.getElementById('word-display').classList.remove('noteworthy-flash');
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
  const playBtn = document.getElementById('play-btn');
  playBtn.classList.add('is-playing');
  playBtn.setAttribute('aria-label', 'Pause');
  revealReaderChrome();
  scheduleNext();
}

function stopPlayback() {
  playing = false;
  const playBtn = document.getElementById('play-btn');
  playBtn.classList.remove('is-playing');
  playBtn.setAttribute('aria-label', 'Play');
  clearTimeout(wordTimer);
  syncReaderChrome();
}

function getDelay() {
  let ms = (60 / wpm) * 1000;
  if (pausePunct) {
    const w = words[wordIdx] || '';
    if (hasSentencePause(w)) ms *= 2.4;
    else if (hasClausePause(w)) ms *= 1.5;
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

/* ──────────────────────────────────────
   Navigation controls
────────────────────────────────────── */
function skipWord(n) {
  if (!words.length) return;
  setWordPosition(wordIdx + n);
}

function skipSentence(dir) {
  if (!words.length) return;

  if (dir > 0) {
    let i = wordIdx + 1;
    while (i < words.length - 1 && !hasSentencePause(words[i - 1])) i++;
    setWordPosition(Math.min(i, words.length - 1));
  } else {
    let i = wordIdx - 2;
    while (i > 0 && !hasSentencePause(words[i - 1])) i--;
    setWordPosition(Math.max(0, i));
  }
}

function restartText() {
  if (!words.length) return;
  wordIdx = 0;
  if (playing) stopPlayback();
  showWord();
}

function getSentenceRange(idx) {
  if (!words.length) return null;

  let start = clampWordIndex(idx);
  while (start > 0 && !hasSentencePause(words[start - 1])) start--;

  let end = clampWordIndex(idx);
  while (end < words.length - 1 && !hasSentencePause(words[end])) end++;

  return { start, end };
}

function buildSentenceText(start, end) {
  return words.slice(start, end + 1).join(' ').trim();
}

function markCurrentSentenceNoteworthy() {
  if (activeIdx === null || !words.length || !library[activeIdx]) return;

  const range = getSentenceRange(wordIdx);
  if (!range) return;

  const entry = library[activeIdx];
  const exists = entry.noteworthy.some(mark => mark.start === range.start && mark.end === range.end);
  if (!exists) {
    entry.noteworthy.push({
      start: range.start,
      end: range.end,
      text: buildSentenceText(range.start, range.end),
    });
    touchEntry(entry);
    saveLibrary();
    if (document.getElementById('library-view')?.classList.contains('active')) renderLibrary();
  }

  if (playing && wordIdx < words.length - 1) noteworthyFlashPending = true;
  else flashNoteworthyConfirmation();
}

function flashNoteworthyConfirmation() {
  const wordDisplay = document.getElementById('word-display');
  if (!wordDisplay) return;

  noteworthyFlashPending = false;
  clearTimeout(noteworthyFlashTimer);
  wordDisplay.classList.remove('noteworthy-flash');
  void wordDisplay.offsetWidth;
  wordDisplay.classList.add('noteworthy-flash');
  noteworthyFlashTimer = setTimeout(() => {
    wordDisplay.classList.remove('noteworthy-flash');
  }, 240);
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

function setTextScale(v) {
  textScale = v;
  document.getElementById('text-scale-display').textContent = `${v}%`;
  applyTextScale();
  refreshReaderLayout();
  saveSettings();
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
    const importOptions = {
      cleanApaCitations,
      cleanPdfPageChrome,
    };

    if (ext === 'txt') {
      raw = await file.text();
    } else if (ext === 'md' || ext === 'markdown') {
      raw = markdownToText(await file.text());
    } else if (ext === 'pdf') {
      raw = await readPdfText(file, importOptions);
    } else if (ext === 'epub') {
      const epub = await readEpubText(file);
      title = epub.title;
      raw = epub.raw;
      extra = { chapters: epub.chapters };
    } else {
      throw new Error('Only .txt, .md, .pdf, and .epub files are supported.');
    }

    if (ext !== 'pdf') {
      raw = applyImportCleanup(raw, importOptions);
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
    case 'm':
    case 'M':
      if (document.getElementById('reader-view')?.classList.contains('active')) {
        e.preventDefault();
        markCurrentSentenceNoteworthy();
      }
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
function applyTheme() {
  document.body.setAttribute('data-theme', theme);
  const themeIcon = theme === 'dark' ? '◐' : '◑';
  document.getElementById('theme-btn').textContent = themeIcon;
  document.querySelectorAll('.nav-theme-btn').forEach(btn => {
    btn.innerHTML = `<span class="nav-icon">${themeIcon}</span>theme`;
  });
  const themeSettingBtn = document.getElementById('theme-setting-btn');
  if (themeSettingBtn) themeSettingBtn.textContent = theme === 'dark' ? 'use light' : 'use dark';
  const meta = document.getElementById('theme-meta');
  if (meta) meta.content = theme === 'dark' ? '#0a0a0a' : '#f5f0e8';
}

function init() {
  loadAll();
  document.body.classList.toggle('reader-view-active', Boolean(document.getElementById('reader-view')?.classList.contains('active')));
  applyTheme();
  applyTextScale();
  updateCloudUi();

  // Apply saved settings to UI
  document.getElementById('wpm-slider').value    = wpm;
  document.getElementById('wpm-display').textContent = wpm;
  document.getElementById('chunk-select').value  = chunkSize;
  document.getElementById('focal-select').value  = focalMode;
  document.getElementById('pause-punct').checked = pausePunct;
  document.getElementById('save-pos').checked    = savePos;
  document.getElementById('text-scale-slider').value = textScale;
  document.getElementById('text-scale-display').textContent = `${textScale}%`;
  const cleanApaEl = document.getElementById('clean-apa-citations');
  const cleanPdfEl = document.getElementById('clean-pdf-page-chrome');
  if (cleanApaEl) cleanApaEl.checked = cleanApaCitations;
  if (cleanPdfEl) cleanPdfEl.checked = cleanPdfPageChrome;

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
      library[existingIdx] = normalizeLibraryEntry({
        ...library[existingIdx],
        title: sampleTitle,
        raw: sample,
        wordCount: tokenize(sample).length,
      });
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
  const progressScrubber = document.getElementById('progress-scrubber');
  if (progressScrubber) {
    progressScrubber.addEventListener('input', event => {
      scrubToWord(Number(event.target.value));
    });
    progressScrubber.addEventListener('pointerdown', () => {
      if (words.length) revealReaderChrome();
    });
  }
  if (readerLayoutObserver) readerLayoutObserver.disconnect();
  if ('ResizeObserver' in window) {
    readerLayoutObserver = new ResizeObserver(updateReaderCentering);
    const footer = document.querySelector('.reader-footer');
    const progress = document.querySelector('.progress-bar-wrap');
    if (footer) readerLayoutObserver.observe(footer);
    if (progress) readerLayoutObserver.observe(progress);
  }
  window.addEventListener('resize', refreshReaderLayout);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') syncLibraryWithCloud({ silent: true });
  });
  initCloudSync();
}

init();
