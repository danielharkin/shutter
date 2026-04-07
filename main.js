const { app, BrowserWindow, ipcMain, nativeImage, shell, dialog } = require('electron');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const express = require('express');
const { exiftool } = require('exiftool-vendored');
const Store = require('electron-store');
const store = new Store.default({ projectName: 'shutter' });
const { generateLibrary } = require('./library-generator');


// CONFIGURATION
let DB_PATH;
let PHOTO_ROOT;
let db;

function loadLibrary(libraryPath) {
    const dbFile = path.join(libraryPath, 'archive.db');
    const pathFile = path.join(libraryPath, 'path.txt');

    if (!fs.existsSync(dbFile)) return false;

    try {
        if (db) db.close();
        db = new sqlite3.Database(dbFile);
        db.run('PRAGMA journal_mode = WAL;');
        db.run('PRAGMA cache_size = -20000;'); 
        DB_PATH = dbFile;
        addToHistory(libraryPath);

        // 1. Set PHOTO_ROOT immediately from path.txt if it exists (Synchronous safety)
        if (fs.existsSync(pathFile)) {
            const rawPath = fs.readFileSync(pathFile, 'utf8').trim();
            PHOTO_ROOT = path.isAbsolute(rawPath) ? rawPath : path.resolve(libraryPath, rawPath);
        }

        // 2. Then update/override from DB config if present
db.get("SELECT value FROM config WHERE key = 'photo_root'", (err, row) => {
            if (row) {
                PHOTO_ROOT = row.value;
            } else if (fs.existsSync(pathFile)) {
                const rawPath = fs.readFileSync(pathFile, 'utf8').trim();
                PHOTO_ROOT = path.isAbsolute(rawPath) ? rawPath : path.resolve(libraryPath, rawPath);
            }
        });
        return true;
    } catch (err) {
        console.error("Failed to load library:", err);
        return false;
    }
}

// MEDIA SERVER (Express)

function createWindow() {
  // If no library is loaded yet, you might want to show a 'Select Library' screen 
  // or at least prevent the app from trying to query a null database
  if (!db) {
      console.log("No library loaded. Waiting for open-file event.");
  }

  const win = new BrowserWindow({
    width: 1750, height: 1100,
    backgroundColor: '#000',
    titleBarStyle: 'hiddenInset',
    webPreferences: { 
        preload: path.join(__dirname, 'preload.js'), 
        contextIsolation: true,
        webSecurity: false 
    }
  });
  win.loadFile('index.html');
}

app.on('open-file', (event, path) => {
    event.preventDefault();
    if (loadLibrary(path)) {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
        else BrowserWindow.getAllWindows()[0].webContents.reload();
    }
});

// Formats that need thumbnail generation rather than direct serving
const THUMB_EXTS = new Set(['.heic', '.heif', '.mov', '.mp4', '.avi', '.mkv', '.m4v', '.3gp', '.wmv', '.hevc', '.dv']);

const { execSync, spawnSync, spawn } = require('child_process');
const os = require('os');

const VLC_BIN = '/Applications/VLC.app/Contents/MacOS/VLC';
const vlcAvailable = fs.existsSync(VLC_BIN);

// Currently running VLC stream process (only one at a time)
let vlcStreamProc = null;
const VLC_STREAM_PORT = 8765;

function qlThumb(fullPath) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shutter-'));
    try {
        execSync(`qlmanage -t -s 400 -o "${tmpDir}" "${fullPath}"`, {
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 10000,
        });
        const files = fs.readdirSync(tmpDir);
        if (files.length > 0) {
            const data = fs.readFileSync(path.join(tmpDir, files[0]));
            const ext  = path.extname(files[0]).toLowerCase();
            return { data, type: ext === '.png' ? 'image/png' : 'image/jpeg' };
        }
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    return null;
}

function vlcThumb(fullPath) {
    if (!vlcAvailable) return null;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shutter-vlc-'));
    try {
        spawnSync(VLC_BIN, [
            '--intf', 'dummy',
            '--video-filter', 'scene',
            '--scene-format', 'png',
            '--scene-ratio', '24',
            '--scene-prefix', 'thumb',
            '--scene-path', tmpDir,
            '--play-and-exit',
            '--no-audio',
            '--run-time', '3',
            fullPath,
        ], { timeout: 15000 });
        const files = fs.readdirSync(tmpDir).filter(f => f.endsWith('.png'));
        if (files.length > 0) {
            const data = fs.readFileSync(path.join(tmpDir, files[0]));
            return { data, type: 'image/png' };
        }
    } catch (_) { /* VLC failed */ } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    return null;
}

