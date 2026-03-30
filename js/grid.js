import { state, updateSelected } from './state.js';
import { parseAssetDate, getBadge, months } from './utils.js';

const obs = new IntersectionObserver((entries) => {
    entries.forEach(e => {
        if(e.isIntersecting && e.target.dataset.path) {
            e.target.src = `http://127.0.0.1:3999/thumb/${e.target.dataset.path}`;
            e.target.onload = () => e.target.classList.add('loaded');
        }
        if(e.isIntersecting && e.target.classList.contains('month-container') && !e.target.dataset.hydrated) {
            hydrateMonth(e.target);
        }
    });
}, { rootMargin: '1500px' });

export function initGrid() {
    window.addEventListener('assetSelected', (e) => {
        document.querySelectorAll('.item').forEach(el => el.classList.remove('selected'));
        const itemEl = document.getElementById(`grid-item-${e.detail.id}`);
        if(itemEl) itemEl.classList.add('selected');
    });

    // Gallery Keyboard Nav
    window.addEventListener('keydown', (e) => {
        if (document.getElementById('lightbox').style.display === 'flex') {
            if (e.key === 'ArrowRight') navGallery(1);
            if (e.key === 'ArrowLeft') navGallery(-1);
            if (e.key === 'Escape') closeLightbox();
        }
    });

    document.querySelector('.nav-arrow.prev').onclick = () => navGallery(-1);
    document.querySelector('.nav-arrow.next').onclick = () => navGallery(1);
    document.getElementById('lightbox-close').onclick = closeLightbox;

    window.addEventListener('forceHydrate', (e) => {
        hydrateMonth(e.detail);
    });
}

export function applyFilters() {
    const { rawAssets, filters } = state;

    state.filteredAssets = rawAssets.filter(a => {
        // Exit early if there is nothing to filter
    if (!rawAssets || rawAssets.length === 0) {
        document.getElementById('grid').innerHTML = '<div style="padding: 40px; color: #555; text-align: center; font-weight: 900;">DRAG A .PHOTOSLIB FOLDER HERE TO START</div>';
        return;
    }
    
        // 1. Direct Category Mapping
        if (a.category === 'screenshot') return filters.screenshot;
        if (a.category === 'selfie') return filters.selfie;

        // 2. Live Photos
        if (a.is_live === 1 || a.is_live === -1) return filters.live;

        // 3. Videos & Shorts
        if (a.category === 'video') {
            let seconds = 0;
            if (a.duration) {
                const parts = a.duration.split(':').map(Number);
                seconds = parts.length === 3 
                    ? (parts[0] * 3600) + (parts[1] * 60) + parts[2] 
                    : (parts[0] * 60) + parts[1];
            }
            if (seconds > 0 && seconds < 5) return filters.shorts;
            return filters.video;
        }

        // 4. Standard Photos
        return filters.image;
    });

    buildSkeleton();
    buildScrubber();
    if(state.isSplit) window.dispatchEvent(new CustomEvent('renderGlobalMap'));
}

function buildSkeleton() {
    const grid = document.getElementById('grid');
    grid.innerHTML = '';
    const groups = {};
    state.filteredAssets.forEach(a => {
        const dt = parseAssetDate(a.date);
        const label = `${months[parseInt(dt.m)-1] || 'JAN'} ${dt.y}`;
        if (!groups[label]) groups[label] = [];
        groups[label].push(a);
    });

    Object.entries(groups).forEach(([label, items]) => {
        const container = document.createElement('div');
        container.className = 'month-container';
        container.id = `label-${label.replace(' ', '-')}`;
        container.style.minHeight = `${Math.ceil(items.length / 5) * 200 + 80}px`;
        container.dataset.items = JSON.stringify(items);
        container.dataset.label = label;
        grid.appendChild(container);
        obs.observe(container);
    });
}

