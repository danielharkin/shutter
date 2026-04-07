// Handler for iMovie Events libraries (pre-iMovie 10 flat event folder structure)
//
// Source structure:
//   SourceDir/
//     EventFolderName/
//       iMovie Data          ← binary NSKeyedArchiver plist (event metadata)
//       clip1.mov
//       clip2.mov
//
// Virtual folder mapping:
//   folder   = "YYYY/Event Display Name"   (used for sidebar tree)
//   category = "YYYY"                      (top-level year group)
//   rel_path = "EventFolderName/clip.mov"  (physical path for file serving)

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { SKIP_EXTS, classifyType, createSchema, runMetadataPhases, openDatabase } = require('./shared');

const COCOA_OFFSET = 978307200; // seconds: Mac epoch (2001-01-01) → Unix epoch (1970-01-01)

// Junk strings that appear as structural plist / NSKeyedArchiver artefacts
const JUNK_TAGS = new Set([
    '$null', '%Y-%m-%d %H:%M:%S %z', 'RCRejectedRangeType', 'date1',
    'dateProperties', 'ranges', 'version', 'Europe/London', 'UTC',
    'Tag', 'RangeObject',
]);

// ── Plist helpers ────────────────────────────────────────────────────────────

// Extract keyword tags from the plist's NSKeyedArchiver $objects array.
// Mirrors dataaudit.py: pull all strings >3 chars that aren't dates or filenames,
// then strip known structural junk. Tags are per-event (same for all clips).
function extractPlistTags(eventFolderPath) {
    const plistPath = path.join(eventFolderPath, 'iMovie Data');
    if (!fs.existsSync(plistPath)) return '';
    try {
        // Use XML conversion (same as readPlistTimestamps) — more reliable than JSON
        // for old NSKeyedArchiver plists. Extract all <string> values then filter,
        // mirroring dataaudit.py's iteration over $objects.
        const result = spawnSync('plutil', ['-convert', 'xml1', plistPath, '-o', '-'], {
            encoding: 'utf8',
        });
        if (result.status !== 0) throw new Error(result.stderr || 'plutil failed');
        const xml = result.stdout;
        const matches = xml.match(/<string>([^<]+)<\/string>/g) || [];
        const tags = new Set();
        for (const m of matches) {
            const val = m.replace(/<\/?string>/g, '').trim();
            if (val.length <= 3) continue;
            if (/^\d{4}/.test(val)) continue;               // skip dates/years
            if (/\.(mov|mp4|m4v)$/i.test(val)) continue;   // skip filenames
            if (/^NS[A-Z]/.test(val)) continue;             // skip ObjC class names
            if (JUNK_TAGS.has(val)) continue;
            tags.add(val);
        }
        return [...tags].sort().join(', ');
    } catch (e) {
        console.warn(`Tag extraction failed for ${eventFolderPath}:`, e.message);
        return '';
    }
}

// Extract all Cocoa timestamps from the raw XML plist.
// The plist embeds one timestamp per clip as raw numeric values.
// We grep for 8-10 digit numbers (optionally negative, optionally fractional),
// filter to the plausible date range, then sort ascending.
// This mirrors the approach from the user-provided fix script.
function readPlistTimestamps(eventFolderPath) {
    const plistPath = path.join(eventFolderPath, 'iMovie Data');
    if (!fs.existsSync(plistPath)) return [];
    try {
        const result = spawnSync('plutil', ['-convert', 'xml1', plistPath, '-o', '-'], {
            encoding: 'utf8',
        });
        if (result.status !== 0) throw new Error(result.stderr || 'plutil failed');
        const xml = result.stdout;
        const matches = xml.match(/-?\d{8,10}(?:\.\d+)?/g) || [];
        return matches
            .map(m => parseFloat(m))
            .filter(ts => ts >= -978307200 && ts <= 2524608000) // 1970–2050 in Cocoa time
            .sort((a, b) => a - b);
    } catch (e) {
        console.warn(`plist timestamp extraction failed at ${eventFolderPath}:`, e.message);
        return [];
    }
}

