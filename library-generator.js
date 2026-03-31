const sqlite3 = require('sqlite3').verbose();
const { exiftool } = require('exiftool-vendored');
const path = require('path');
const fs = require('fs');

// Retained: Recursive scanner to find all files
function getFilesRecursively(dir, baseDir, fileList = []) {
    const files = fs.readdirSync(dir);
    for (const file of files) {
        const fullPath = path.join(dir, file);
        if (fs.statSync(fullPath).isDirectory()) {
            getFilesRecursively(fullPath, baseDir, fileList);
        } else {
            fileList.push(path.relative(baseDir, fullPath));
        }
    }
    return fileList;
}

async function generateLibrary(sourceDir, outputLibPath, progressCallback) {
    if (!fs.existsSync(outputLibPath)) fs.mkdirSync(outputLibPath);
    const dbPath = path.join(outputLibPath, 'archive.db');
    const db = new sqlite3.Database(dbPath);

    // Initialize Schema
    await new Promise(res => {
        db.serialize(() => {
            db.run('CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT)');
            db.run('INSERT INTO config (key, value) VALUES (?, ?)', ['photo_root', sourceDir]);
            db.run(`CREATE TABLE assets (
                id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, rel_path TEXT UNIQUE,
                lat REAL, lng REAL, date TEXT, category TEXT, duration TEXT,
                is_live INTEGER DEFAULT 0, vid_path TEXT
            )`);
            db.run('CREATE INDEX idx_path ON assets(rel_path)');
            db.run('CREATE INDEX idx_date ON assets(date)');
            db.run('CREATE INDEX idx_category ON assets(category)');
            res();
        });
    });

    const allFiles = getFilesRecursively(sourceDir, sourceDir);
    
    // --- PHASE 1: FAST DISCOVERY ---
    // Instantly populate the DB with paths so the UI can load folders/thumbs
    for (const relPath of allFiles) {
        const stats = fs.statSync(path.join(sourceDir, relPath));
        await new Promise(res => db.run(
            `INSERT OR IGNORE INTO assets (name, rel_path, date, category) VALUES (?, ?, ?, ?)`,
            [path.basename(relPath), relPath, stats.mtime.toISOString(), 'photo'], 
            res
        ));
    }
    
    // Signal UI: Phase 1 is done, folders can be rendered now
    progressCallback({ phase: 'discovery_complete', total: allFiles.length });

    // --- PHASE 2: BACKGROUND ENRICHMENT ---
    for (let i = 0; i < allFiles.length; i++) {
        const relPath = allFiles[i];
        try {
            const tags = await exiftool.read(path.join(sourceDir, relPath));
            const bestDate = tags.DateTimeOriginal || tags['Keys:CreationDate'] || tags.CreateDate || tags.FileModifyDate;
            
            let duration = null;
            if (tags.Duration) {
                const sec = parseFloat(tags.Duration);
                duration = `${Math.floor(sec / 60)}:${Math.round(sec % 60).toString().padStart(2, '0')}`;
            }

            await new Promise(res => db.run(
                `UPDATE assets SET lat = ?, lng = ?, date = ?, duration = ? WHERE rel_path = ?`,
                [tags.GPSLatitude || null, tags.GPSLongitude || null, bestDate?.toString(), duration, relPath],
                res
            ));
        } catch (e) { console.error(`Error enriching ${relPath}:`, e); }
        
        if (i % 100 === 0) progressCallback({ phase: 'enriching', current: i, total: allFiles.length });
    }

    // Retained: Phase 3 Finalize (Live Photo Pairing)
    await new Promise(res => db.run(`
        UPDATE assets SET is_live = 1, 
        vid_path = (SELECT rel_path FROM assets AS v WHERE v.name LIKE assets.name || '%' AND (v.rel_path LIKE '%.mov' OR v.rel_path LIKE '%.mp4') LIMIT 1)
        WHERE (rel_path LIKE '%.jpg' OR rel_path LIKE '%.heic')`, res));

    db.close();
}

const category = relPath.includes(path.sep) ? relPath.split(path.sep)[0] : 'Unsorted';
        await new Promise(res => db.run(
            `INSERT OR IGNORE INTO assets (name, rel_path, date, category) VALUES (?, ?, ?, ?)`,
            [path.basename(relPath), relPath, stats.mtime.toISOString(), category], 
            res
        ));

module.exports = { generateLibrary };