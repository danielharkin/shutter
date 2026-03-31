const sqlite3 = require('sqlite3').verbose();
const { exiftool } = require('exiftool-vendored');
const path = require('path');
const fs = require('fs');

async function generateLibrary(sourceDir, outputLibPath, progressCallback) {
    // 1. Setup Output Structure
    if (!fs.existsSync(outputLibPath)) fs.mkdirSync(outputLibPath);
    const dbPath = path.join(outputLibPath, 'archive.db');
    const db = new sqlite3.Database(dbPath);

    // 2. Initialize Schema (Config + Assets)
    await new Promise(res => {
        db.serialize(() => {
            db.run('CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT)');
            db.run('INSERT INTO config (key, value) VALUES (?, ?)', ['photo_root', sourceDir]);
            db.run(`CREATE TABLE assets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT,
                rel_path TEXT UNIQUE,
                lat REAL,
                lng REAL,
                date TEXT,
                category TEXT,
                duration TEXT,
                is_live INTEGER DEFAULT 0,
                vid_path TEXT
            )`);
            db.run('CREATE INDEX idx_path ON assets(rel_path)');
            res();
        });
    });

    // 3. Discovery (Gather all files)
    // In a full implementation, we'd use a recursive glob here
    const allFiles = []; 
    let processed = 0;

    // 4. Deep Extraction Loop
    for (const relPath of allFiles) {
        const fullPath = path.join(sourceDir, relPath);
        
        try {
            // SINGLE PASS READ - No file modifications allowed
            const tags = await exiftool.read(fullPath);

            // ROBUST DATE FALLBACK
            const date = tags.DateTimeOriginal || tags['Keys:CreationDate'] || 
                         tags.CreateDate || tags.FileModifyDate;

            // GPS FIX (Uses direct decimals to avoid horizontal shift)
            const lat = tags.GPSLatitude || null;
            const lng = tags.GPSLongitude || null;

            // CATEGORY LOGIC
            let category = 'photo';
            if (tags.Model?.toLowerCase().includes('front')) category = 'selfie';
            if (relPath.toLowerCase().includes('screenshot')) category = 'screenshot';

            // DURATION CLEANING (Uses your MM:SS logic)
            let duration = null;
            if (tags.Duration) {
                const sec = parseFloat(tags.Duration);
                duration = `${Math.floor(sec / 60)}:${Math.round(sec % 60).toString().padStart(2, '0')}`;
            }

            await new Promise(res => db.run(
                `INSERT INTO assets (name, rel_path, lat, lng, date, category, duration) 
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [path.basename(relPath), relPath, lat, lng, date?.toString(), category, duration],
                res
            ));

        } catch (e) {
            console.error(`Error reading ${relPath}:`, e);
        }

        processed++;
        if (processed % 100 === 0) progressCallback(processed, allFiles.length);
    }

    // 5. POST-PROCESS: LIVE PHOTO PAIRING
    // Matches based on relative path and filename stem
    await new Promise(res => db.run(`
        UPDATE assets 
        SET is_live = 1, 
            vid_path = (SELECT rel_path FROM assets AS v 
                        WHERE v.name LIKE assets.name || '%' 
                        AND (v.rel_path LIKE '%.mov' OR v.rel_path LIKE '%.mp4') 
                        LIMIT 1)
        WHERE (rel_path LIKE '%.jpg' OR rel_path LIKE '%.heic')
    `, res));

    db.close();
    await exiftool.end();
}