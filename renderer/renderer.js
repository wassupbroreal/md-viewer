'use strict';

// ── Tauri API Adapter ────────────────────────────────────────────────────────
const invoke = window.__TAURI__ ? window.__TAURI__.core.invoke : null;
const dialog = window.__TAURI__ ? window.__TAURI__.dialog : null;
const listen = window.__TAURI__ ? window.__TAURI__.event.listen : null;

// Callbacks container for emulation of Electron ipcRenderer listeners
const listeners = {
  loading: [],
  file: [],
  error: []
};

// Emulated API object mapping Electron IPCs to Tauri commands
window.api = {
  minimize:       () => invoke && invoke('win_minimize'),
  maximize:       () => invoke && invoke('win_maximize'),
  close:          () => invoke && invoke('win_close'),

  openDialog:     async () => {
    if (!dialog) return;
    try {
      const selected = await dialog.open({
        title: 'Открыть Markdown файл',
        filters: [
          { name: 'Markdown / Text', extensions: ['md', 'markdown', 'mdx', 'txt'] },
          { name: 'Все файлы', extensions: ['*'] }
        ]
      });
      if (selected) {
        window.api.openFile(selected);
      }
    } catch (err) {
      listeners.error.forEach(cb => cb(String(err)));
    }
  },

  openFile:       async (path) => {
    if (!invoke) return;
    listeners.loading.forEach(cb => cb());
    try {
      await invoke('add_recent', { pathStr: path });
      const data = await invoke('read_file', { pathStr: path });
      const html = parseMarkdown(data.content);
      listeners.file.forEach(cb => cb({
        path: data.path,
        name: data.name,
        html: html,
        size: data.size,
        modified: data.modified
      }));
    } catch (err) {
      listeners.error.forEach(cb => cb(String(err)));
    }
  },

  getRecent:      () => invoke ? invoke('get_recent') : Promise.resolve([]),
  removeRecent:   (p) => invoke ? invoke('remove_recent', { pathStr: p }) : Promise.resolve(),
  showInExplorer: (p) => invoke && invoke('show_in_explorer', { pathStr: p }),

  getPath:        (file) => file.path || '',

  onLoading: (cb) => listeners.loading.push(cb),
  onFile:    (cb) => listeners.file.push(cb),
  onError:   (cb) => listeners.error.push(cb),
};

// Listen to tauri single instance events
if (listen) {
  listen('open-file', (event) => {
    const filePath = event.payload;
    if (filePath) {
      window.api.openFile(filePath);
    }
  });
}

