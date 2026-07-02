'use strict';

if (!window.api) {
  document.body.innerHTML = '<pre style="padding:2em;color:red">Ошибка: window.api не определён.</pre>';
  throw new Error('window.api is undefined');
}

// ── State ────────────────────────────────────────────────────────────────────
let currentFilePath = null;
let searchMatches   = [];
let searchIdx       = -1;
let searchOpen      = false;

// ── DOM ──────────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const el = {
  sidebar:     $('sidebar'),
  recentList:  $('recent-list'),
  welcome:     $('welcome'),
  spinner:     $('spinner'),
  mdOut:       $('md-out'),
  viewport:    $('viewport'),
  winTitle:    $('win-title'),
  toolbarPath: $('toolbar-path'),
  fileMeta:    $('file-meta'),
  btnExplorer: $('btn-explorer'),
  searchWrap:  $('search-wrap'),
  searchInput: $('search-input'),
  searchCount: $('search-count'),
  dropOverlay: $('drop-overlay'),
};

// ── Boot ─────────────────────────────────────────────────────────────────────
// Fade out splash after 500ms
const splash = document.getElementById('splash');
setTimeout(() => {
  splash.classList.add('fade-out');
  setTimeout(() => { splash.style.display = 'none'; }, 380);
}, 500);

loadRecent();
setupDrop();

// ── IPC ───────────────────────────────────────────────────────────────────────
window.api.onLoading(() => showSpinner());
window.api.onFile((data)  => renderContent(data));
window.api.onError((msg)  => { hideSpinner(); alert('Ошибка:\n' + msg); });

// ── Title bar ─────────────────────────────────────────────────────────────────
$('btn-min').addEventListener('click',   () => window.api.minimize());
$('btn-max').addEventListener('click',   () => window.api.maximize());
$('btn-close').addEventListener('click', () => window.api.close());

// ── Sidebar ───────────────────────────────────────────────────────────────────
$('btn-toggle-sidebar').addEventListener('click', () => el.sidebar.classList.toggle('collapsed'));

// ── Open file ─────────────────────────────────────────────────────────────────
$('btn-open').addEventListener('click',         () => window.api.openDialog());
$('btn-welcome-open').addEventListener('click', () => window.api.openDialog());

// ── Explorer ──────────────────────────────────────────────────────────────────
el.btnExplorer.addEventListener('click', () => {
  if (currentFilePath) window.api.showInExplorer(currentFilePath);
});

// ── Search ────────────────────────────────────────────────────────────────────
$('btn-search').addEventListener('click', openSearch);
$('btn-s-close').addEventListener('click', closeSearch);
$('btn-s-prev').addEventListener('click', () => stepSearch(-1));
$('btn-s-next').addEventListener('click', () => stepSearch(1));
el.searchInput.addEventListener('input', () => doSearch(el.searchInput.value));
el.searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter')  { e.preventDefault(); stepSearch(e.shiftKey ? -1 : 1); }
  if (e.key === 'Escape') closeSearch();
});

function openSearch() {
  if (searchOpen) { el.searchInput.focus(); el.searchInput.select(); return; }
  searchOpen = true;
  el.searchWrap.classList.add('open');
  setTimeout(() => { el.searchInput.focus(); el.searchInput.select(); }, 200);
}

function closeSearch() {
  searchOpen = false;
  el.searchWrap.classList.remove('open');
  clearHighlights();
  searchMatches = []; searchIdx = -1;
  el.searchCount.textContent = '';
  el.searchInput.value = '';
}

