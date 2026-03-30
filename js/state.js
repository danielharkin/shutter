export const state = {
    rawAssets: [],
    filteredAssets: [],
    selectedAsset: null,
    currentYear: 'all',
    isSplit: false,
    isDragMode: false,
    // ALL keys must be here for applyFilters to return 'true'
    filters: { image: true, video: true, live: true, shorts: true, screenshot: true, selfie: true }
};
export function updateSelected(asset) {
    state.selectedAsset = asset;
    window.dispatchEvent(new CustomEvent('assetSelected', { detail: asset }));
}