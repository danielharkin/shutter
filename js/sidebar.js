import { state } from './state.js';
import { parseAssetDate, vidExts } from './utils.js';

let searchTimer;

export function initSidebar() {
    window.addEventListener('assetSelected', (e) => hydrateSidebar(e.detail));
    
    // Listen for manual Lat/Lng typing
    ['ed-lat', 'ed-lng'].forEach(id => {
        document.getElementById(id).oninput = () => {
            const lat = document.getElementById('ed-lat').value;
            const lng = document.getElementById('ed-lng').value;
            if (lat && lng) {
                window.dispatchEvent(new CustomEvent('mapMove', { detail: { lat, lng } }));
            }
        };
    });

    document.getElementById('loc-search').oninput = (e) => handleSearch(e.target.value);
}

async function hydrateSidebar(a) {
    document.getElementById('info-ui').style.display = 'block';
    document.getElementById('info-filename').innerText = a.name;
    document.getElementById('info-filename').onclick = () => window.api.revealInFinder(a.path);

    // 1. Generate Media URL - Updated to use patched vid_path for Live Photos
    const isHeic = a.path.toLowerCase().endsWith('.heic') || a.path.toLowerCase().endsWith('.heif');
    const isVid = vidExts.some(ext => (a.name || "").toLowerCase().endsWith(ext)) || a.is_live === 1;
    
    // Use vid_path if it's a Live Photo, otherwise standard path
    const activePath = a.is_live === 1 ? a.vid_path : a.path;

// Check if the file we are actually pointing to is a video
    const isActuallyVid = activePath.toLowerCase().endsWith('.mov') || activePath.toLowerCase().endsWith('.mp4');

    const mediaUrl = (isHeic && !isActuallyVid)
        ? `http://127.0.0.1:3999/thumb/${encodeURIComponent(activePath)}` 
        : `http://127.0.0.1:3999/media/${encodeURIComponent(activePath)}`;

    const mediaCont = document.getElementById('media-cont');
    if (isVid) {
        const video = document.createElement('video');
        video.src = mediaUrl;
        video.controls = true;
        video.autoplay = true;
        video.muted = true;
        video.loop = true;
        video.className = 'media-fit';
        mediaCont.innerHTML = '';
        mediaCont.appendChild(video);

        function showOpenInApp() {
            mediaCont.innerHTML = '';
            const w = document.createElement('div');
            w.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:12px;padding:20px';
            w.innerHTML = `<div style="font-size:40px">🎬</div>
                <div style="font-size:10px;color:#555;text-align:center;text-transform:uppercase;letter-spacing:1px">Unsupported codec</div>`;
            const btn = document.createElement('button');
            btn.textContent = 'Open in Default App';
            btn.style.cssText = 'background:var(--accent);border:none;color:white;padding:8px 16px;border-radius:6px;font-size:10px;font-weight:900;cursor:pointer;text-transform:uppercase';
            btn.onclick = () => window.api.openFile(activePath);
            w.appendChild(btn);
            mediaCont.appendChild(w);
        }

        function tryVlcFallback() {
            mediaCont.innerHTML = '';
            const wrap = document.createElement('div');
            wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:12px;padding:20px';
            wrap.innerHTML = `<div style="font-size:28px">⏳</div>
                <div style="font-size:10px;color:#555;text-align:center;text-transform:uppercase;letter-spacing:1px">Starting VLC stream…</div>`;
            mediaCont.appendChild(wrap);

            window.api.vlcStream(activePath).then(result => {
                if (!result.success) { showOpenInApp(); return; }
                const v2 = document.createElement('video');
                v2.src = result.url;
                v2.controls = true;
                v2.autoplay = true;
                v2.muted = true;
                v2.loop = true;
                v2.className = 'media-fit';
                v2.addEventListener('canplay', () => {
                    mediaCont.innerHTML = '';
                    mediaCont.appendChild(v2);
                });
                v2.addEventListener('error', showOpenInApp);
                v2.load();
            });
        }

        // Hard error (file missing, etc.)
        video.addEventListener('error', tryVlcFallback);

        // No video track: Chromium plays audio-only without erroring.
        // Detect by checking videoWidth after metadata loads.
        video.addEventListener('loadedmetadata', () => {
            if (video.videoWidth === 0) tryVlcFallback();
        });
    } else {
        mediaCont.innerHTML = `<img src="${mediaUrl}" class="media-fit">`;
    }

    // 2. Metadata - Trusting the patched 'a.date' directly
    const dt = parseAssetDate(a.date);

    ['d-dd','d-mm','d-yyyy','d-hh','d-min','d-ss'].forEach((id, i) => {
        const val = [dt.d, dt.m, dt.y, dt.hh, dt.mm, dt.ss][i];
        document.getElementById(id).value = val;
    });

    // 3. GPS - Trusting the patched 'a.lat/a.lng' directly
    document.getElementById('ed-lat').value = a.lat || '';
    document.getElementById('ed-lng').value = a.lng || '';

    if (a.lat && a.lng) {
        window.dispatchEvent(new CustomEvent('mapMove', { detail: { lat: a.lat, lng: a.lng } }));
    }

    // 4. Metadata accordions
    populateAccordions(a);
}

