const { app, BrowserWindow, ipcMain, nativeImage, shell, dialog } = require('electron');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const express = require('express');
const { exiftool } = require('exiftool-vendored');
const Store = require('electron-store');
const store = new Store.default();
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
            if (row) PHOTO_ROOT = row.value;
        });

        return true; // Return true here, once the DB connection is initiated
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

const mediaApp = express();
mediaApp.use('/thumb', async (req, res) => {
    const relPath = decodeURIComponent(req.path.substring(1));
    const fullPath = path.join(PHOTO_ROOT, relPath);
    const ext = path.extname(fullPath).toLowerCase();
    try {
        if (['.heic', '.heif', '.mov', '.mp4'].includes(ext)) {
            const thumb = await nativeImage.createThumbnailFromPath(fullPath, { width: 400, height: 400 });
            res.setHeader('Content-Type', 'image/jpeg');
            res.send(thumb.toJPEG(85));
        } else {
            res.sendFile(fullPath);
        }
    } catch (e) { res.status(404).send(); }
});

// Dynamic media handler to support library switching
mediaApp.use('/media', (req, res) => {
    if (!PHOTO_ROOT) return res.status(404).send("No library loaded");
    const relPath = decodeURIComponent(req.path.substring(1));
    const fullPath = path.join(PHOTO_ROOT, relPath);
const ext = path.extname(fullPath).toLowerCase();
    if (['.mov', '.mp4'].includes(ext)) {
        res.setHeader('Content-Type', 'video/mp4');
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

    // Use existing variable names without 'const' if they are global, 
    // or keep 'const' here and remove them from the top of the file.
    const selectedSourceDir = source.filePaths[0]; 
    const selectedOutputLib = dest.filePath;

    try {
        await generateLibrary(selectedSourceDir, selectedOutputLib, (data) => {
            event.sender.send('library-generation-progress', data);
        });
        
        const success = loadLibrary(selectedOutputLib);
        return { success, path: selectedOutputLib };
    } catch (err) {
        console.error("Library Generation Failed:", err);
        return { success: false, error: err.message };
    }
});


ipcMain.handle('reveal-in-finder', (event, relPath) => {
    const fullPath = path.join(PHOTO_ROOT, decodeURIComponent(relPath));
    shell.showItemInFolder(fullPath);
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

// REPLACE your 'get-assets' handler in main.js with this:
ipcMain.handle('get-assets', (event, folder) => {
  // Removed the restriction on is_live so the frontend 'Live' toggle can work
  const sql = folder === 'all' 
    ? "SELECT * FROM assets ORDER BY date DESC" 
    : "SELECT * FROM assets WHERE year = ? ORDER BY date DESC";
  return new Promise(res => db.all(sql, folder === 'all' ? [] : [folder], (e, r) => res(r || [])));
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