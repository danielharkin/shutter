const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    selectLibrary: () => ipcRenderer.invoke('select-library'), // ADD THIS
    // 1. Library Management (New for Portability)
    loadLibrary: (path) => ipcRenderer.invoke('load-library', path),

    // 2. Data Retrieval
    getYears: () => ipcRenderer.invoke('get-years'),
    getAssets: (yearValue) => ipcRenderer.invoke('get-assets', yearValue),
    getThumb: (path) => ipcRenderer.invoke('get-thumb', path),

    // 3. Metadata & System Integration (Milestone 1.0)
    getFullExif: (path) => ipcRenderer.invoke('get-full-exif', path),
    revealInFinder: (path) => ipcRenderer.invoke('reveal-in-finder', path),

    // 4. Database Operations
    updateAsset: (id, data) => ipcRenderer.invoke('update-asset', id, data)

    createLibrary: () => ipcRenderer.invoke('create-library'),
    onGenerationProgress: (callback) => ipcRenderer.on('library-generation-progress', (event, data) => callback(data))
});