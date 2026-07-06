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
      // Normalize common LaTeX formatters to plain text equivalents
      const normalized = trimmed
        .replace(/\\,/g, ' ')               // replace thin space \, with space
        .replace(/\\text\{--\}/g, '–')       // replace \text{--} with en-dash
        .replace(/\\text\{-\}/g, '-')        // replace \text{-} with hyphen
        .replace(/\\%/g, '%')                // replace \% with %
        .replace(/\\sim/g, '~')              // replace \sim with ~
        .replace(/\\approx/g, '≈');          // replace \approx with ≈

      // If it is just a plain number/percentage/range/approx, keep it as normal text (no KaTeX serif fonts)
      if (/^[0-9\s,\.%\-\u2013\u2014~≈]+$/.test(normalized.trim())) {
        return normalized.trim();
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
  winTitle:    $('win-title'),
  dropOverlay: $('drop-overlay'),
};

// ── Boot ─────────────────────────────────────────────────────────────────────
// Fade out splash after 500ms
const splash = document.getElementById('splash');
setTimeout(() => {
  splash.classList.add('fade-out');
  setTimeout(() => { splash.style.display = 'none'; }, 380);
}, 500);

setupDrop();

// ── IPC ───────────────────────────────────────────────────────────────────────
window.api.onLoading(() => showSpinner());
window.api.onFile((data)  => renderContent(data));
window.api.onError((msg)  => { hideSpinner(); alert('Ошибка:\n' + msg); });

// ── Title bar ─────────────────────────────────────────────────────────────────
$('btn-min').addEventListener('click',   () => window.api.minimize());
$('btn-max').addEventListener('click',   () => window.api.maximize());
$('btn-close').addEventListener('click', () => window.api.close());

// ── Open file ─────────────────────────────────────────────────────────────────
// Open dialog has been removed.

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

  // Title bar: show full path, centered
  el.winTitle.textContent      = data.path;
  el.viewport.scrollTop        = 0;
  if (typeof settings !== 'undefined' && settings.lineNumbers) {
    updateAllCodeBlocksLineNumbers();
  }
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
    openBtn: 'Open',
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
    openBtn: 'Открыть',
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
  // Settings button text translation
  $('btn-settings').textContent = dict.settingsTitle;

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