function parseMarkdown(content) {
  const mathBlocks = [];

  // Replace display math and inline math with placeholders before Markdown parsing
  let processed = content
    // Display Math $$ ... $$
    .replace(/\$\$([\s\S]+?)\$\$/g, (match, eq) => {
      const id = `MATHPLACEHOLDER${mathBlocks.length}X`;
      try {
        const rendered = katex.renderToString(eq.trim(), { displayMode: true, throwOnError: false });
        mathBlocks.push({ id, html: rendered });
      } catch {
        mathBlocks.push({ id, html: match });
      }
      return id;
    })
    // Display Math \[ ... \]
    .replace(/\\\[([\s\S]+?)\\\]/g, (match, eq) => {
      const id = `MATHPLACEHOLDER${mathBlocks.length}X`;
      try {
        const rendered = katex.renderToString(eq.trim(), { displayMode: true, throwOnError: false });
        mathBlocks.push({ id, html: rendered });
      } catch {
        mathBlocks.push({ id, html: match });
      }
      return id;
    })
    // Inline Math (( ... )) or \(( ... )) or \(( ... )\)
    .replace(/\\?\(\(([\s\S]+?)\\?\)\)/g, (match, eq) => {
      const id = `MATHPLACEHOLDER${mathBlocks.length}X`;
      try {
        const rendered = katex.renderToString(eq.trim(), { displayMode: false, throwOnError: false });
        mathBlocks.push({ id, html: rendered });
      } catch {
        mathBlocks.push({ id, html: match });
      }
      return id;
    })
    // Inline Math $ ... $ (safe check to avoid plain currency symbols)
    .replace(/\$([^\$\s](?:[^\$]*?[^\$\s])?)\$/g, (match, eq) => {
      const trimmed = eq.trim();
      // If it is just a plain number/percentage/range, keep it as normal text (no KaTeX serif fonts)
      if (/^[0-9\s,\.%\-\u2013\u2014]+$/.test(trimmed)) {
        return trimmed;
      }
      const id = `MATHPLACEHOLDER${mathBlocks.length}X`;
      try {
        const rendered = katex.renderToString(trimmed, { displayMode: false, throwOnError: false });
        mathBlocks.push({ id, html: rendered });
      } catch {
        mathBlocks.push({ id, html: match });
      }
      return id;
    });

  marked.use({ async: false, gfm: true, breaks: true });
  const rawHtml = String(marked.parse(processed));

  let html = rawHtml
    .replace(
      /<pre><code class="language-(\w+)">([\s\S]*?)<\/code><\/pre>/g,
      (_, lang, code) => {
        let highlighted = code;
        const decoded = code
          .replace(/&amp;/g, '&').replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
        try {
          highlighted = hljs.getLanguage(lang)
            ? hljs.highlight(decoded, { language: lang }).value
            : hljs.highlightAuto(decoded).value;
        } catch {
          highlighted = code;
        }
        return `<pre class="code-block" data-lang="${lang}"><code>${highlighted}</code></pre>`;
      }
    )
    .replace(
      /<pre><code>([\s\S]*?)<\/code><\/pre>/g,
      '<pre class="code-block"><code>$1</code></pre>'
    );

  // Restore math placeholders
  mathBlocks.forEach(block => {
    html = html.split(block.id).join(block.html);
  });

  return html;
}

// ── Update Checker ────────────────────────────────────────────────────────────
setTimeout(async () => {
  if (!invoke || !dialog) return;
  try {
    const currentVersion = await invoke('get_app_version');
    const res = await fetch('https://api.github.com/repos/wassupbroreal/md-viewer/releases/latest', {
      headers: { 'User-Agent': 'Tauri-MD-Viewer-Updater' }
    });
    if (res.status !== 200) return;
    const release = await res.json();
    if (!release || !release.tag_name) return;

    const latestVersion = release.tag_name.replace(/^v/, '');
    if (isNewerVersion(latestVersion, currentVersion)) {
      const dict = i18n[settings.lang || 'en'];
      const confirm = await dialog.ask(
        dict.updateMsg(release.tag_name, currentVersion),
        {
          title: dict.updateTitle,
          okLabel: dict.updateOk,
          cancelLabel: dict.updateCancel
        }
      );
      if (confirm) {
        await invoke('open_external', { url: release.html_url });
      }
    }
  } catch (err) {
    console.error('Update check failed:', err);
  }
}, 3000);

function isNewerVersion(latest, current) {
  const l = latest.split('.').map(Number);
  const c = current.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((l[i] || 0) > (c[i] || 0)) return true;
    if ((l[i] || 0) < (c[i] || 0)) return false;
  }
  return false;
}

// ── State ────────────────────────────────────────────────────────────────────
let currentFilePath = null;
let searchMatches   = [];
let searchIdx       = -1;
let searchOpen      = false;
let isProgrammaticScrolling = false;
let scrollTimeout   = null;

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
  outline:     $('outline'),
  outlineList: $('outline-list'),
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
el.viewport.addEventListener('scroll', syncOutlineScroll);

// ── Title bar ─────────────────────────────────────────────────────────────────
$('btn-min').addEventListener('click',   () => window.api.minimize());
$('btn-max').addEventListener('click',   () => window.api.maximize());
$('btn-close').addEventListener('click', () => window.api.close());

