import { state, updateSelected } from './state.js';

let mainMap, miniMap, mainMarkers = {};

export function initMap() {
    window.addEventListener('assetSelected', (e) => syncMiniMap(e.detail));
    window.addEventListener('renderGlobalMap', () => renderGlobalMap());
    
    // Manual Move Listener
    window.addEventListener('mapMove', (e) => {
        if (miniMap) {
            const { lat, lng } = e.detail;
            if (lat && lng) {
                miniMap.setView([lat, lng], 15);
                miniMap.eachLayer(l => { if(l instanceof L.Marker) miniMap.removeLayer(l); });
                L.marker([lat, lng]).addTo(miniMap);
                document.getElementById('mini-map').classList.remove('unknown');
                miniMap.invalidateSize();
            }
        }
    });

    // Sidebar Sat Toggle
    document.getElementById('btn-mini-sat').onclick = () => {
        if (miniMap) {
            const isSat = miniMap.options.isSatellite;
            miniMap.eachLayer(layer => { if (layer instanceof L.TileLayer) miniMap.removeLayer(layer); });
            const url = isSat ? 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png' : 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
            L.tileLayer(url).addTo(miniMap);
            miniMap.options.isSatellite = !isSat;
            document.getElementById('btn-mini-sat').style.background = !isSat ? "var(--accent)" : "rgba(0,0,0,0.8)";
        }
    };

    // Split Map Sat Toggle (FIXED)
    document.getElementById('btn-main-sat').onclick = () => {
        if (mainMap) {
            const isSat = mainMap.options.isSatellite;
            mainMap.eachLayer(layer => { if (layer instanceof L.TileLayer) mainMap.removeLayer(layer); });
            const url = isSat ? 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png' : 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
            L.tileLayer(url).addTo(mainMap);
            mainMap.options.isSatellite = !isSat;
            document.getElementById('btn-main-sat').style.background = !isSat ? "var(--accent)" : "rgba(0,0,0,0.8)";
        }
    };

    document.getElementById('btn-drag-loc').onclick = toggleDragMode;
}

function syncMiniMap(a) {
    const mapEl = document.getElementById('mini-map');
    
    if(!miniMap) {
        miniMap = L.map('mini-map', {zoomControl: false, attributionControl: false}).setView([0,0], 2);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(miniMap);
        
        // Uber-Drag Logic: Update Lat/Lng inputs as you move map
        miniMap.on('move', () => {
            if(state.isDragMode) {
                const c = miniMap.getCenter();
                document.getElementById('ed-lat').value = c.lat.toFixed(6);
                document.getElementById('ed-lng').value = c.lng.toFixed(6);
            }
        });
    }
    
    // Clear existing markers
    miniMap.eachLayer(l => { if(l instanceof L.Marker) miniMap.removeLayer(l); });
    
    if(a.lat) {
        // Location Found
        mapEl.classList.remove('unknown');
        miniMap.setView([a.lat, a.lng], 15);
        if(!state.isDragMode) L.marker([a.lat, a.lng]).addTo(miniMap);
    } else {
        // No Location
        mapEl.classList.add('unknown');
        miniMap.setView([20,0], 1);
    }
    
    miniMap.invalidateSize();

// Split Map Sync (Reset and Highlight Pin)
    if (state.isSplit && mainMap) {
        // Step 1: Always reset all markers to default style first
        Object.values(mainMarkers).forEach(m => {
            m.setStyle({ 
                radius: 5, 
                color: 'var(--accent)', 
                weight: 1, 
                fillOpacity: 0.5 
            });
        });

        // Step 2: Only highlight if the NEWLY selected asset has a location
        if (a.lat && mainMarkers[a.id]) {
            mainMarkers[a.id].setStyle({ 
                radius: 12, 
                color: 'var(--accent)', 
                weight: 4, 
                fillOpacity: 1 
            }).bringToFront();
        }
    }
}

function toggleDragMode() {
    state.isDragMode = !state.isDragMode;
    const btn = document.getElementById('btn-drag-loc');
    const crosshair = document.getElementById('map-crosshair');
    btn.innerText = state.isDragMode ? "LOCK" : "DRAG";
    btn.style.background = state.isDragMode ? "var(--accent)" : "rgba(0,0,0,0.8)";
    crosshair.style.display = state.isDragMode ? "block" : "none";
}

function renderGlobalMap() {
    if(!mainMap) {
        mainMap = L.map('split-map').setView([0,0], 2);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(mainMap);
    }
    Object.values(mainMarkers).forEach(m => mainMap.removeLayer(m));
    mainMarkers = {};
    const group = L.featureGroup();
    state.filteredAssets.forEach((a) => {
        if(a.lat) {
            const m = L.circleMarker([a.lat, a.lng], { radius: 5, color: 'var(--accent)', fillOpacity: 0.5, weight: 1 });
          m.on('click', () => {
    // 1. Centralized update for state and sidebar
    updateSelected(a); 

    // 2. Locate the Month Container
    const { months, parseAssetDate } = a.date ? (async () => {
        // We need these from utils, but they are already imported in grid.js
    }) : {}; 
    
    // Construct the ID used in buildSkeleton
    const dt = {
        y: a.date.split(/\D+/)[0],
        m: ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"][parseInt(a.date.split(/\D+/)[1]) - 1]
    };
    const monthId = `label-${dt.m}-${dt.y}`;
    const monthCont = document.getElementById(monthId);

    if (monthCont) {
        // 3. Force Hydration if the month hasn't been rendered yet
        if (!monthCont.dataset.hydrated) {
            // Access the exported hydrateMonth from grid.js
            // Note: You may need to add 'export' to hydrateMonth in grid.js if not already there
            window.dispatchEvent(new CustomEvent('forceHydrate', { detail: monthCont }));
        }

        // 4. Scroll and Highlight
        setTimeout(() => {
            const itemEl = document.getElementById(`grid-item-${a.id}`);
            if (itemEl) {
                itemEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                document.querySelectorAll('.item').forEach(el => el.classList.remove('selected'));
                itemEl.classList.add('selected');
            }
        }, 50); // Small timeout to allow DOM to catch up after hydration
    }
});
            m.addTo(group);
            mainMarkers[a.id] = m;
        }
    });
    group.addTo(mainMap);
    if(group.getBounds().isValid()) mainMap.fitBounds(group.getBounds());
}