// Start VLC streaming the given file as MPEG-TS over HTTP on VLC_STREAM_PORT.
// Kills any previously running stream first. Returns the stream URL.
function startVlcStream(fullPath) {
    if (vlcStreamProc) {
        try { vlcStreamProc.kill(); } catch (_) {}
        vlcStreamProc = null;
    }
    const sout = `#transcode{vcodec=h264,vb=2000,acodec=mp4a,ab=128}:http{mux=ts,dst=:${VLC_STREAM_PORT}/stream}`;
    vlcStreamProc = spawn(VLC_BIN, [
        '--intf', 'dummy',
        '--repeat',
        fullPath,
        '--sout', sout,
        '--sout-keep',
    ]);
    vlcStreamProc.on('error', e => console.error('VLC stream error:', e.message));
    vlcStreamProc.on('close', () => { vlcStreamProc = null; });
    return `http://127.0.0.1:${VLC_STREAM_PORT}/stream`;
}

const mediaApp = express();
mediaApp.use('/thumb', async (req, res) => {
    const relPath = decodeURIComponent(req.path.substring(1));
    const fullPath = path.join(PHOTO_ROOT, relPath);
    const ext = path.extname(fullPath).toLowerCase();
    try {
        if (THUMB_EXTS.has(ext)) {
            // 1. Electron Quick Look (fast, modern formats)
            try {
                const thumb = await nativeImage.createThumbnailFromPath(fullPath, { width: 400, height: 400 });
                if (!thumb.isEmpty()) {
                    res.setHeader('Content-Type', 'image/jpeg');
                    return res.send(thumb.toJPEG(85));
                }
            } catch (_) { /* fall through to qlmanage */ }

            // 2. qlmanage fallback (handles DV, AVI, and other system-supported formats)
            try {
                const result = qlThumb(fullPath);
                if (result) {
                    res.setHeader('Content-Type', result.type);
                    return res.send(result.data);
                }
            } catch (_) { /* qlmanage failed */ }

            // 3. VLC fallback (old codecs qlmanage can't handle)
            try {
                const result = vlcThumb(fullPath);
                if (result) {
                    res.setHeader('Content-Type', result.type);
                    return res.send(result.data);
                }
            } catch (_) { /* VLC failed */ }

            return res.status(404).send();
        } else {
            res.sendFile(fullPath);
        }
    } catch (e) {
        console.error(`Thumb error: ${e.message}`);
        res.status(404).send();
    }
});

// Dynamic media handler to support library switching
mediaApp.use('/media', (req, res) => {
    if (!PHOTO_ROOT) return res.status(404).send("No library loaded");
    const relPath = decodeURIComponent(req.path.substring(1));
    const fullPath = path.join(PHOTO_ROOT, relPath);
    const ext = path.extname(fullPath).toLowerCase();
    if (ext === '.mp4') {
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Accept-Ranges', 'bytes');
    } else if (ext === '.mov') {
        res.setHeader('Content-Type', 'video/quicktime');
        res.setHeader('Accept-Ranges', 'bytes');
    }
    res.sendFile(fullPath);
});


mediaApp.listen(3999, '127.0.0.1');

// IPC HANDLERS

ipcMain.handle('create-library', async (event) => {
    const source = await dialog.showOpenDialog({
        title: "Select Photo Source Folder (Read-Only)",
        properties: ['openDirectory']
    });
    if (source.canceled) return { success: false };

    const dest = await dialog.showSaveDialog({
        title: "Create New Shutter Library",
        defaultPath: "MyNewLibrary.photoslib",
        buttonLabel: "Create Library"
    });
    if (dest.canceled) return { success: false };

    const selectedSourceDir = source.filePaths[0]; 
    const selectedOutputLib = dest.filePath;

    const libraryName = path.basename(selectedOutputLib).replace('.photoslib', '');
    try {
        await generateLibrary(selectedSourceDir, selectedOutputLib, (data) => {
            // On structure complete: load the library so the DB is ready before the UI asks for data
            if (data.phase === 'structure' && data.status === 'complete') {
                loadLibrary(selectedOutputLib);
            }
            event.sender.send('library-generation-progress', { ...data, libraryName });
        });
        event.sender.send('library-generation-progress', { phase: 'complete', status: 'complete' });
        return { success: true, path: selectedOutputLib };
    } catch (err) {
        console.error("Library Generation Failed:", err);
        return { success: false, error: err.message };
    }
});


ipcMain.handle('vlc-stream', (_event, relPath) => {
    if (!vlcAvailable) return { success: false, error: 'VLC not installed' };
    const fullPath = path.join(PHOTO_ROOT, decodeURIComponent(relPath));
    const url = startVlcStream(fullPath);
    // Give VLC a moment to bind before returning the URL
    return new Promise(resolve => setTimeout(() => resolve({ success: true, url }), 1500));
});

ipcMain.handle('reveal-in-finder', (event, relPath) => {
    const fullPath = path.join(PHOTO_ROOT, decodeURIComponent(relPath));
    shell.showItemInFolder(fullPath);
    return true;
});

