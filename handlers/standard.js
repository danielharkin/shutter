// Handler for standard photo folder trees (arbitrary depth)

const path = require('path');
const fs = require('fs');
const { SKIP_EXTS, classifyType, createSchema, runMetadataPhases, openDatabase } = require('./shared');

function getFilesRecursively(dir, baseDir, fileList = []) {
    for (const file of fs.readdirSync(dir)) {
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

async function generate(sourceDir, outputLibPath, progressCallback) {
    const db = openDatabase(outputLibPath, sourceDir);
    await createSchema(db, sourceDir);

    const allFiles = getFilesRecursively(sourceDir, sourceDir);

    // Phase 1: Scan filesystem, classify, insert all rows
    await new Promise((res, rej) => {
        db.serialize(() => {
            db.run('BEGIN');
            const stmt = db.prepare(
                'INSERT OR IGNORE INTO assets (name, rel_path, date, category, folder, type) VALUES (?, ?, ?, ?, ?, ?)'
            );
            for (const relPath of allFiles) {
                const stats    = fs.statSync(path.join(sourceDir, relPath));
                const category = relPath.includes(path.sep) ? relPath.split(path.sep)[0] : 'Unsorted';
                const dirPart  = path.dirname(relPath);
                const folder   = dirPart === '.' ? category : dirPart;
                const type     = classifyType(relPath);
                stmt.run(path.basename(relPath), relPath, stats.mtime.toISOString(), category, folder, type);
            }
            stmt.finalize();
            db.run('COMMIT', err => err ? rej(err) : res());
        });
    });

    progressCallback({ phase: 'structure', status: 'complete', total: allFiles.length });

    await runMetadataPhases(db, sourceDir, allFiles, progressCallback);

    db.close();
}

module.exports = { generate };