// ── Sidebar ───────────────────────────────────────────────────────────────────
$('btn-toggle-sidebar').addEventListener('click', () => el.sidebar.classList.toggle('collapsed'));

// ── Open file ─────────────────────────────────────────────────────────────────
$('btn-open').addEventListener('click',         () => window.api.openDialog());

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
  el.toolbarPath.innerHTML = '<span class="path-hint">' + (typeof settings !== 'undefined' && settings.lang === 'ru' ? 'Выберите файл для просмотра' : 'Select a file to view') + '</span>';
  el.fileMeta.textContent  = '';
  el.btnExplorer.style.display = 'none';
  if (searchOpen) closeSearch();
  el.outline.style.display = 'none';
  el.outlineList.innerHTML = '';
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
  if (typeof settings !== 'undefined' && settings.lineNumbers) {
    updateAllCodeBlocksLineNumbers();
  }
  if (searchOpen && el.searchInput.value) doSearch(el.searchInput.value);
  generateOutline();
}

// ── Recent files ──────────────────────────────────────────────────────────────
async function loadRecent() {
  const files = await window.api.getRecent();
  el.recentList.innerHTML = '';

  if (!files.length) {
    el.recentList.innerHTML = '<li class="recent-empty">' + (typeof settings !== 'undefined' && settings.lang === 'ru' ? 'Нет недавних файлов' : 'No recent files') + '</li>';
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
      '<div class="ri-text">' +
        '<div class="ri-name">' + esc(f.name) + '</div>' +
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
  if (listen) {
    listen('tauri://drag-over', () => {
      el.dropOverlay.style.display = 'flex';
    });

    listen('tauri://drag-leave', () => {
      el.dropOverlay.style.display = 'none';
    });

    listen('tauri://drag-drop', (event) => {
      el.dropOverlay.style.display = 'none';
      const payload = event.payload;
      const paths = payload && (payload.paths || (Array.isArray(payload) ? payload : null));
      if (paths && paths.length > 0) {
        window.api.openFile(paths[0]);
      }
    });
  }
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

// ── Settings & Localization ───────────────────────────────────────────────────
const settingsModal = $('settings-modal');
const btnSettings = $('btn-settings');
const btnSettingsClose = $('btn-settings-close');

// i18n Translations Dictionary
const i18n = {
  en: {
    openBtn: 'Open File',
    recentEmpty: 'No recent files',
    pathHint: 'Select a file to view',
    searchPlaceholder: 'Search',
    searchNotFound: 'Not found',
    settingsTitle: 'Settings',
    fontSizeLabel: 'Font Size:',
    fontFamilyLabel: 'Content Font:',
    themeLabel: 'Theme:',
    langLabel: 'Language:',
    optSizeSm: '12 px (Small)',
    optSizeStd: '13 px (Standard)',
    optSizeMed: '14 px (Medium)',
    optSizeLg: '16 px (Large)',
    optSizeXl: '18 px (Extra Large)',
    optFamilySans: 'Sans-serif (Inter)',
    optFamilyMono: 'Monospace (JetBrains)',
    optFamilySerif: 'Serif (Georgia)',
    optThemeLight: 'Light',
    optThemeDark: 'Dark',
    updateTitle: 'Update Available',
    updateOk: 'Download',
    updateCancel: 'Later',
    updateMsg: (tag, current) => `New version ${tag} is available!\n\nCurrent version: v${current}\nNew version: ${tag}\n\nDo you want to open the download page in your browser?`
  },
  ru: {
    openBtn: 'Открыть файл',
    recentEmpty: 'Нет недавних файлов',
    pathHint: 'Выберите файл для просмотра',
    searchPlaceholder: 'Поиск',
    searchNotFound: 'Не найдено',
    settingsTitle: 'Настройки',
    fontSizeLabel: 'Размер шрифта текста:',
    fontFamilyLabel: 'Шрифт контента:',
    themeLabel: 'Тема оформления:',
    langLabel: 'Язык приложения:',
    optSizeSm: '12 px (Мелкий)',
    optSizeStd: '13 px (Стандартный)',
    optSizeMed: '14 px (Средний)',
    optSizeLg: '16 px (Крупный)',
    optSizeXl: '18 px (Очень крупный)',
    optFamilySans: 'Без засечек (Inter)',
    optFamilyMono: 'Моноширинный (JetBrains)',
    optFamilySerif: 'С засечками (Georgia)',
    optThemeLight: 'Светлая',
    optThemeDark: 'Темная',
    updateTitle: 'Доступно обновление',
    updateOk: 'Скачать',
    updateCancel: 'Позже',
    updateMsg: (tag, current) => `Доступна новая версия ${tag}!\n\nТекущая версия: v${current}\nНовая версия: ${tag}\n\nХотите открыть страницу загрузки в браузере?`
  }
};

// Load settings on startup (default values: lang -> 'en', theme -> 'light')
let settings = {
  fontSize: localStorage.getItem('setting-font-size') || '13px',
  fontFamily: localStorage.getItem('setting-font-family') || 'var(--font-inter)',
  theme: localStorage.getItem('setting-theme') || 'light',
  lang: localStorage.getItem('setting-lang') || 'en'
};

function initSettings() {
  // Bind inputs
  $('setting-font-size').value = settings.fontSize;
  $('setting-font-family').value = settings.fontFamily;
  $('setting-theme').value = settings.theme;
  $('setting-lang').value = settings.lang;

  // Apply settings initially
  applySettings();

  // Listeners for Modal
  btnSettings.addEventListener('click', () => {
    settingsModal.style.display = 'flex';
  });
  btnSettingsClose.addEventListener('click', () => {
    settingsModal.style.display = 'none';
  });
  settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) {
      settingsModal.style.display = 'none';
    }
  });

  // Settings Change Events
  $('setting-font-size').addEventListener('change', (e) => {
    settings.fontSize = e.target.value;
    localStorage.setItem('setting-font-size', settings.fontSize);
    applySettings();
  });

  $('setting-font-family').addEventListener('change', (e) => {
    settings.fontFamily = e.target.value;
    localStorage.setItem('setting-font-family', settings.fontFamily);
    applySettings();
  });

  $('setting-theme').addEventListener('change', (e) => {
    settings.theme = e.target.value;
    localStorage.setItem('setting-theme', settings.theme);
    applySettings();
  });

  $('setting-lang').addEventListener('change', (e) => {
    settings.lang = e.target.value;
    localStorage.setItem('setting-lang', settings.lang);
    applySettings();
  });

  // Load app version in footer
  if (invoke) {
    invoke('get_app_version').then(v => {
      $('app-version-text').textContent = 'v' + v;
    }).catch(err => console.error(err));
  }
}

