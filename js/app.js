import { state, updateSelected } from './state.js';
import { initGrid, applyFilters } from './grid.js';
import { initMap } from './map.js';
import { initSidebar } from './sidebar.js';

async function initApp() {
    window.state = state; 

    const rows = await window.api.getYears();
    const list = document.getElementById('folder-list');
    
    // 1. Clear existing list to prevent duplicates on library switch
    list.innerHTML = ''; 

    // 2. Initial Setup for Grid and Map (Always run these once)
    // We move these up so the UI components are ready even if empty
    if (!window.gridInitialized) {
        initGrid();
        initMap();
        initSidebar();
        window.gridInitialized = true;
    }

    // 3. Early Exit if no database is connected
    if (!rows || rows.length === 0) {
        console.log("No library data. Waiting for .photoslib drop.");
        return; 
    }

    const createBtn = (label, year, count) => {
        const btn = document.createElement('button');
        btn.className = 'nav-item' + (year === 'all' ? ' active' : '');
        btn.innerHTML = `<span>${label}</span><span>${count}</span>`;
        btn.onclick = async () => {
            document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            state.currentYear = year;
            state.rawAssets = await window.api.getAssets(year);
            applyFilters();
        };
        list.appendChild(btn);
    };

    // 4. Populate UI now that data exists
    createBtn('All Photos', 'all', '-');
    rows.forEach(r => createBtn(r.y, r.y, r.c.toLocaleString()));

    state.rawAssets = await window.api.getAssets('all');
    applyFilters();
}



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
        console.log(`Toggled ${type} to ${state.filters[type]}`); // Diagnostic log
        applyFilters();
    };
});


initApp();


window.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation(); // Prevent browser from just opening the folder
    dz.style.display = 'none';
    
    // Electron provides the 'path' property on the file object
    const file = e.dataTransfer.files[0];
    if (file) {
        console.log("Attempting to load library at:", file.path); // LOG FOR DEBUGGING
        
        if (file.path.endsWith('.photoslib')) {
            const success = await window.api.loadLibrary(file.path);
            if (success) {
                console.log("Library loaded successfully. Reloading UI...");
                initApp(); // Re-run the initialization
            } else {
                alert("Backend failed to load library. Check archive.db and path.txt.");
            }
        } else {
            alert("Please drop a folder ending in .photoslib");
        }
    }
});


document.getElementById('btn-add-library').onclick = async () => {
    const result = await window.api.selectLibrary();
    if (result.success) {
        // Re-run the app initialization with the new data
        initApp(); 
    } else if (result.path) {
        alert("Selected folder is not a valid .photoslib (missing archive.db or path.txt)");
    }
};

// Listener for a new 'btn-create-library' (add this ID to your HTML)
document.getElementById('btn-create-library').onclick = async () => {
    const result = await window.api.createLibrary();
    if (result.success) {
        alert("Library Created and Loaded Successfully!");
        initApp();
    }
};

// Handle real-time progress updates
window.api.onGenerationProgress((data) => {
    const statusEl = document.getElementById('generation-status'); // Create this element in HTML
    if (statusEl) {
        const percent = Math.round((data.current / data.total) * 100);
        statusEl.innerText = `Generating Library: ${data.current} / ${data.total} (${percent}%)`;
    }
});