function cocoaToExifDate(cocoaTs) {
    const d = new Date((cocoaTs + COCOA_OFFSET) * 1000);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}:${pad(d.getUTCMonth()+1)}:${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

// ── Naming helpers ───────────────────────────────────────────────────────────

// Extract 4-digit year from the start of a folder name (e.g. "2018-12-25 Christmas" → "2018")
function yearFromFolderName(name) {
    const m = name.match(/^(\d{4})/);
    if (!m) return null;
    const y = parseInt(m[1]);
    return (y >= 1900 && y <= 2100) ? m[1] : null;
}

// Strip leading date prefix so folder name becomes a clean display name
// "2018-12-25 Christmas" → "Christmas"
// "2018 Summer Trip"     → "Summer Trip"
// "Summer Trip"          → "Summer Trip"  (no change)
function eventDisplayName(name) {
    return name.replace(/^\d{4}[-_]?\d{0,2}[-_]?\d{0,2}\s+/, '').trim() || name;
}

// Try to extract a YYYY:MM:DD 00:00:00 date from common filename patterns
// e.g. IMG_20181225_123456.mov, 2018-12-25 12.34.56.mp4
function dateFromFilename(filename) {
    const m = filename.match(/(\d{4})[_-](\d{2})[_-](\d{2})/);
    if (!m) return null;
    const y = parseInt(m[1]);
    if (y < 1990 || y > 2035) return null;
    return `${m[1]}:${m[2]}:${m[3]} 00:00:00`;
}

// ── Source detection ─────────────────────────────────────────────────────────

// Returns true if sourceDir looks like an iMovie Events library
function detect(sourceDir) {
    try {
        for (const entry of fs.readdirSync(sourceDir)) {
            if (entry.startsWith('.')) continue;
            const fullPath = path.join(sourceDir, entry);
            if (fs.statSync(fullPath).isDirectory() &&
                fs.existsSync(path.join(fullPath, 'iMovie Data'))) {
                return true;
            }
        }
    } catch (e) { /* not readable */ }
    return false;
}

// ── Generator ────────────────────────────────────────────────────────────────

async function generate(sourceDir, outputLibPath, progressCallback) {
    const db = openDatabase(outputLibPath, sourceDir);
    await createSchema(db, sourceDir);

    // Only treat folders that contain an 'iMovie Data' plist as events.
    // This naturally excludes iMovie internal dirs (iMovie Cache, iMovie Thumbnails, etc.)
    const eventFolders = fs.readdirSync(sourceDir).filter(name => {
        if (name.startsWith('.')) return false;
        const fullPath = path.join(sourceDir, name);
        return fs.statSync(fullPath).isDirectory() &&
               fs.existsSync(path.join(fullPath, 'iMovie Data'));
    });

    const allEntries = [];

    for (const eventName of eventFolders) {
        const eventPath  = path.join(sourceDir, eventName);

        // Extract per-clip Cocoa timestamps from the plist (sorted ascending).
        // Mirrors the fix script: plutil → grep 8-10 digit numbers → sort -n
        const timestamps = readPlistTimestamps(eventPath);
        const eventTags  = extractPlistTags(eventPath);

        // iMovie Events are flat — media files sit directly in the event folder.
        // Sort with natural/version ordering to match iMovie's internal clip order.
        const files = fs.readdirSync(eventPath)
            .filter(f => {
                if (f.startsWith('.') || f === 'iMovie Data') return false;
                if (fs.statSync(path.join(eventPath, f)).isDirectory()) return false;
                return !SKIP_EXTS.has(path.extname(f).toLowerCase());
            })
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

        // Derive event year from first plist timestamp → folder name prefix → 'Unknown'
        let eventYear = null;
        if (timestamps.length > 0) {
            const exifDate = cocoaToExifDate(timestamps[0]); // "YYYY:MM:DD HH:MM:SS"
            eventYear = exifDate.slice(0, 4);
        }
        if (!eventYear) eventYear = yearFromFolderName(eventName);
        if (!eventYear) eventYear = 'Unknown';

        const displayName   = eventDisplayName(eventName);
        const virtualFolder = `${eventYear}/${displayName}`;

        files.forEach((filename, i) => {
            const relPath = path.join(eventName, filename);
            const type    = classifyType(relPath);

            // Date priority: per-clip plist timestamp → filename pattern → year/Jan 1
            let date = null;
            if (timestamps[i] !== undefined) {
                date = cocoaToExifDate(timestamps[i]); // "YYYY:MM:DD HH:MM:SS"
            }
            if (!date) date = dateFromFilename(filename);
            if (!date && eventYear !== 'Unknown') date = `${eventYear}:01:01 00:00:00`;
            if (!date) date = fs.statSync(path.join(eventPath, filename)).mtime.toISOString();

            allEntries.push({ name: filename, relPath, date, category: eventYear, folder: virtualFolder, type, tags: eventTags });
        });
    }

    // Phase 1: Bulk insert all entries
    await new Promise((res, rej) => {
        db.serialize(() => {
            db.run('BEGIN');
            const stmt = db.prepare(
                'INSERT OR IGNORE INTO assets (name, rel_path, date, category, folder, type, tags) VALUES (?, ?, ?, ?, ?, ?, ?)'
            );
            for (const e of allEntries) {
                stmt.run(e.name, e.relPath, e.date, e.category, e.folder, e.type, e.tags || null);
            }
            stmt.finalize();
            db.run('COMMIT', err => err ? rej(err) : res());
        });
    });

    progressCallback({ phase: 'structure', status: 'complete', total: allEntries.length });

    // Phase 1 plist timestamps are authoritative for iMovie Events —
    // exiftool CreateDate reflects digitisation/import, not original recording.
    // Pass updateDates:false so GPS + duration are enriched but dates stay as-is.
    await runMetadataPhases(db, sourceDir, allEntries.map(e => e.relPath), progressCallback, { updateDates: false });

    db.close();
}

module.exports = { generate, detect };