ipcMain.handle('open-file', (event, relPath) => {
    const fullPath = path.join(PHOTO_ROOT, decodeURIComponent(relPath));
    shell.openPath(fullPath);
    return true;
});

ipcMain.handle('load-library', async (event, libPath) => {
    const success = loadLibrary(libPath);
    if (success) {
        console.log(`Successfully switched to library: ${libPath}`);
        return true;
    }
    return false;
});

ipcMain.handle('select-library', async () => {
    const result = await dialog.showOpenDialog({
        // 'openDirectory' allows selecting folders
        // 'treatPackageAsDirectory' allows selecting .photoslib packages on macOS
        properties: ['openDirectory', 'treatPackageAsDirectory'],
        message: "Select your .photoslib library",
        buttonLabel: "Open Library"
    });

    if (!result.canceled && result.filePaths.length > 0) {
        const libPath = result.filePaths[0];
        const success = loadLibrary(libPath); // This function handles the .db and .txt
        return { success, path: libPath };
    }
    return { success: false };
});


ipcMain.handle('get-full-exif', async (event, relPath) => {
    try {
        const fullPath = path.join(PHOTO_ROOT, decodeURIComponent(relPath));
        return await exiftool.read(fullPath, ["-ee", "-G1"]);
    } catch (e) { return { error: e.message }; }
});

ipcMain.handle('get-years', () => {
  if (!db) return [];
  return new Promise(res => db.all(
    "SELECT category as y, COUNT(*) as c FROM assets GROUP BY y",
    (e, r) => res(r || [])
  ));
});

ipcMain.handle('get-folder-tree', () => {
    if (!db) return [];
    return new Promise(res => {
        db.all(
            "SELECT folder, COUNT(*) as count FROM assets WHERE folder IS NOT NULL AND folder != '' GROUP BY folder ORDER BY folder",
            (err, rows) => {
                if (err || !rows || rows.length === 0) {
                    // Fallback: use category as single-level folder for older libraries
                    db.all(
                        "SELECT category as folder, COUNT(*) as count FROM assets GROUP BY category ORDER BY category",
                        (e2, r2) => res(r2 || [])
                    );
                } else {
                    res(rows);
                }
            }
        );
    });
});

ipcMain.handle('get-assets', (event, folder) => {
    if (!db) return [];
    if (folder === 'all') {
        return new Promise(res => db.all(
            "SELECT *, rel_path as path FROM assets ORDER BY date DESC",
            (e, r) => res(r || [])
        ));
    }
    return new Promise(res => {
        db.all(
            "SELECT *, rel_path as path FROM assets WHERE (folder = ? OR folder LIKE ?) ORDER BY date DESC",
            [folder, folder + '/%'],
            (err, rows) => {
                if (err || !rows || rows.length === 0) {
                    // Fallback: category-based for libraries without folder column
                    db.all(
                        "SELECT *, rel_path as path FROM assets WHERE category = ? ORDER BY date DESC",
                        [folder],
                        (e2, r2) => res(r2 || [])
                    );
                } else {
                    res(rows);
                }
            }
        );
    });
});

ipcMain.handle('get-detailed-metadata', async (event, relativePath) => {
    const fullPath = path.join(PHOTO_ROOT, relativePath);
    return await exiftool.read(fullPath);
});

function addToHistory(libPath) {
    try {
        let history = store.get('libraryHistory') || [];
        history = [libPath, ...history.filter(p => p !== libPath)].slice(0, 5);
        store.set('libraryHistory', history);
    } catch (e) {
        console.error("History store failed:", e);
    }
}

ipcMain.handle('get-library-history', () => {
    return store.get('libraryHistory') || [];
});

ipcMain.handle('rebuild-library', async (event) => {
    if (!DB_PATH || !PHOTO_ROOT) return { success: false, error: 'No library loaded' };
    const libraryPath = path.dirname(DB_PATH);
    const libraryName = path.basename(libraryPath).replace('.photoslib', '');
    try {
        await generateLibrary(PHOTO_ROOT, libraryPath, (data) => {
            if (data.phase === 'structure' && data.status === 'complete') {
                loadLibrary(libraryPath);
            }
            event.sender.send('library-generation-progress', { ...data, libraryName });
        });
        event.sender.send('library-generation-progress', { phase: 'complete', status: 'complete' });
        return { success: true };
    } catch (err) {
        console.error('Rebuild failed:', err);
        return { success: false, error: err.message };
    }
});

app.whenReady().then(() => {
    const args = process.argv;
    const libPath = args.find(a => a.endsWith('.photoslib'));
    if (libPath) {
        loadLibrary(libPath);
    }
    createWindow();
});

app.on('window-all-closed', () => { 
    if (process.platform !== 'darwin') app.quit(); 
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
});