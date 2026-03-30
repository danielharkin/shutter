export const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
export const vidExts = ['.mov', '.mp4', '.m4v', '.hevc', '.avi', '.mkv', '.webm'];

export function parseAssetDate(dString) {
    const p = (dString || "0000:01:01 00:00:00").split(/\D+/);
    return { 
        y: p[0]||"0000", m: p[1]||"01", d: p[2]||"01", 
        hh: p[3]||"00", mm: p[4]||"00", ss: p[5]||"00" 
    };
}

export function getBadge(asset) {
    // 1. Category-based Labels
    if (asset.category === 'screenshot') return 'SCREENSHOT';
    if (asset.category === 'selfie') return 'SELFIE';

    // 2. Live Photos
    if (asset.is_live === 1) return '○ LIVE';
    if (asset.is_live === -1) return 'CLIP';
    
    // 3. Videos & Shorts
    if (asset.category === 'video') {
        let seconds = 0;
        if (asset.duration) {
            const parts = asset.duration.split(':').map(Number);
            seconds = parts.length === 3 
                ? (parts[0] * 3600) + (parts[1] * 60) + parts[2] 
                : (parts[0] * 60) + parts[1];
        }
        if (seconds > 0 && seconds < 5) return `<short> (${asset.duration || '0:00'})`;
        return `▶ ${asset.duration || '0:00'}`;
    }

    return null;
}