const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path  = require('path');
const fs    = require('fs');
const { marked } = require('marked');
const hljs  = require('highlight.js');

marked.use({ async: false, gfm: true, breaks: true });

let mainWindow;
let recentFiles = [];
let recentPath;   // set after app.whenReady (userData path available then)

// ── Persist recent files ──────────────────────────────────────────────────────
function loadRecentFromDisk() {
  try {
    if (fs.existsSync(recentPath)) {
      const data = JSON.parse(fs.readFileSync(recentPath, 'utf-8'));
      recentFiles = Array.isArray(data) ? data.slice(0, 20) : [];
    }
  } catch { recentFiles = []; }
}

function saveRecentToDisk() {
  try { fs.writeFileSync(recentPath, JSON.stringify(recentFiles), 'utf-8'); }
  catch (e) { console.error('Failed to save recent:', e); }
}

// ── Window ───────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 680,
    minHeight: 480,
    frame: false,
    icon: path.join(__dirname, 'img', 'icon.png'),
    backgroundColor: '#f9f9f9',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  buildMenu();
}

function buildMenu() {
  const tpl = [
    {
      label: 'Файл',
      submenu: [
        { label: 'Открыть…', accelerator: 'CmdOrCtrl+O', click: openDialog },
        { type: 'separator' },
        { label: 'Печать / PDF', accelerator: 'CmdOrCtrl+P',
          click: () => mainWindow.webContents.print({ silent: false, printBackground: false }) },
        { type: 'separator' },
        { role: 'quit', label: 'Выход' }
      ]
    },
    {
      label: 'Вид',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}

// ── File open ────────────────────────────────────────────────────────────────
async function openDialog() {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Открыть Markdown файл',
    filters: [
      { name: 'Markdown / Text', extensions: ['md', 'markdown', 'mdx', 'txt'] },
      { name: 'Все файлы', extensions: ['*'] }
    ],
    properties: ['openFile']
  });

  if (canceled || !filePaths.length) return;

  // ← User has chosen a file → tell renderer to show spinner NOW
  mainWindow.webContents.send('file-loading');

  loadFile(filePaths[0]);
}

function loadFile(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    mainWindow.webContents.send('file-error', err.message);
    return;
  }

  const stats = fs.statSync(filePath);

  // Render markdown → HTML
  const rawHtml = String(marked.parse(content));

  // Syntax-highlight fenced code blocks
  const html = rawHtml
    .replace(
      /<pre><code class="language-(\w+)">([\s\S]*?)<\/code><\/pre>/g,
      (_, lang, code) => {
        const decoded = code
          .replace(/&amp;/g, '&').replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
        let highlighted = decoded;
        try {
          highlighted = hljs.getLanguage(lang)
            ? hljs.highlight(decoded, { language: lang }).value
            : hljs.highlightAuto(decoded).value;
        } catch { /* keep original */ }
        return `<pre class="code-block" data-lang="${lang}"><code>${highlighted}</code></pre>`;
      }
    )
    .replace(
      /<pre><code>([\s\S]*?)<\/code><\/pre>/g,
      '<pre class="code-block"><code>$1</code></pre>'
    );

  // Add to recent (don't reorder if already present)
  if (!recentFiles.includes(filePath)) {
    recentFiles.push(filePath);
    if (recentFiles.length > 20) recentFiles.shift();
    saveRecentToDisk();
  }

  mainWindow.webContents.send('file-loaded', {
    path: filePath,
    name: path.basename(filePath),
    html,
    size: stats.size,
    modified: stats.mtime.toISOString(),
  });

  mainWindow.setTitle(path.basename(filePath) + ' — MD Viewer');
}

// ── IPC handlers ─────────────────────────────────────────────────────────────
ipcMain.handle('open-dialog',  () => openDialog());

ipcMain.handle('get-recent',   () => {
  // Return sorted alphabetically by filename
  return [...recentFiles]
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b), 'ru', { sensitivity: 'base' }))
    .map(p => {
      try {
        const s = fs.statSync(p);
        return { path: p, name: path.basename(p), exists: true, size: s.size, modified: s.mtime.toISOString() };
      } catch {
        return { path: p, name: path.basename(p), exists: false };
      }
    });
});

ipcMain.handle('open-file',    (_, p) => {
  mainWindow.webContents.send('file-loading');
  loadFile(p);
});

ipcMain.handle('remove-recent', (_, p) => {
  recentFiles = recentFiles.filter(f => f !== p);
  saveRecentToDisk();
});

ipcMain.handle('show-in-explorer', (_, p) => shell.showItemInFolder(p));
ipcMain.handle('win-minimize', () => mainWindow.minimize());
ipcMain.handle('win-maximize', () => mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize());
ipcMain.handle('win-close',    () => mainWindow.close());

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  recentPath = path.join(app.getPath('userData'), 'recent.json');
  loadRecentFromDisk();

  createWindow();
  const argv = process.argv.slice(app.isPackaged ? 1 : 2);
  if (argv.length > 0 && fs.existsSync(argv[0])) {
    mainWindow.once('ready-to-show', () => {
      mainWindow.webContents.send('file-loading');
      loadFile(argv[0]);
    });
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