function doSearch(q) {
  clearHighlights();
  searchMatches = []; searchIdx = -1;
  if (!q || !currentFilePath) { el.searchCount.textContent = ''; return; }

  const re = new RegExp(reEsc(q), 'gi');
  const walker = document.createTreeWalker(el.mdOut, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let n;
  while ((n = walker.nextNode())) nodes.push(n);

  nodes.forEach(tn => {
    if (!re.test(tn.textContent)) return;
    re.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0, m;
    while ((m = re.exec(tn.textContent)) !== null) {
      frag.appendChild(document.createTextNode(tn.textContent.slice(last, m.index)));
      const mark = document.createElement('mark');
      mark.className = 'hi';
      mark.textContent = m[0];
      frag.appendChild(mark);
      searchMatches.push(mark);
      last = m.index + m[0].length;
    }
    frag.appendChild(document.createTextNode(tn.textContent.slice(last)));
    tn.parentNode.replaceChild(frag, tn);
  });

  if (searchMatches.length) { searchIdx = 0; showCurrent(); }
  else el.searchCount.textContent = 'Не найдено';
}

function stepSearch(d) {
  if (!searchMatches.length) return;
  searchMatches[searchIdx]?.classList.remove('cur');
  searchIdx = (searchIdx + d + searchMatches.length) % searchMatches.length;
  showCurrent();
}

function showCurrent() {
  const m = searchMatches[searchIdx];
  if (!m) return;
  m.classList.add('cur');
  m.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.searchCount.textContent = (searchIdx + 1) + '/' + searchMatches.length;
}

function clearHighlights() {
  el.mdOut.querySelectorAll('mark.hi').forEach(m => m.replaceWith(document.createTextNode(m.textContent)));
  el.mdOut.normalize();
}

// ── Spinner — uses style.display (no hidden attribute) ───────────────────────
function showSpinner() {
  el.welcome.style.display = 'none';
  el.mdOut.style.display   = 'none';
  el.spinner.style.display = 'flex';
}

function hideSpinner() {
  el.spinner.style.display = 'none';
}

// ── Welcome screen helper ────────────────────────────────────────────────
function showWelcome() {
  currentFilePath = null;
  hideSpinner();
  el.mdOut.style.display   = 'none';
  el.mdOut.innerHTML       = '';
  el.welcome.style.display = '';
  el.winTitle.textContent  = '';
  el.toolbarPath.innerHTML = '<span class="path-hint">Выберите файл для просмотра</span>';
  el.fileMeta.textContent  = '';
  el.btnExplorer.style.display = 'none';
  if (searchOpen) closeSearch();
}

// ── Render ────────────────────────────────────────────────────────────────────
function renderContent(data) {
  currentFilePath = data.path;

  // Set HTML (received pre-rendered from main process)
  el.mdOut.innerHTML = data.html;

  // Copy buttons on code blocks
  el.mdOut.querySelectorAll('pre.code-block').forEach(pre => {
    const btn = document.createElement('button');
    btn.className   = 'copy-btn';
    btn.innerHTML = '<span class="material-symbols-outlined" style="font-size: 16px;">content_copy</span>';
    btn.title = 'Копировать';
    btn.onclick = () => {
      const code = pre.querySelector('code');
      navigator.clipboard.writeText(code ? code.innerText : pre.innerText).then(() => {
        btn.innerHTML = '<span class="material-symbols-outlined" style="font-size: 16px;">check</span>';
        btn.classList.add('ok');
        setTimeout(() => {
          btn.innerHTML = '<span class="material-symbols-outlined" style="font-size: 16px;">content_copy</span>';
          btn.classList.remove('ok');
        }, 2000);
      });
    };
    pre.appendChild(btn);
  });

  // Show content — use style.display (no hidden attr issues)
  hideSpinner();
  el.welcome.style.display = 'none';
  el.mdOut.style.display   = 'block';

  // Breadcrumb
  const sep = data.path.includes('\\') ? '\\' : '/';
  const dir = data.path.substring(0, data.path.lastIndexOf(sep));
  el.toolbarPath.innerHTML =
    '<span class="path-dir">' + esc(dir) + sep + '</span>' +
    '<span class="path-name">' + esc(data.name) + '</span>';

  // Title bar: only the filename, centered
  el.winTitle.textContent      = data.name;
  el.fileMeta.textContent      = fmtSize(data.size) + ' · ' + fmtDate(data.modified);
  el.btnExplorer.style.display = '';
  el.viewport.scrollTop        = 0;

  loadRecent();
  if (searchOpen && el.searchInput.value) doSearch(el.searchInput.value);
}

// ── Recent files ──────────────────────────────────────────────────────────────
async function loadRecent() {
  const files = await window.api.getRecent();
  el.recentList.innerHTML = '';

  if (!files.length) {
    el.recentList.innerHTML = '<li class="recent-empty">Нет недавних файлов</li>';
    return;
  }

  files.forEach(f => {
    const sep = f.path.includes('\\') ? '\\' : '/';
    const dir = f.path.substring(0, f.path.lastIndexOf(sep));

    const li = document.createElement('li');
    li.className = ['ri',
      f.exists ? '' : 'missing',
      currentFilePath === f.path ? 'active' : ''
    ].filter(Boolean).join(' ');

    const body = document.createElement('div');
    body.className = 'ri-body';
    body.innerHTML =
      '<span class="ri-icon">' +
        '<svg width="13" height="13" viewBox="0 0 16 16" fill="none">' +
          '<path d="M2.5 1h8L14 4.5V15a.5.5 0 0 1-.5.5h-11A.5.5 0 0 1 2 15V1.5A.5.5 0 0 1 2.5 1z"' +
          ' stroke="currentColor" stroke-width=".8" stroke-linejoin="round"/>' +
          '<path d="M10.5 1v3.5H14" stroke="currentColor" stroke-width=".8" stroke-linejoin="round"/>' +
        '</svg>' +
      '</span>' +
      '<div class="ri-text">' +
        '<div class="ri-name" title="' + esc(f.path) + '">' + esc(f.name) + '</div>' +
        '<div class="ri-dir">' + esc(dir) + '</div>' +
      '</div>';

    if (f.exists) {
      li.addEventListener('click', () => {
        showSpinner();
        window.api.openFile(f.path);
      });
    }

    // Remove button
    const rmBtn = document.createElement('button');
    rmBtn.className = 'ri-rm';
    rmBtn.title = 'Удалить из списка';
    rmBtn.textContent = '×';
    rmBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await window.api.removeRecent(f.path);
      // If removed file was the active one → go back to welcome
      if (currentFilePath === f.path) showWelcome();
      loadRecent();
    });

    li.appendChild(body);
    li.appendChild(rmBtn);
    el.recentList.appendChild(li);
  });
}

// ── Drag & drop ───────────────────────────────────────────────────────────────
function setupDrop() {
  let active = false;
  document.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (!active) { active = true; el.dropOverlay.style.display = 'flex'; }
  });
  document.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) { active = false; el.dropOverlay.style.display = 'none'; }
  });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    active = false; el.dropOverlay.style.display = 'none';
    const f = e.dataTransfer.files[0];
    if (f && f.path) window.api.openFile(f.path);
  });
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 'o') { e.preventDefault(); window.api.openDialog(); }
  if (e.ctrlKey && e.key === 'f') { e.preventDefault(); openSearch(); }
  if (e.key === 'Escape' && searchOpen) closeSearch();
});

// ── Utilities ─────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function reEsc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function fmtSize(b) {
  if (b < 1024)    return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}
function fmtDate(iso) {
  return new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: 'short', year: 'numeric' });
}