function applySettings() {
  const mdOut = el.mdOut;
  // Apply fonts
  mdOut.style.fontSize = settings.fontSize;
  mdOut.style.fontFamily = settings.fontFamily;

  // Apply theme
  document.documentElement.classList.toggle('dark', settings.theme === 'dark');

  // Apply language (translate all elements)
  const dict = i18n[settings.lang];

  // Sidebar
  const openBtnSpan = $('btn-open').querySelector('span');
  if (openBtnSpan) openBtnSpan.textContent = dict.openBtn;

  // Recent list empty state
  loadRecent();

  // Toolbar path hint
  if (!currentFilePath) {
    el.toolbarPath.innerHTML = '<span class="path-hint">' + dict.pathHint + '</span>';
  }

  // Search input placeholder
  el.searchInput.placeholder = dict.searchPlaceholder;

  // Settings Modal labels
  $('settings-title-text').textContent = dict.settingsTitle;
  $('label-font-size').textContent = dict.fontSizeLabel;
  $('label-font-family').textContent = dict.fontFamilyLabel;
  $('label-theme').textContent = dict.themeLabel;
  $('label-lang').textContent = dict.langLabel;

  // Select options
  $('opt-size-sm').textContent = dict.optSizeSm;
  $('opt-size-std').textContent = dict.optSizeStd;
  $('opt-size-med').textContent = dict.optSizeMed;
  $('opt-size-lg').textContent = dict.optSizeLg;
  $('opt-size-xl').textContent = dict.optSizeXl;

  $('opt-family-sans').textContent = dict.optFamilySans;
  $('opt-family-mono').textContent = dict.optFamilyMono;
  $('opt-family-serif').textContent = dict.optFamilySerif;

  $('opt-theme-light').textContent = dict.optThemeLight;
  $('opt-theme-dark').textContent = dict.optThemeDark;
}

