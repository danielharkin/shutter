// Shared utilities used by all library handlers

const sqlite3 = require('sqlite3').verbose();
const { exiftool } = require('exiftool-vendored');
const path = require('path');
const fs = require('fs');

const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.m4v', '.3gp', '.wmv', '.hevc']);
const SKIP_EXTS  = new Set(['.ds_store', '.aae', '.thm', '.db']);

function classifyType(relPath) {
    const ext   = path.extname(relPath).toLowerCase();
    const parts = relPath.toLowerCase().split(path.sep);

    for (const part of parts.slice(0, -1)) {
        if (part === 'screenshots' || part.startsWith('screenshot')) return 'screenshot';
        if (part === 'selfies'     || part === 'selfie')             return 'selfie';
    }

    return VIDEO_EXTS.has(ext) ? 'video' : 'photo';
}

function dbRun(db, sql, params = []) {
    return new Promise((res, rej) =>
        db.run(sql, params, err => err ? rej(err) : res())
    );
}

// Creates the standard assets schema inside a new database
async function createSchema(db, photoRoot) {
    return new Promise(res => {
        db.serialize(() => {
            db.run('CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT)');
            db.run('INSERT INTO config VALUES (?, ?)', ['photo_root', photoRoot]);
            db.run(`CREATE TABLE assets (
                id       INTEGER PRIMARY KEY AUTOINCREMENT,
                name     TEXT,
                rel_path TEXT UNIQUE,
                lat      REAL,
                lng      REAL,
                date     TEXT,
                category TEXT,
                folder   TEXT,
                type     TEXT,
                duration REAL,
                is_live  INTEGER DEFAULT 0,
                vid_path TEXT,
                tags     TEXT
            )`);
            db.run('CREATE INDEX idx_path     ON assets(rel_path)');
            db.run('CREATE INDEX idx_date     ON assets(date)');
            db.run('CREATE INDEX idx_category ON assets(category)');
            db.run('CREATE INDEX idx_type     ON assets(type)');
            db.run('CREATE INDEX idx_folder   ON assets(folder)');
            res();
        });
    });
}

// Phases 2-4: exiftool metadata, live photo pairing, type refinement
// Shared by all handlers — call after Phase 1 (structure) is complete.
//
// updateDates (default true): when false, exiftool only writes GPS + duration.
// Set to false for sources (e.g. iMovie Events) where Phase 1 already has
// authoritative per-clip dates from the plist and exiftool's CreateDate would
// only reflect the digitisation/import date, not the original recording date.
async function runMetadataPhases(db, sourceDir, allRelPaths, progressCallback, { updateDates = true } = {}) {
    // Phase 2: GPS, duration, and optionally dates via exiftool
    const BATCH = 20;
    let done = 0;

    for (let i = 0; i < allRelPaths.length; i += BATCH) {
        const batch = allRelPaths.slice(i, i + BATCH);

        await Promise.all(batch.map(async relPath => {
            try {
                const tags = await exiftool.read(path.join(sourceDir, relPath));
                const duration = tags.Duration ? parseFloat(tags.Duration) : null;

                let sql, params;
                if (updateDates) {
                    // Prefer embedded capture dates; skip FileModifyDate (filesystem mtime)
                    const embeddedDate = tags.DateTimeOriginal || tags['Keys:CreationDate'] || tags.CreateDate;
                    sql    = embeddedDate
                        ? 'UPDATE assets SET lat=?, lng=?, date=?, duration=? WHERE rel_path=?'
                        : 'UPDATE assets SET lat=?, lng=?,          duration=? WHERE rel_path=?';
                    params = embeddedDate
                        ? [tags.GPSLatitude || null, tags.GPSLongitude || null, embeddedDate.toString(), duration, relPath]
                        : [tags.GPSLatitude || null, tags.GPSLongitude || null,                          duration, relPath];
                } else {
                    // GPS + duration only — leave Phase 1 dates untouched
                    sql    = 'UPDATE assets SET lat=?, lng=?, duration=? WHERE rel_path=?';
                    params = [tags.GPSLatitude || null, tags.GPSLongitude || null, duration, relPath];
                }

                await dbRun(db, sql, params);
            } catch (e) {
                console.error(`Metadata error: ${relPath}`, e.message);
            }
            done++;
        }));

        progressCallback({ phase: 'metadata', status: 'progress', current: done, total: allRelPaths.length });
    }

    progressCallback({ phase: 'metadata', status: 'complete' });

    // Phase 3: Live Photo pairing — match image stems to companion video files
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

    await dbRun(db, `
        UPDATE assets SET is_live = -1
        WHERE rel_path IN (SELECT vid_path FROM assets WHERE is_live = 1 AND vid_path IS NOT NULL)
    `);

    progressCallback({ phase: 'live_photos', status: 'complete' });

    // Phase 4: Type refinement (folder-based classification already done in Phase 1)
    progressCallback({ phase: 'types', status: 'complete' });
}

// Opens a new SQLite database at outputLibPath, writing path.txt alongside it
function openDatabase(outputLibPath, sourceDir) {
    if (!fs.existsSync(outputLibPath)) fs.mkdirSync(outputLibPath, { recursive: true });
    fs.writeFileSync(path.join(outputLibPath, 'path.txt'), sourceDir, 'utf8');

    // Remove any existing database so we always start fresh
    const dbPath = path.join(outputLibPath, 'archive.db');
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

    const db = new sqlite3.Database(dbPath);
    db.run('PRAGMA journal_mode = WAL;');
    return db;
}

module.exports = { VIDEO_EXTS, SKIP_EXTS, classifyType, dbRun, createSchema, runMetadataPhases, openDatabase };
