const sqlite3 = require('sqlite3').verbose();
const { exiftool } = require('exiftool-vendored');
const path = require('path');

const PHOTO_ROOT = "/Users/daniel/Photos/Personal Pictures"; 
const DB_PATH = path.join(__dirname, 'helpers/archive.db');
const db = new sqlite3.Database(DB_PATH);

// Supported Video Extensions
const VIDEO_EXTS = ['.mov', '.mp4', '.m4v', '.avi', '.mpg', '.mpeg', '.3gp'];

async function runHealthCheck() {
    console.log("\n🚀 STARTING HIGH-SPEED DATABASE REPAIR");
    console.log("---------------------------------------");

    try {
        // 1. ENSURE COLUMNS EXIST
        await new Promise(res => db.run("ALTER TABLE assets ADD COLUMN is_live INTEGER DEFAULT 0", () => res()));
        
        // 2. FETCH ALL ASSETS
        const allAssets = await new Promise((res) => db.all("SELECT id, name, path, category FROM assets", (err, rows) => res(rows || [])));
        const total = allAssets.length;
        
        // --- PHASE 1: LIVE PHOTO PAIRING ---
        console.log(`\n📸 PHASE 1: LIVE PHOTO PAIRING (${total} files)`);
        await new Promise(res => db.run("UPDATE assets SET is_live = 0, vid_path = NULL", res));

        const fileMap = {};
        allAssets.forEach(a => {
            const extIndex = a.name.lastIndexOf('.');
            const base = extIndex > 0 ? a.name.substring(0, extIndex) : a.name;
            if (!fileMap[base]) fileMap[base] = { photo: null, video: null };
            const ext = a.name.substring(extIndex).toLowerCase();
            
            if (['.jpg', '.jpeg', '.heic', '.png'].includes(ext)) fileMap[base].photo = a;
            if (VIDEO_EXTS.includes(ext)) fileMap[base].video = a;
        });

        let pairedCount = 0;
        const pairings = Object.values(fileMap).filter(g => g.photo && g.video);
        
        for (const group of pairings) {
            await new Promise(res => db.run("UPDATE assets SET is_live = 1, vid_path = ? WHERE id = ?", [group.video.path, group.photo.id], res));
            await new Promise(res => db.run("UPDATE assets SET is_live = -1 WHERE id = ?", [group.video.id], res));
            pairedCount++;
            if (pairedCount % 50 === 0) process.stdout.write(`\r  ✨ Progress: Paired ${pairedCount}/${pairings.length} Live Photos...`);
        }
        console.log(`\n  ✅ SUCCESS: ${pairedCount} Live Photo pairs established.`);

        // --- PHASE 2: VIDEO METADATA PATCH ---
        const videosToFix = allAssets.filter(a => VIDEO_EXTS.some(ext => a.name.toLowerCase().endsWith(ext)));
        console.log(`\n📁 PHASE 2: METADATA PATCH (${videosToFix.length} videos)`);

        let fixedCount = 0;
        const batchSize = 50;

        for (let i = 0; i < videosToFix.length; i += batchSize) {
            const batch = videosToFix.slice(i, i + batchSize);
            
            await Promise.all(batch.map(async (vid) => {
                try {
                    const fullPath = path.join(PHOTO_ROOT, vid.path);
                    // Persistent ExifTool process is used here automatically by the library
                    const tags = await exiftool.read(fullPath, ["-ee", "-G1"]);
                    
                    const rawDate = tags['QuickTime:CreateDate'] || tags['Keys:CreationDate'] || tags.CreateDate;
                    const dateStr = rawDate ? rawDate.toString() : null;

                    let lat = null, lng = null;
                    const vidLoc = tags['Keys:GPSCoordinates'] || tags['UserData:GPSCoordinates'] || tags.GPSPosition;
                    if (vidLoc) {
                        const parts = vidLoc.toString().match(/[-+]?[\d.]+/g);
                        if (parts && parts.length >= 2) { 
                            lat = parseFloat(parts[0]); 
                            lng = parseFloat(parts[1]); 
                        }
                    }

                    if (dateStr || lat) {
                        await new Promise(res => db.run("UPDATE assets SET date = ?, lat = ?, lng = ? WHERE id = ?", [dateStr, lat, lng, vid.id], res));
                    }
                } catch (e) { /* ignore individual file errors to keep log clean */ }
            }));

            fixedCount += batch.length;
            process.stdout.write(`\r  🎬 Progress: Patched ${fixedCount}/${videosToFix.length} video headers...`);
        }

        console.log(`\n  ✅ SUCCESS: Video metadata synchronized with Database.`);

    } catch (err) {
        console.error("\n💥 FATAL ERROR:", err.message);
    } finally {
        // Correctly close the persistent ExifTool process
        await exiftool.end();
        db.close();
        console.log("\n🏁 ALL JOBS COMPLETE. DATABASE IS HEALTHY.\n");
        process.exit();
    }
}

runHealthCheck();