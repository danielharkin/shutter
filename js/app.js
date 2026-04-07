import { state, updateSelected } from './state.js';
import { initGrid, applyFilters } from './grid.js';
import { initMap } from './map.js';
import { initSidebar } from './sidebar.js';

// ── Library card helpers ────────────────────────────────────────────────────

const PHASES = [
    { key: 'structure', dotId: 'tl-structure', rowId: 'prow-structure', statId: 'pstat-structure', label: 'File Structure' },
    { key: 'metadata',  dotId: 'tl-metadata',  rowId: 'prow-metadata',  statId: 'pstat-metadata',  label: 'Location & Dates' },
    { key: 'live',      dotId: 'tl-live',       rowId: 'prow-live',      statId: 'pstat-live',      label: 'Live Photos' },
    { key: 'types',     dotId: 'tl-types',      rowId: 'prow-types',     statId: 'pstat-types',     label: 'Types' },
];

const PHASE_KEY_MAP = { structure: 0, metadata: 1, live_photos: 2, types: 3 };

function setPhaseState(idx, phaseState) {
    const p = PHASES[idx];
    const dot = document.getElementById(p.dotId);
    if (dot) { dot.className = `tl-dot ${phaseState}`; }
    const row = document.getElementById(p.rowId);
    if (row) {
        row.className = `phase-row ${phaseState}`;
        const stat = document.getElementById(p.statId);
        if (stat) {
            stat.textContent = phaseState === 'done' ? '✓ Done'
                             : phaseState === 'active' ? 'Indexing…'
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
    PHASES.forEach((_, i) => setPhaseState(i, 'pending'));
}

async function populateLibraryDropdown() {
    const dropdown = document.getElementById('library-dropdown');
    dropdown.innerHTML = '';
    const history = await window.api.getLibraryHistory();
    if (!history || history.length === 0) {
        dropdown.innerHTML = '<div class="library-dropdown-empty">No recent libraries</div>';
        return;
    }
    history.forEach(libPath => {
        const name = libPath.split('/').pop().replace('.photoslib', '');
        const item = document.createElement('div');
        item.className = 'library-dropdown-item';
        item.textContent = name;
        item.title = libPath;
        item.addEventListener('click', async () => {
            dropdown.style.display = 'none';
            const success = await window.api.loadLibrary(libPath);
            if (success) {
                showLibraryCard(name);
                PHASES.forEach((_, i) => setPhaseState(i, 'done'));
                await initApp();
            }
        });
        dropdown.appendChild(item);
    });
}

document.getElementById('library-card-name').addEventListener('click', async () => {
    const dropdown = document.getElementById('library-dropdown');
    const isVisible = dropdown.style.display !== 'none';
    if (!isVisible) {
        await populateLibraryDropdown();
        dropdown.style.display = 'block';
    } else {
        dropdown.style.display = 'none';
    }
});

document.getElementById('library-traffic-lights').addEventListener('click', () => {
    const detail = document.getElementById('library-phase-detail');
    detail.style.display = detail.style.display === 'none' ? 'block' : 'none';
});

document.getElementById('btn-rebuild-library').addEventListener('click', async () => {
    document.getElementById('library-phase-detail');
    PHASES.forEach((_, i) => setPhaseState(i, 'pending'));
    await window.api.rebuildLibrary();
});

// ── Folder tree ─────────────────────────────────────────────────────────────

function buildTree(rows) {
    // rows = [{folder: "2023/January", count: 20}, ...]
    // Events only have leaf-level rows — year nodes ("2023") may not exist in the DB.
    // We synthesise virtual parent nodes for every missing ancestor.
    const nodes = {};

    const ensure = (folderPath) => {
        if (nodes[folderPath]) return;
        nodes[folderPath] = {
            name: folderPath.split('/').pop(),
            path: folderPath,
            count: 0,
            totalCount: 0,
            children: [],
        };
    };

    for (const { folder, count } of rows) {
        if (!folder) continue;
        ensure(folder);
        nodes[folder].count = count;
        nodes[folder].totalCount = count;

        // Ensure every ancestor path exists as a virtual node
        const parts = folder.split('/');
        for (let i = 1; i < parts.length; i++) {
            ensure(parts.slice(0, i).join('/'));
        }
    }

    const roots = [];
    for (const folder of Object.keys(nodes).sort()) {
        const parts = folder.split('/');
        if (parts.length === 1) {
            roots.push(nodes[folder]);
        } else {
            const parentPath = parts.slice(0, -1).join('/');
            nodes[parentPath].children.push(nodes[folder]);
        }
    }

    function computeTotal(node) {
        for (const child of node.children) {
            computeTotal(child);
            node.totalCount += child.totalCount;
        }
        node.children.sort((a, b) => a.name.localeCompare(b.name));
    }
    roots.forEach(computeTotal);
    roots.sort((a, b) => a.name.localeCompare(b.name));

    return roots;
}

function renderTreeNode(node, depth = 0) {
    const li = document.createElement('li');
    li.className = 'tree-node';

    const row = document.createElement('div');
    row.className = 'tree-row';
    row.style.paddingLeft = `${depth * 14 + 14}px`;

    // Disclosure triangle or spacer
    const toggle = document.createElement('span');
    toggle.className = node.children.length ? 'tree-toggle' : 'tree-spacer';
    toggle.textContent = node.children.length ? '▶' : '';
    row.appendChild(toggle);

    const label = document.createElement('span');
    label.className = 'tree-label';
    label.textContent = node.name;
    row.appendChild(label);

    const countEl = document.createElement('span');
    countEl.className = 'tree-count';
    countEl.textContent = node.totalCount.toLocaleString();
    row.appendChild(countEl);

    li.appendChild(row);

    // Children list (hidden by default)
    let childList = null;
    if (node.children.length) {
        childList = document.createElement('ul');
        childList.className = 'tree-children';
        childList.style.display = 'none';
        for (const child of node.children) {
            childList.appendChild(renderTreeNode(child, depth + 1));
        }
        li.appendChild(childList);

        toggle.addEventListener('click', (e) => {
            e.stopPropagation();
            const expanded = childList.style.display !== 'none';
            childList.style.display = expanded ? 'none' : 'block';
            toggle.textContent = expanded ? '▶' : '▼';
        });
    }

    row.addEventListener('click', async () => {
        clearActiveSelection();
        row.classList.add('active');
        state.currentFolder = node.path;
        state.rawAssets = await window.api.getAssets(node.path);
        applyFilters();
    });

    return li;
}

function initViewAll() {
    const btn = document.getElementById('btn-view-all');
    btn.addEventListener('click', async () => {
        document.querySelectorAll('.tree-row.active, .nav-item.active').forEach(el => el.classList.remove('active'));
        btn.classList.add('active');
        state.currentFolder = 'all';
        state.rawAssets = await window.api.getAssets('all');
        applyFilters();
    });
}

function clearActiveSelection() {
    document.querySelectorAll('.tree-row.active, .nav-item.active').forEach(el => el.classList.remove('active'));
}

async function buildFolderList() {
    const list = document.getElementById('folder-list');
    list.innerHTML = '';

    const rows = await window.api.getFolderTree();
    if (!rows || rows.length === 0) return;

    const treeRoots = buildTree(rows);
    const ul = document.createElement('ul');
    ul.className = 'tree-root';
    for (const node of treeRoots) {
        ul.appendChild(renderTreeNode(node, 0));
    }
    list.appendChild(ul);
}

// ── App init ────────────────────────────────────────────────────────────────

async function initApp() {
    window.state = state;

    if (!window.gridInitialized) {
        initGrid();
        initMap();
        initSidebar();
        initViewAll();
        window.gridInitialized = true;
    }

    const rows = await window.api.getYears();
    if (!rows || rows.length === 0) {
        console.log("No library data. Waiting for .photoslib drop.");
        return;
    }

    // Show library card for already-indexed library
    const history = await window.api.getLibraryHistory?.() || [];
    if (history.length > 0) {
        const name = history[0].split('/').pop().replace('.photoslib', '');
        showLibraryCard(name);
        PHASES.forEach((_, i) => setPhaseState(i, 'done'));
    }

    await buildFolderList();

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

    if (libraryName) showLibraryCard(libraryName);

    const idx = PHASE_KEY_MAP[phase];
    if (idx === undefined) return;

    if (status === 'progress') {
        const pct = total ? Math.round((current / total) * 100) : 0;
        setPhaseProgress(idx, pct);
    } else if (status === 'complete') {
        setPhaseState(idx, 'done');
    }

    // Structure done → load the grid immediately, mark remaining as active
    if (phase === 'structure' && status === 'complete') {
        initApp();
        setPhaseState(1, 'active');
    }

    // All generation done → rebuild folder tree with final regrouped values
    if (phase === 'complete' && status === 'complete') {
        initApp();
    }
});

// ── Boot ────────────────────────────────────────────────────────────────────

initApp();