// Which metadata namespaces each format supports
function formatCapabilities(ext) {
    const e = ext.replace('.', '').toLowerCase();
    const imageExts = ['jpg','jpeg','heic','heif','tiff','tif','png','dng','raw','arw','cr2','nef','orf'];
    const videoExts = ['mov','mp4','m4v','avi','mkv','hevc','dv','3gp','wmv'];
    return {
        exif:       imageExts.includes(e),
        iptc:       ['jpg','jpeg','tiff','tif','psd'].includes(e),
        quicktime:  videoExts.includes(e),
        xmp:        true, // most formats support XMP embedded or as sidecar
    };
}

function makeRow(k, v) {
    return `<div class="acc-row"><span>${k}</span><span>${String(v)}</span></div>`;
}

function unsupported(ext) {
    return `<div style="padding:8px 10px;font-size:10px;color:#444;font-style:italic">Not supported with .${ext} files</div>`;
}

async function populateAccordions(a) {
    const ext = a.path.split('.').pop();
    const caps = formatCapabilities(ext);

    const buckets = { exif: '', iptc: '', quicktime: '', xmp: '', keywords: '', file: '' };

    // Shutter-sourced keywords (iMovie tags or future sources)
    if (a.tags) {
        buckets.keywords += a.tags.split(',').map(t =>
            `<div class="acc-row"><span>Tag</span><span>${t.trim()}</span></div>`
        ).join('');
    }

    const exif = await window.api.getFullExif(a.path);
    if (!exif.error) {
        Object.entries(exif).forEach(([k, v]) => {
            if (v === null || v === undefined || typeof v === 'object') return;
            const row = makeRow(k, v);
            const key = k.toLowerCase();
            if (key.startsWith('iptc') || key.includes(':iptc') || key.includes('caption') || key.includes('headline') || key.includes('credit')) {
                buckets.iptc += row;
            } else if (key.startsWith('quicktime') || key.startsWith('track') || key.startsWith('video:') || key.includes(':video')) {
                buckets.quicktime += row;
            } else if (key.startsWith('xmp') || key.includes(':xmp') || key.includes('xmp-')) {
                buckets.xmp += row;
            } else if (key.startsWith('file:') || key.startsWith('system:') || key.includes('filesize') || key.includes('directory') || key.includes('filename')) {
                buckets.file += row;
            } else if (key.startsWith('exif') || key.includes(':exif') || key.includes('make') || key.includes('model') || key.includes('focal') || key.includes('aperture') || key.includes('iso') || key.includes('shutter') || key.includes('flash') || key.includes('lens') || key.includes('exposure')) {
                buckets.exif += row;
            } else if (key.includes('keyword') || key.includes('subject') || key.includes('tag') || key.includes('label')) {
                buckets.keywords += row;
            } else {
                buckets.exif += row; // default to EXIF for unclassified image metadata
            }
        });
    }

    // Populate each accordion — always show, with "not supported" when appropriate
    const fill = (id, content, supported) => {
        document.getElementById(id).innerHTML = content || (supported ? '<div style="padding:8px 10px;font-size:10px;color:#444;font-style:italic">None found</div>' : unsupported(ext));
    };

    fill('data-exif',      buckets.exif,      caps.exif);
    fill('data-iptc',      buckets.iptc,      caps.iptc);
    fill('data-quicktime', buckets.quicktime, caps.quicktime);
    fill('data-xmp',       buckets.xmp,       caps.xmp);
    fill('data-keywords',  buckets.keywords,  true);
    fill('data-file',      buckets.file,      true);
}

function handleSearch(v) {
    const suggest = document.getElementById('search-suggest');
    if(v.length < 2) { suggest.style.display = 'none'; return; }
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
        fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(v)}&limit=15`)
        .then(r => r.json()).then(d => {
            suggest.innerHTML = '';
            if(d.length > 0) {
                suggest.style.display = 'block';
                d.forEach(i => {
                    const div = document.createElement('div');
                    div.className = 'suggest-item';
                    div.innerText = i.display_name;
                    div.onclick = () => {
                        document.getElementById('ed-lat').value = i.lat;
                        document.getElementById('ed-lng').value = i.lon;
                        suggest.style.display = 'none';
                        window.dispatchEvent(new CustomEvent('mapMove', { detail: { lat: i.lat, lng: i.lon } }));
                    };
                    suggest.appendChild(div);
                });
            }
        });
    }, 300);
}