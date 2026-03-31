const { app, BrowserWindow, ipcMain, nativeImage, shell, dialog } = require('electron');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const express = require('express');
const { exiftool } = require('exiftool-vendored');

// CONFIGURATION
let DB_PATH;
let PHOTO_ROOT;
let db;

function loadLibrary(libraryPath) {
    const dbFile = path.join(libraryPath, 'archive.db');
    const pathFile = path.join(libraryPath, 'path.txt');

    if (fs.existsSync(dbFile) && fs.existsSync(pathFile)) {
        try {
            // Read the path from the library package
            const rawPath = fs.readFileSync(pathFile, 'utf8').trim();
            PHOTO_ROOT = path.isAbsolute(rawPath) ? rawPath : path.resolve(libraryPath, rawPath);
            
            // Close existing database if switching libraries
            if (db) db.close();
            db = new sqlite3.Database(dbFile);
            db.run('PRAGMA journal_mode = WAL;');
            db.run('PRAGMA cache_size = -20000;'); // 20MB cache
            DB_PATH = dbFile;
            return true;
        } catch (e) {
            console.error("Failed to load library files:", e);
            return false;
        }
    }
    return false;
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
    res.sendFile(fullPath);
});

mediaApp.listen(3999, '127.0.0.1');

// IPC HANDLERS
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
  // Return an empty array if no database is connected yet
  if (!db) return []; 
  
  return new Promise(res => db.all("SELECT year as y, COUNT(*) as c FROM assets WHERE year IS NOT NULL GROUP BY year ORDER BY year ASC", (e, r) => res(r || [])));
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
    // exiftool-vendored is used here for an ad-hoc, non-indexed read
    return await exiftool.read(fullPath);
});

app.whenReady().then(() => {
    // Check if a path was passed via terminal
    const args = process.argv;
    const libPath = args.find(a => a.endsWith('.photoslib'));
    if (libPath) {
        loadLibrary(libPath);
    }
    createWindow();
});



app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });