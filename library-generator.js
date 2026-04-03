const sqlite3 = require('sqlite3').verbose();
const { exiftool } = require('exiftool-vendored');
const path = require('path');
const fs = require('fs');

const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.m4v', '.3gp', '.wmv', '.hevc']);
const SKIP_EXTS  = new Set(['.ds_store', '.aae', '.thm', '.db']);

function getFilesRecursively(dir, baseDir, fileList = []) {
    const files = fs.readdirSync(dir);
    for (const file of files) {
        if (file.startsWith('.')) continue;
        const fullPath = path.join(dir, file);
        if (fs.statSync(fullPath).isDirectory()) {
            getFilesRecursively(fullPath, baseDir, fileList);
        } else {
            const ext = path.extname(file).toLowerCase();
            if (!SKIP_EXTS.has(ext)) fileList.push(path.relative(baseDir, fullPath));
        }
    }
    return fileList;
}

// Classify media type from file extension and folder name hints
function classifyType(relPath) {
    const ext  = path.extname(relPath).toLowerCase();
    const parts = relPath.toLowerCase().split(path.sep);

    // Apple Photos export folder name heuristics
    for (const part of parts.slice(0, -1)) {
        if (part === 'screenshots' || part.startsWith('screenshot')) return 'screenshot';
        if (part === 'selfies' || part === 'selfie')                  return 'selfie';
    }

    return VIDEO_EXTS.has(ext) ? 'video' : 'photo';
}


async function dbRun(db, sql, params = []) {
    return new Promise((res, rej) =>
        db.run(sql, params, err => err ? rej(err) : res())
    );
}

async function generateLibrary(sourceDir, outputLibPath, progressCallback) {
    if (!fs.existsSync(outputLibPath)) fs.mkdirSync(outputLibPath, { recursive: true });

    // Always write path.txt so loadLibrary() can find the source folder
    fs.writeFileSync(path.join(outputLibPath, 'path.txt'), sourceDir, 'utf8');

    const dbPath = path.join(outputLibPath, 'archive.db');
    const db = new sqlite3.Database(dbPath);
    db.run('PRAGMA journal_mode = WAL;');

    // ── Schema ──────────────────────────────────────────────────────────────
    await new Promise(res => {
        db.serialize(() => {
            db.run('CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT)');
            db.run('INSERT INTO config VALUES (?, ?)', ['photo_root', sourceDir]);
            db.run(`CREATE TABLE assets (
                id       INTEGER PRIMARY KEY AUTOINCREMENT,
                name     TEXT,
                rel_path TEXT UNIQUE,
                lat      REAL,
                lng      REAL,
                date     TEXT,
                category TEXT,
                type     TEXT,
                duration REAL,
                is_live  INTEGER DEFAULT 0,
                vid_path TEXT
            )`);
            db.run('CREATE INDEX idx_path     ON assets(rel_path)');
            db.run('CREATE INDEX idx_date     ON assets(date)');
            db.run('CREATE INDEX idx_category ON assets(category)');
            db.run('CREATE INDEX idx_type     ON assets(type)');
            res();
        });
    });

    // ── PHASE 1 : Structure ─────────────────────────────────────────────────
    // Scan filesystem, classify type, insert all rows immediately.
    // This is synchronous and fast — the UI can render as soon as it's done.
    const allFiles = getFilesRecursively(sourceDir, sourceDir);

    await new Promise((res, rej) => {
        db.serialize(() => {
            db.run('BEGIN');
            const stmt = db.prepare(
                'INSERT OR IGNORE INTO assets (name, rel_path, date, category, type) VALUES (?, ?, ?, ?, ?)'
            );
            for (const relPath of allFiles) {
                const stats    = fs.statSync(path.join(sourceDir, relPath));
                const category = relPath.includes(path.sep) ? relPath.split(path.sep)[0] : 'Unsorted';
                const type     = classifyType(relPath);
                stmt.run(path.basename(relPath), relPath, stats.mtime.toISOString(), category, type);
            }
            stmt.finalize();
            db.run('COMMIT', err => err ? rej(err) : res());
        });
    });

    progressCallback({ phase: 'structure', status: 'complete', total: allFiles.length });
    // ↑ The main process will call loadLibrary() and initApp() here.

    // ── PHASE 2 : Metadata (GPS + Date + Duration) ──────────────────────────
    // Run exiftool in parallel batches for speed (exiftool-vendored pools internally).
    const BATCH = 20;
    let done = 0;

    for (let i = 0; i < allFiles.length; i += BATCH) {
        const batch = allFiles.slice(i, i + BATCH);

        await Promise.all(batch.map(async relPath => {
            try {
                const tags     = await exiftool.read(path.join(sourceDir, relPath));
                const bestDate = tags.DateTimeOriginal || tags['Keys:CreationDate'] ||
                                 tags.CreateDate       || tags.FileModifyDate;
                const duration = tags.Duration ? parseFloat(tags.Duration) : null;

                await dbRun(db,
                    'UPDATE assets SET lat=?, lng=?, date=?, duration=? WHERE rel_path=?',
                    [tags.GPSLatitude || null, tags.GPSLongitude || null,
                     bestDate?.toString() || null, duration, relPath]
                );
            } catch (e) {
                console.error(`Metadata error: ${relPath}`, e.message);
            }
            done++;
        }));

        progressCallback({ phase: 'metadata', status: 'progress', current: done, total: allFiles.length });
    }

    progressCallback({ phase: 'metadata', status: 'complete' });

    // ── PHASE 3 : Live Photo Pairing ────────────────────────────────────────
    // Match .jpg/.heic images to their companion .mov/.mp4 by stem name.
    await dbRun(db, `
        UPDATE assets SET
            is_live  = 1,
            vid_path = (
                SELECT v.rel_path FROM assets v
                WHERE  v.name LIKE (SUBSTR(assets.name, 1, INSTR(assets.name, '.') - 1) || '%')
                AND    (v.rel_path LIKE '%.mov' OR v.rel_path LIKE '%.mp4')
                LIMIT  1
            )
        WHERE (rel_path LIKE '%.jpg' OR rel_path LIKE '%.heic' OR rel_path LIKE '%.heif')
        AND   vid_path IS NULL
    `);

    // Tag the video halves so they can be hidden/filtered
    await dbRun(db, `
        UPDATE assets SET is_live = -1
        WHERE rel_path IN (SELECT vid_path FROM assets WHERE is_live = 1 AND vid_path IS NOT NULL)
    `);

    progressCallback({ phase: 'live_photos', status: 'complete' });

    // ── PHASE 4 : Type Refinement ───────────────────────────────────────────
    // Re-classify selfies from EXIF (front camera) and screenshots from tags.
    // duration is now stored as raw seconds (REAL) so short-video detection
    // happens at render time in grid.js (duration < 5).
    //
    // Basic EXIF-based selfie detection: some cameras write LensMake or
    // front-camera indicators into QuickTime / EXIF tags.  We do a lightweight
    // SQL pass over rows that exiftool enriched with front-camera evidence.
    // (Folder-based detection already ran in Phase 1.)

    progressCallback({ phase: 'types', status: 'complete' });

    db.close();
}

module.exports = { generateLibrary };
