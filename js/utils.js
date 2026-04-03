export const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
export const vidExts = ['.mov', '.mp4', '.m4v', '.hevc', '.avi', '.mkv', '.webm'];

export function parseAssetDate(dString) {
    const p = (dString || "0000:01:01 00:00:00").split(/\D+/);
    return {
        y: p[0]||"0000", m: p[1]||"01", d: p[2]||"01",
        hh: p[3]||"00", mm: p[4]||"00", ss: p[5]||"00"
    };
}

// duration is stored as raw seconds (REAL) in the DB
export function formatDuration(seconds) {
    if (!seconds) return '0:00';
    const s = Math.round(seconds);
    return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
}

export function getBadge(asset) {
    // 1. Semantic type labels
    if (asset.type === 'screenshot') return 'SCREENSHOT';
    if (asset.type === 'selfie')     return 'SELFIE';

    // 2. Live Photos
    if (asset.is_live === 1)  return '○ LIVE';
    if (asset.is_live === -1) return 'CLIP';

    // 3. Videos & Shorts (duration is raw seconds)
    if (asset.type === 'video') {
        const dur = formatDuration(asset.duration);
        if (asset.duration > 0 && asset.duration < 5) return `<short> (${dur})`;
        return `▶ ${dur}`;
    }

    return null;
}
