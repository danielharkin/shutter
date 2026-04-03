import { state, updateSelected } from './state.js';
import { initGrid, applyFilters } from './grid.js';
import { initMap } from './map.js';
import { initSidebar } from './sidebar.js';

// ── Library card helpers ────────────────────────────────────────────────────

// Phase config: id suffix, traffic-light dot id, label
const PHASES = [
    { key: 'structure', dotId: 'tl-structure', rowId: 'prow-structure', statId: 'pstat-structure', label: 'File Structure' },
    { key: 'metadata',  dotId: 'tl-metadata',  rowId: 'prow-metadata',  statId: 'pstat-metadata',  label: 'Location & Dates' },
    { key: 'live',      dotId: 'tl-live',       rowId: 'prow-live',      statId: 'pstat-live',      label: 'Live Photos' },
    { key: 'types',     dotId: 'tl-types',      rowId: 'prow-types',     statId: 'pstat-types',     label: 'Types' },
];

// Map generator phase names → PHASES index
const PHASE_KEY_MAP = { structure: 0, metadata: 1, live_photos: 2, types: 3 };

function setPhaseState(idx, state) {
    const p = PHASES[idx];
    // Traffic light dot
    const dot = document.getElementById(p.dotId);
    if (dot) { dot.className = `tl-dot ${state}`; }
    // Phase row
    const row = document.getElementById(p.rowId);
    if (row) {
        row.className = `phase-row ${state}`;
        const stat = document.getElementById(p.statId);
        if (stat) {
            stat.textContent = state === 'done' ? '✓ Done'
                             : state === 'active' ? 'Indexing…'
                             : '—';
        }
    }
}

function setPhaseProgress(idx, pct) {
    const p = PHASES[idx];
    const dot = document.getElementById(p.dotId);
    if (dot) dot.className = 'tl-dot active';
    const row = document.getElementById(p.rowId);
    if (row) {
        row.className = 'phase-row active';
        const stat = document.getElementById(p.statId);
        if (stat) stat.textContent = `${pct}%`;
    }
}

function showLibraryCard(name) {
    document.getElementById('library-empty').style.display = 'none';
    const card = document.getElementById('library-card');
    card.style.display = 'block';
    document.getElementById('library-card-name').textContent = name;
    // Reset all dots/rows to pending
    PHASES.forEach((_, i) => setPhaseState(i, 'pending'));
}

// Toggle phase detail on card click
document.getElementById('library-card-toggle').addEventListener('click', () => {
    const detail = document.getElementById('library-phase-detail');
    detail.style.display = detail.style.display === 'none' ? 'block' : 'none';
});

// ── App init ────────────────────────────────────────────────────────────────

async function initApp() {
    window.state = state;

    const rows = await window.api.getYears();
    const list = document.getElementById('folder-list');
    list.innerHTML = '';

    if (!window.gridInitialized) {
        initGrid();
        initMap();
        initSidebar();
        window.gridInitialized = true;
    }

    if (!rows || rows.length === 0) {
        console.log("No library data. Waiting for .photoslib drop.");
        return;
    }

    // Show the library card with the name from history (first entry = current)
    const history = await window.api.getLibraryHistory?.() || [];
    if (history.length > 0) {
        const name = history[0].split('/').pop().replace('.photoslib', '');
        showLibraryCard(name);
        // Mark all phases done for a library that's already fully indexed
        PHASES.forEach((_, i) => setPhaseState(i, 'done'));
    }

    const createBtn = (label, folder, count) => {
        const btn = document.createElement('button');
        btn.className = 'nav-item' + (folder === 'all' ? ' active' : '');
        btn.innerHTML = `<span>${label}</span><span>${count}</span>`;
        btn.onclick = async () => {
            document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            state.currentYear = folder;
            state.rawAssets = await window.api.getAssets(folder);
            applyFilters();
        };
        list.appendChild(btn);
    };

    createBtn('All Photos', 'all', '-');
    rows.forEach(r => createBtn(r.y, r.y, r.c.toLocaleString()));

    state.rawAssets = await window.api.getAssets('all');
    applyFilters();
}

// ── Button wiring ───────────────────────────────────────────────────────────

document.getElementById('btn-toggle-split').onclick = () => {
    state.isSplit = !state.isSplit;
    document.getElementById('split-map').style.display = state.isSplit ? 'block' : 'none';
    window.dispatchEvent(new CustomEvent('renderGlobalMap'));
};

document.querySelectorAll('#filter-bar .btn-pill').forEach(btn => {
    btn.onclick = () => {
        const type = btn.dataset.type;
        state.filters[type] = !state.filters[type];
        btn.classList.toggle('active', state.filters[type]);
        applyFilters();
    };
});

document.getElementById('btn-add-library').onclick = async () => {
    const result = await window.api.selectLibrary();
    if (result.success) {
        initApp();
    } else if (result.path) {
        alert("Selected folder is not a valid .photoslib (missing archive.db or path.txt)");
    }
};

document.getElementById('btn-create-library').onclick = async () => {
    await window.api.createLibrary();
};

// ── Drag and drop ───────────────────────────────────────────────────────────

window.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const dz = document.getElementById('dropzone');
    if (dz) dz.style.display = 'none';
    const file = e.dataTransfer.files[0];
    if (file && file.path.endsWith('.photoslib')) {
        const success = await window.api.loadLibrary(file.path);
        if (success) initApp();
        else alert("Backend failed to load library. Check archive.db and path.txt.");
    } else {
        alert("Please drop a folder ending in .photoslib");
    }
});

// ── Generation progress → phase card ───────────────────────────────────────

window.api.onGenerationProgress((data) => {
    const { phase, status, current, total, libraryName } = data;

    // First event: show the card
    if (libraryName) showLibraryCard(libraryName);

    const idx = PHASE_KEY_MAP[phase];
    if (idx === undefined) return;

    if (status === 'progress') {
        const pct = total ? Math.round((current / total) * 100) : 0;
        setPhaseProgress(idx, pct);
    } else if (status === 'complete') {
        setPhaseState(idx, 'done');
    }

    // Structure done → load the grid immediately
    if (phase === 'structure' && status === 'complete') {
        initApp();
        // Mark remaining phases as active so user can see work is ongoing
        setPhaseState(1, 'active');
    }
});

// ── Boot ────────────────────────────────────────────────────────────────────

initApp();