// Call initSettings on boot
initSettings();

// ── Outline Panel (Table of Contents) ──────────────────────────────────────────
function generateOutline() {
  el.outlineList.innerHTML = '';
  const headings = el.mdOut.querySelectorAll('h2');
  
  if (!headings.length) {
    el.outline.style.display = 'none';
    return;
  }

  const ids = new Set();
  headings.forEach((heading, idx) => {
    let id = heading.id;
    if (!id) {
      const text = heading.textContent.trim().toLowerCase()
        .replace(/[^\w\sа-яё\-]/gi, '')
        .replace(/\s+/g, '-');
      id = text || 'heading-' + idx;
      
      let uniqueId = id;
      let count = 1;
      while (ids.has(uniqueId)) {
        uniqueId = id + '-' + count;
        count++;
      }
      id = uniqueId;
      heading.id = id;
    }
    ids.add(id);

    const li = document.createElement('li');
    li.className = 'outline-item ' + heading.tagName.toLowerCase();
    li.textContent = heading.textContent.trim();
    li.title = heading.textContent.trim();
    
    li.onclick = () => {
      isProgrammaticScrolling = true;
      heading.scrollIntoView({ block: 'start' });
      
      const items = el.outlineList.querySelectorAll('.outline-item');
      items.forEach(item => item.classList.remove('active'));
      li.classList.add('active');

      if (scrollTimeout) clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(() => {
        isProgrammaticScrolling = false;
        syncOutlineScroll();
      }, 100);
    };

    el.outlineList.appendChild(li);
  });

  el.outline.style.display = 'flex';
  syncOutlineScroll();
}

function syncOutlineScroll() {
  if (isProgrammaticScrolling) return;
  const headings = Array.from(el.mdOut.querySelectorAll('h2'));
  if (!headings.length) return;

  const viewportRect = el.viewport.getBoundingClientRect();
  const threshold = 80;

  let activeHeading = null;

  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i];
    const rect = heading.getBoundingClientRect();
    const relativeTop = rect.top - viewportRect.top;

    if (relativeTop <= threshold) {
      activeHeading = heading;
    } else {
      break;
    }
  }

  if (!activeHeading && headings.length > 0) {
    activeHeading = headings[0];
  }

  const items = el.outlineList.querySelectorAll('.outline-item');
  items.forEach((item, idx) => {
    const heading = headings[idx];
    if (heading === activeHeading) {
      item.classList.add('active');
      
      const outlineBody = el.outline.querySelector('.outline-body');
      if (outlineBody) {
        const itemTop = item.offsetTop;
        const itemHeight = item.offsetHeight;
        const containerHeight = outlineBody.clientHeight;
        const containerScrollTop = outlineBody.scrollTop;

        if (itemTop < containerScrollTop) {
          outlineBody.scrollTop = itemTop - 10;
        } else if (itemTop + itemHeight > containerScrollTop + containerHeight) {
          outlineBody.scrollTop = itemTop + itemHeight - containerHeight + 10;
        }
      }
    } else {
      item.classList.remove('active');
    }
  });
}
