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
    mediaCont.innerHTML = isVid 
        ? `<video src="${mediaUrl}" controls autoplay muted loop class="media-fit"></video>` 
        : `<img src="${mediaUrl}" class="media-fit">`;

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

    // 4. Background EXIF (Populate Accordions for deep inspection)
    window.api.getFullExif(a.path).then(exif => {
        const fullCont = document.getElementById('full-exif');
        const iptcCont = document.getElementById('iptc-data');
        const finderCont = document.getElementById('finder-data');
        
        fullCont.innerHTML = ''; iptcCont.innerHTML = ''; finderCont.innerHTML = '';

        Object.entries(exif).forEach(([k, v]) => {
            if (v !== null && typeof v !== 'object') {
                const row = `<div class="acc-row"><span>${k}</span><span>${v}</span></div>`;
                const key = k.toLowerCase();
                if (key.includes('iptc') || key.includes('caption') || key.includes('headline')) {
                    iptcCont.innerHTML += row;
                } else if (key.includes('file') || key.includes('size') || key.includes('directory')) {
                    finderCont.innerHTML += row;
                } else {
                    fullCont.innerHTML += row;
                }
            }
        });
    });
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