export function hydrateMonth(container) { 
    container.dataset.hydrated = "true";
    const items = JSON.parse(container.dataset.items);
    container.innerHTML = `<div class="month-break">${container.dataset.label}</div><div class="photo-tiler"></div>`;
    const tiler = container.querySelector('.photo-tiler');
    
    items.forEach(a => {
        const div = document.createElement('div');
        div.className = 'item';
        div.id = `grid-item-${a.id}`;
        const badge = getBadge(a);
        
        const gpsDot = (a.lat && a.lat !== 0) ? 'var(--green)' : 'var(--red)';
        const dateDot = (a.date && !a.date.startsWith('0000')) ? 'var(--green)' : 'var(--amber)';
        
        div.innerHTML = `
            <div class="dots">
                <div class="dot" style="background:${gpsDot}"></div>
                <div class="dot" style="background:${dateDot}"></div>
            </div>
            ${badge ? `<div class="badge-label">${badge}</div>` : ''}
            <img data-path="${a.path}" class="lazy">
        `;
        div.onclick = () => updateSelected(a);
        div.ondblclick = () => openLightbox(a);
        tiler.appendChild(div);
        obs.observe(div.querySelector('.lazy'));
    });
}

export function openLightbox(a) {
    const lb = document.getElementById('lightbox');
    const target = document.getElementById('lightbox-target');
    const url = `http://127.0.0.1:3999/media/${encodeURIComponent(a.is_live === 1 ? a.vid_path : a.path)}`;
    
    target.innerHTML = (getBadge(a) || "").startsWith('▶') || a.is_live === 1 
        ? `<video src="${url}" controls autoplay loop></video>` 
        : `<img src="${url}">`;
    
    // Explicitly set flex to trigger the CSS override
    lb.style.setProperty('display', 'flex', 'important');
    updateLightboxArrows();
}

function closeLightbox() { 
    // Explicitly hide
    document.getElementById('lightbox').style.setProperty('display', 'none', 'important'); 
}


function navGallery(dir) {
    const idx = state.filteredAssets.findIndex(x => x.id === state.selectedAsset.id);
    const nextIdx = idx + dir;
    const next = state.filteredAssets[nextIdx];
    
    if(next) {
        updateSelected(next);
        openLightbox(next);
        const el = document.getElementById(`grid-item-${next.id}`);
        if(el) el.scrollIntoView({ block: 'center' });
    }
}

function buildScrubber() {
    const scrubber = document.getElementById('timeline-scrubber');
    scrubber.innerHTML = '';
    
    const years = [...new Set(state.filteredAssets.map(a => parseAssetDate(a.date).y))].sort((a,b) => b-a);
    const activeFolderBtn = document.querySelector('.nav-item.active span');
    const folderName = activeFolderBtn ? activeFolderBtn.innerText : '';

    years.forEach(year => {
        const yBtn = document.createElement('div');
        yBtn.className = 'scrub-year';
        yBtn.innerText = year;
        
        const mList = document.createElement('div');
        mList.className = 'month-list';

        if (years.length === 1 || folderName === year) {
            mList.classList.add('expanded');
            yBtn.classList.add('active');
        }

        yBtn.onclick = () => {
            const isExpanded = mList.classList.contains('expanded');
            document.querySelectorAll('.month-list').forEach(l => l.classList.remove('expanded'));
            document.querySelectorAll('.scrub-year').forEach(y => y.classList.remove('active'));
            
            if (!isExpanded) {
                mList.classList.add('expanded');
                yBtn.classList.add('active');
            }
        };

        const yrMs = [...new Set(state.filteredAssets.filter(a => parseAssetDate(a.date).y === year).map(a => parseInt(parseAssetDate(a.date).m)))].sort((a,b) => a-b);
        
        yrMs.forEach(mIdx => {
            if(!mIdx) return;
            const mBtn = document.createElement('div');
            mBtn.className = 'scrub-month';
            mBtn.innerText = months[mIdx-1];
            mBtn.onclick = (e) => {
                e.stopPropagation();
                const targetId = `label-${months[mIdx-1]}-${year}`;
                const targetEl = document.getElementById(targetId);
                if(targetEl) targetEl.scrollIntoView();
            };
            mList.appendChild(mBtn);
        });

        scrubber.appendChild(yBtn);
        scrubber.appendChild(mList);
    });
}

// Logic for greyed-out arrows
function updateLightboxArrows() {
    const idx = state.filteredAssets.findIndex(x => x.id === state.selectedAsset.id);
    const prevBtn = document.querySelector('.nav-arrow.prev');
    const nextBtn = document.querySelector('.nav-arrow.next');
    
    if (prevBtn && nextBtn) {
        prevBtn.disabled = (idx <= 0);
        nextBtn.disabled = (idx >= state.filteredAssets.length - 1);
    }
}