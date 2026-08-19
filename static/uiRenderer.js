// static/uiRenderer.js

import { AppState } from './state.js';
import { 
    handleToggleTable, handleToggleEdit, handleToggleSplit, handleToggleCrop, 
    handleDuplicate, handleExport, handleExportFolder, handleRemove, 
    handleToggleVisibility, handleToggleSolo, handleZoomToLayer, 
    autoSaveWorkspace, rebuildActiveLayersFromDOM, triggerAddedSearch 
} from './app.js';

export const ensureSortableLoaded = () => {
    if (window.Sortable) return Promise.resolve();
    return new Promise((resolve) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/sortablejs@latest/Sortable.min.js';
        script.onload = resolve;
        document.head.appendChild(script);
    });
};

export const renderAddedLayers = () => {
    const addedLayerList = document.getElementById('added-layer-list');
    const tabBtnAdded = document.getElementById('tab-btn-added');
    const addedLayerSearch = document.getElementById('added-layer-search');

    if (!window.Sortable) {
        ensureSortableLoaded().then(() => renderAddedLayers());
        return;
    }

    if (tabBtnAdded) tabBtnAdded.textContent = `Added (${AppState.activeLayers.length})`;
    if (!addedLayerList) return;
    addedLayerList.innerHTML = '';

    if (AppState.activeLayers.length === 0) {
        addedLayerList.innerHTML = `<p class="text-xs text-gray-400 dark:text-gray-500 italic text-center mt-3">No layers currently added to map.</p>`;
        return;
    }

    const buildNodeHTML = (parentId) => {
        let html = '';
        const children = AppState.activeLayers.filter(l => l.parentId === parentId);
        
        children.forEach(node => {
            if (node.isFolder) {
                html += `
                <div class="folder-item mb-1 border border-gray-300 dark:border-gray-600 rounded bg-gray-100 dark:bg-gray-800 shadow-xs flex flex-col overflow-hidden" data-key="${node.uniqueKey}" data-search="${node.displayName.toLowerCase()}">
                    <div class="flex items-stretch border-b border-transparent dark:border-gray-700 folder-header">
                        
                        <!-- DRAG HANDLE -->
                        <div class="w-5 shrink-0 bg-gray-200/60 hover:bg-gray-300/80 dark:bg-gray-700/40 dark:hover:bg-gray-600/60 border-r border-gray-300/50 dark:border-gray-700/50 flex items-center justify-center cursor-grab drag-handle group" title="Drag to reorder folder">
                            <i class="fa-solid fa-grip-vertical text-gray-400/40 group-hover:text-gray-500 dark:text-gray-500/40 dark:group-hover:text-gray-400 text-[10px] transition-colors"></i>
                        </div>

                        <!-- CONTENT BLOCK -->
                        <div class="flex-1 flex flex-col p-1.5 min-w-0">
                            
                            <!-- TOP ROW: TITLE & ICONS -->
                            <div class="flex items-center overflow-hidden pr-1 pb-1.5 space-x-1.5 pl-0.5">
                                <button class="btn-toggle-folder text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300 shrink-0 flex justify-center transition-colors" data-key="${node.uniqueKey}" title="${node.isExpanded ? 'Collapse Folder' : 'Expand Folder'}">
                                    <i class="fa-solid ${node.isExpanded ? 'fa-folder-open' : 'fa-folder'} text-[12px] w-4 text-center"></i>
                                </button>
                                <span class="text-xs font-bold text-gray-700 dark:text-gray-200 truncate outline-none focus:bg-white dark:focus:bg-gray-600 focus:ring-1 focus:ring-blue-500 rounded px-1 layer-name-editable flex-1 cursor-text" data-key="${node.uniqueKey}" contenteditable="false" spellcheck="false" title="Double-click to rename">${node.displayName}</span>
                            </div>
                            
                            <!-- BOTTOM ROW: ACTIONS -->
                            <div class="flex items-center justify-between border-t border-gray-300/50 dark:border-gray-700 pt-1.5 text-gray-500 dark:text-gray-400 text-xs action-bar">
                                
                                <!-- LEFT ALIGNED -->
                                <div class="flex space-x-2 items-center pl-1">
                                    <button class="transition-colors btn-toggle-vis shrink-0 hover:text-[#71A4F4] ${node.isVisible ? 'text-[#E6E7EB]' : 'text-gray-400 dark:text-gray-500'}" data-key="${node.uniqueKey}" title="Visibility">
                                        <i class="fa-solid ${node.isVisible ? 'fa-eye' : 'fa-eye-slash'} text-[11px] w-3 text-center"></i>
                                    </button>
                                    <button class="transition-colors btn-solo shrink-0 hover:text-[#71A4F4] ${AppState.currentSoloLayerKey === node.uniqueKey ? 'text-[#71A4F4]' : 'text-gray-400 dark:text-gray-500'}" data-key="${node.uniqueKey}" title="Solo Layer">
                                        <span class="inline-block w-3 text-center text-[10px] font-black">S</span>
                                    </button>
                                    <button class="transition-colors btn-zoom shrink-0 text-gray-400 dark:text-gray-500 hover:text-[#71A4F4]" data-key="${node.uniqueKey}" title="Fit to View">
                                        <i class="fa-solid fa-bullseye text-[11px] w-3 text-center"></i>
                                    </button>
                                </div>

                                <!-- DYNAMIC STATUS TEXT (CENTER) -->
                                <div class="action-status-text flex-1 text-[9px] text-gray-400 dark:text-gray-500 italic text-center truncate px-1 opacity-0 transition-opacity pointer-events-none"></div>

                                <!-- RIGHT ALIGNED -->
                                <div class="flex space-x-2 justify-end pr-1">
                                    <button class="transition-colors text-gray-400 dark:text-gray-500 hover:text-[#71A4F4] btn-duplicate" data-key="${node.uniqueKey}" title="Duplicate"><i class="fa-solid fa-clone text-[10px]"></i></button>
                                    <button class="transition-colors text-gray-400 dark:text-gray-500 hover:text-[#94BC74] btn-export-folder" data-key="${node.uniqueKey}" title="Download"><i class="fa-solid fa-download text-[10px]"></i></button>
                                    <button class="transition-colors text-gray-400 dark:text-gray-500 hover:text-[#E87975] btn-remove" data-key="${node.uniqueKey}" title="Delete"><i class="fa-solid fa-trash text-[10px]"></i></button>
                                </div>
                            </div>
                        </div>
                    </div>
                    <div class="folder-children pl-4 pr-1 py-1 min-h-[15px] space-y-1 ${node.isExpanded ? '' : 'hidden'}" data-parent="${node.uniqueKey}">
                        ${buildNodeHTML(node.uniqueKey)}
                    </div>
                </div>`;
            } else {
                const isTableActive = (AppState.activeTableLayerKey === node.uniqueKey);
                const isEditActive = (AppState.activeEditLayerKey === node.uniqueKey);
                const isSplitActive = (AppState.activeSplitLayerKey === node.uniqueKey);
                const isCropActive = (AppState.activeCropLayerKey === node.uniqueKey);
                
                let bgClass = 'bg-white border-gray-100 shadow-xs dark:bg-gray-800 dark:border-gray-700';
                if (isTableActive || isEditActive || isSplitActive || isCropActive) {
                    bgClass = 'bg-blue-50 border-blue-300 shadow-sm dark:bg-blue-900/30 dark:border-blue-600';
                }

                html += `
                <div class="added-layer-item flex mb-1 rounded border transition-colors ${bgClass} overflow-hidden" data-key="${node.uniqueKey}" data-search="${node.displayName.toLowerCase()} ${node.id.toLowerCase()}">
                    
                    <!-- DRAG HANDLE -->
                    <div class="w-5 shrink-0 bg-gray-100/80 hover:bg-gray-200/80 dark:bg-gray-800/40 dark:hover:bg-gray-700/60 border-r border-gray-200 dark:border-gray-700/60 flex items-center justify-center cursor-grab drag-handle group" title="Drag to reorder layer">
                        <i class="fa-solid fa-grip-vertical text-gray-400/40 group-hover:text-gray-500 dark:text-gray-500/40 dark:group-hover:text-gray-400 text-[10px] transition-colors"></i>
                    </div>

                    <!-- CONTENT BLOCK -->
                    <div class="flex-1 flex flex-col p-1.5 min-w-0">
                        
                        <!-- TOP ROW -->
                        <div class="flex-1 overflow-hidden pr-1 pb-1.5">
                            <span class="text-xs font-semibold text-gray-800 dark:text-gray-200 truncate block outline-none focus:bg-white dark:focus:bg-gray-600 focus:ring-1 focus:ring-blue-500 rounded px-1 layer-name-editable cursor-text" data-key="${node.uniqueKey}" contenteditable="false" spellcheck="false" title="Double-click to rename">${node.displayName}</span>
                            <span class="text-[9px] text-gray-400 dark:text-gray-500 block truncate px-1" title="${node.id}">ID: ${node.id}</span>
                        </div>
                        
                        <!-- BOTTOM ROW: ACTIONS -->
                        <div class="flex items-center justify-between border-t border-gray-200 dark:border-gray-700 pt-1.5 text-gray-500 dark:text-gray-400 text-xs action-bar">
                            
                            <!-- LEFT ALIGNED -->
                            <div class="flex space-x-2 items-center pl-1">
                                <button class="transition-colors btn-toggle-vis shrink-0 hover:text-[#71A4F4] ${node.isVisible ? 'text-[#E6E7EB]' : 'text-gray-400 dark:text-gray-500'}" data-key="${node.uniqueKey}" title="Visibility">
                                    <i class="fa-solid ${node.isVisible ? 'fa-eye' : 'fa-eye-slash'} text-[11px] w-3 text-center"></i>
                                </button>
                                <button class="transition-colors btn-solo shrink-0 hover:text-[#71A4F4] ${AppState.currentSoloLayerKey === node.uniqueKey ? 'text-[#71A4F4]' : 'text-gray-400 dark:text-gray-500'}" data-key="${node.uniqueKey}" title="Solo Layer">
                                    <span class="inline-block w-3 text-center text-[10px] font-black">S</span>
                                </button>
                                <button class="transition-colors btn-zoom shrink-0 text-gray-400 dark:text-gray-500 hover:text-[#71A4F4]" data-key="${node.uniqueKey}" title="Fit to View">
                                    <i class="fa-solid fa-bullseye text-[11px] w-3 text-center"></i>
                                </button>
                            </div>

                            <!-- DYNAMIC STATUS TEXT (CENTER) -->
                            <div class="action-status-text flex-1 text-[9px] text-gray-400 dark:text-gray-500 italic text-center truncate px-1 opacity-0 transition-opacity pointer-events-none"></div>

                            <!-- RIGHT ALIGNED -->
                            <div class="flex space-x-2 justify-end">
                                <button class="transition-colors btn-table hover:text-[#DDCD84] ${isTableActive ? 'text-[#DDCD84]' : 'text-gray-400 dark:text-gray-500'}" data-key="${node.uniqueKey}" title="Attribute Table"><i class="fa-solid fa-table text-[10px]"></i></button>
                                <button class="transition-colors btn-edit hover:text-[#71A4F4] ${isEditActive ? 'text-[#71A4F4]' : 'text-gray-400 dark:text-gray-500'}" data-key="${node.uniqueKey}" title="Edit Appearance"><i class="fa-solid fa-palette text-[10px]"></i></button>
                                <button class="transition-colors btn-crop hover:text-[#71A4F4] ${isCropActive ? 'text-[#71A4F4]' : 'text-gray-400 dark:text-gray-500'}" data-key="${node.uniqueKey}" title="Crop/Filter"><i class="fa-solid fa-crop text-[10px]"></i></button>
                                <button class="transition-colors btn-split hover:text-[#71A4F4] ${isSplitActive ? 'text-[#71A4F4]' : 'text-gray-400 dark:text-gray-500'}" data-key="${node.uniqueKey}" title="Split"><i class="fa-solid fa-object-ungroup text-[10px]"></i></button>
                                <button class="transition-colors btn-duplicate text-gray-400 dark:text-gray-500 hover:text-[#71A4F4]" data-key="${node.uniqueKey}" title="Duplicate"><i class="fa-solid fa-clone text-[10px]"></i></button>
                                <button class="transition-colors btn-export text-gray-400 dark:text-gray-500 hover:text-[#94BC74]" data-key="${node.uniqueKey}" title="Download"><i class="fa-solid fa-download text-[10px]"></i></button>
                                <button class="transition-colors btn-remove text-gray-400 dark:text-gray-500 hover:text-[#E87975]" data-key="${node.uniqueKey}" title="Delete"><i class="fa-solid fa-trash text-[10px]"></i></button>
                            </div>
                        </div>
                    </div>
                </div>`;
            }
        });
        return html;
    };

    addedLayerList.innerHTML = buildNodeHTML(null);

    // --- Hover Listener for Status Text ONLY ---
    document.querySelectorAll('.action-bar').forEach(bar => {
        const statusTextEl = bar.querySelector('.action-status-text');
        const buttons = bar.querySelectorAll('button');
        
        buttons.forEach(btn => {
            btn.addEventListener('mouseenter', () => {
                const title = btn.getAttribute('title');
                if (title && statusTextEl) {
                    statusTextEl.textContent = title;
                    statusTextEl.classList.remove('opacity-0');
                    btn.setAttribute('data-original-title', title);
                    btn.removeAttribute('title');
                }
            });
            
            btn.addEventListener('mouseleave', () => {
                if (statusTextEl) {
                    statusTextEl.classList.add('opacity-0');
                }
                const originalTitle = btn.getAttribute('data-original-title');
                if (originalTitle) {
                    btn.setAttribute('title', originalTitle);
                }
            });
        });
    });

    // --- Action Listeners ---
    document.querySelectorAll('.layer-name-editable').forEach(span => {
        span.addEventListener('dblclick', (e) => {
            e.preventDefault();
            span.setAttribute('contenteditable', 'true');
            span.focus();
            const selection = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(span);
            selection.removeAllRanges();
            selection.addRange(range);
        });

        span.addEventListener('blur', (e) => {
            span.setAttribute('contenteditable', 'false');
            const key = e.target.getAttribute('data-key');
            const layer = AppState.activeLayers.find(l => l.uniqueKey === key);
            if (!layer) return;
            const newName = e.target.textContent.trim();
            if (newName && newName !== layer.displayName) {
                layer.displayName = newName;
                autoSaveWorkspace();
            } else {
                e.target.textContent = layer.displayName;
            }
        });
        
        span.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                e.target.blur();
            }
        });
    });

    document.querySelectorAll('.btn-table').forEach(btn => btn.addEventListener('click', handleToggleTable));
    document.querySelectorAll('.btn-edit').forEach(btn => btn.addEventListener('click', handleToggleEdit));
    document.querySelectorAll('.btn-split').forEach(btn => btn.addEventListener('click', handleToggleSplit));
    document.querySelectorAll('.btn-crop').forEach(btn => btn.addEventListener('click', handleToggleCrop));
    document.querySelectorAll('.btn-duplicate').forEach(btn => btn.addEventListener('click', handleDuplicate));
    document.querySelectorAll('.btn-export').forEach(btn => btn.addEventListener('click', handleExport));
    document.querySelectorAll('.btn-export-folder').forEach(btn => btn.addEventListener('click', handleExportFolder));
    document.querySelectorAll('.btn-remove').forEach(btn => btn.addEventListener('click', handleRemove));
    document.querySelectorAll('.btn-toggle-vis').forEach(btn => btn.addEventListener('click', handleToggleVisibility)); 
    document.querySelectorAll('.btn-solo').forEach(btn => btn.addEventListener('click', handleToggleSolo));
    document.querySelectorAll('.btn-zoom').forEach(btn => btn.addEventListener('click', handleZoomToLayer));
    
    document.querySelectorAll('.btn-toggle-folder').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const key = e.currentTarget.getAttribute('data-key');
            const folder = AppState.activeLayers.find(l => l.uniqueKey === key);
            if (folder) {
                folder.isExpanded = !folder.isExpanded;
                renderAddedLayers();
                autoSaveWorkspace();
            }
        });
    });

    const searchActive = addedLayerSearch && addedLayerSearch.value.trim() !== '';
    const attachSortable = (el) => {
        new Sortable(el, {
            group: 'nested',
            animation: 150,
            fallbackOnBody: true,
            swapThreshold: 0.65,
            handle: '.drag-handle',
            disabled: searchActive,
            onEnd: function (evt) {
                rebuildActiveLayersFromDOM();
            }
        });
    };
    
    attachSortable(addedLayerList);
    document.querySelectorAll('.folder-children').forEach(attachSortable);
    
    triggerAddedSearch();
};