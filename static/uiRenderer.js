// static/uiRenderer.js

import { AppState } from './state.js';
const emitWorkspaceAction = (name, event = null) => {
    document.dispatchEvent(new CustomEvent('workspaceAction', { detail: { name, event } }));
};

export const renderAddedLayers = () => {
    const addedLayerList = document.getElementById('added-layer-list');
    const tabBtnAdded = document.getElementById('tab-btn-added');
    const addedLayerSearch = document.getElementById('added-layer-search');

    if (tabBtnAdded) tabBtnAdded.textContent = `LAYERS (${AppState.activeLayers.length})`;
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
                <div class="folder-item mb-1 border border-gray-300 dark:border-gray-600 rounded bg-gray-100 dark:bg-gray-800 shadow-xs flex flex-col overflow-hidden" data-key="${node.uniqueKey}" data-search="${node.displayName.toLowerCase()}" data-hover-context="Folder: ${node.displayName}">
                    <div class="flex items-stretch border-b border-transparent dark:border-gray-700 folder-header">
                        
                        <!-- DRAG HANDLE -->
                        <div class="w-5 shrink-0 bg-gray-200/60 hover:bg-gray-300/80 dark:bg-gray-700/40 dark:hover:bg-gray-600/60 border-r border-gray-300/50 dark:border-gray-700/50 flex items-center justify-center cursor-grab drag-handle group" data-hover-context="Drag to reorder folder">
                            <i class="fa-solid fa-grip-vertical text-gray-400/40 group-hover:text-gray-500 dark:text-gray-500/40 dark:group-hover:text-gray-400 text-[10px] transition-colors"></i>
                        </div>

                        <!-- CONTENT BLOCK -->
                        <div class="flex-1 flex flex-col p-1.5 min-w-0">
                            
                            <!-- TOP ROW: TITLE & ICONS -->
                            <div class="flex items-center overflow-hidden pr-1 pb-1.5 space-x-1.5 pl-0.5">
                                <button class="btn-toggle-folder text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300 shrink-0 flex justify-center transition-colors" data-key="${node.uniqueKey}" aria-label="${node.isExpanded ? 'Collapse Folder' : 'Expand Folder'}" data-hover-context="${node.isExpanded ? 'Collapse folder' : 'Expand folder'}">
                                    <i class="fa-solid ${node.isExpanded ? 'fa-folder-open' : 'fa-folder'} text-[12px] w-4 text-center"></i>
                                </button>
                                <span class="text-xs font-bold text-gray-700 dark:text-gray-200 truncate outline-none focus:bg-white dark:focus:bg-gray-600 focus:ring-1 focus:ring-blue-500 rounded px-1 layer-name-editable flex-1 cursor-text" data-key="${node.uniqueKey}" contenteditable="false" spellcheck="false" aria-label="${node.displayName}" data-hover-context="Double-click to rename folder">${node.displayName}</span>
                            </div>
                            
                            <!-- BOTTOM ROW: ACTIONS -->
                            <div class="flex items-center justify-between border-t border-gray-300/50 dark:border-gray-700 pt-1.5 text-gray-500 dark:text-gray-400 text-xs action-bar">
                                
                                <!-- LEFT ALIGNED -->
                                <div class="flex space-x-2 items-center pl-1">
                                    <button class="transition-colors btn-toggle-vis shrink-0 ${node.isVisible ? '' : 'text-gray-400 dark:text-gray-500'}" 
                                            style="${node.isVisible ? 'color: #E6E7EB;' : ''}" 
                                            onmouseenter="this.style.color='#71A4F4'" 
                                            onmouseleave="this.style.color='${node.isVisible ? '#E6E7EB' : ''}'" 
                                            data-key="${node.uniqueKey}" aria-label="Visibility" data-hover-context="Visibility">
                                        <i class="fa-solid ${node.isVisible ? 'fa-eye' : 'fa-eye-slash'} text-[11px] w-3 text-center"></i>
                                    </button>
                                    
                                    <button class="transition-colors btn-solo shrink-0 ${AppState.currentSoloLayerKey === node.uniqueKey ? '' : 'text-gray-400 dark:text-gray-500'}" 
                                            style="${AppState.currentSoloLayerKey === node.uniqueKey ? 'color: #71A4F4;' : ''}" 
                                            onmouseenter="this.style.color='#71A4F4'" 
                                            onmouseleave="this.style.color='${AppState.currentSoloLayerKey === node.uniqueKey ? '#71A4F4' : ''}'" 
                                            data-key="${node.uniqueKey}" aria-label="Solo layer" data-hover-context="Solo layer">
                                        <span class="inline-block w-3 text-center text-[10px] font-black">S</span>
                                    </button>
                                    
                                    <button class="transition-colors btn-zoom shrink-0 text-gray-400 dark:text-gray-500" 
                                            onmouseenter="this.style.color='#71A4F4'" 
                                            onmouseleave="this.style.color=''" 
                                            data-key="${node.uniqueKey}" aria-label="Fit to view" data-hover-context="Fit to view">
                                        <i class="fa-solid fa-bullseye text-[11px] w-3 text-center"></i>
                                    </button>
                                </div>

                                <!-- RIGHT ALIGNED -->
                                <div class="flex space-x-2 justify-end pr-1">
                                    <button class="transition-colors text-gray-400 dark:text-gray-500 btn-duplicate" 
                                            onmouseenter="this.style.color='#71A4F4'" 
                                            onmouseleave="this.style.color=''" 
                                            data-key="${node.uniqueKey}" aria-label="Duplicate" data-hover-context="Duplicate">
                                        <i class="fa-solid fa-clone text-[10px]"></i>
                                    </button>
                                    
                                    <button class="transition-colors text-gray-400 dark:text-gray-500 btn-export-folder" 
                                            onmouseenter="this.style.color='#94BC74'" 
                                            onmouseleave="this.style.color=''" 
                                            data-key="${node.uniqueKey}" aria-label="Download" data-hover-context="Download">
                                        <i class="fa-solid fa-download text-[10px]"></i>
                                    </button>
                                    
                                    <button class="transition-colors text-gray-400 dark:text-gray-500 btn-remove" 
                                            onmouseenter="this.style.color='#E87975'" 
                                            onmouseleave="this.style.color=''" 
                                            data-key="${node.uniqueKey}" aria-label="Delete" data-hover-context="Delete">
                                        <i class="fa-solid fa-trash text-[10px]"></i>
                                    </button>
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
                const isRasterImage = Boolean(node.isRasterImage);
                const isGeometryEditActive = Boolean(AppState.geometryEdit?.active && AppState.geometryEdit.layerKey === node.uniqueKey);
                const canEditGeometry = !isRasterImage && Boolean(node.geoJsonData?.features?.length);
                const rasterOpacity = Math.round(Math.max(0, Math.min(1, Number(node.rasterOpacity ?? 0.8))) * 100);
                
                let bgClass = 'bg-white border-gray-100 shadow-xs dark:bg-gray-800 dark:border-gray-700';
                if (isTableActive || isEditActive || isSplitActive || isCropActive || isGeometryEditActive) {
                    bgClass = 'bg-blue-50 border-blue-300 shadow-sm dark:bg-blue-900/30 dark:border-blue-600';
                }

                html += `
                <div class="added-layer-item flex mb-1 rounded border transition-colors ${bgClass} overflow-hidden" data-key="${node.uniqueKey}" data-search="${node.displayName.toLowerCase()} ${node.id.toLowerCase()}" data-hover-context="Layer: ${node.displayName}">
                    
                    <!-- DRAG HANDLE -->
                    <div class="w-5 shrink-0 bg-gray-100/80 hover:bg-gray-200/80 dark:bg-gray-800/40 dark:hover:bg-gray-700/60 border-r border-gray-200 dark:border-gray-700/60 flex items-center justify-center cursor-grab drag-handle group" data-hover-context="Drag to reorder layer">
                        <i class="fa-solid fa-grip-vertical text-gray-400/40 group-hover:text-gray-500 dark:text-gray-500/40 dark:group-hover:text-gray-400 text-[10px] transition-colors"></i>
                    </div>

                    <!-- CONTENT BLOCK -->
                    <div class="flex-1 flex flex-col p-1.5 min-w-0">
                        
                        <!-- TOP ROW -->
                        <div class="flex-1 overflow-hidden pr-1 pb-1.5">
                            <span class="text-xs font-semibold text-gray-800 dark:text-gray-200 truncate block outline-none focus:bg-white dark:focus:bg-gray-600 focus:ring-1 focus:ring-blue-500 rounded px-1 layer-name-editable cursor-text" data-key="${node.uniqueKey}" contenteditable="false" spellcheck="false" aria-label="${node.displayName}" data-hover-context="Double-click to rename layer">${node.displayName}</span>
                            <span class="text-[9px] text-gray-400 dark:text-gray-500 block truncate px-1" aria-label="Layer ID ${node.id}" data-hover-context="Layer ID: ${node.id}">ID: ${node.id}</span>
                        </div>

                        ${isRasterImage ? `
                        <div class="flex items-center gap-1 border-t border-gray-200 dark:border-gray-700 pt-1 mb-1 px-1 text-[9px] text-gray-500 dark:text-gray-400" data-hover-context="Adjust image opacity">
                            <span class="shrink-0">Opacity</span>
                            <input type="range" min="0" max="1" step="0.01" value="${rasterOpacity / 100}" class="raster-opacity min-w-0 flex-1 h-1 accent-blue-600" data-key="${node.uniqueKey}" aria-label="Image opacity" data-hover-context="Image opacity">
                            <span class="w-7 text-right font-mono" data-raster-opacity-value>${rasterOpacity}%</span>
                        </div>` : ''}
                        
                        <!-- BOTTOM ROW: ACTIONS -->
                        <div class="flex items-center justify-between border-t border-gray-200 dark:border-gray-700 pt-1.5 text-gray-500 dark:text-gray-400 text-xs action-bar">
                            
                            <!-- LEFT ALIGNED -->
                            <div class="flex space-x-2 items-center pl-1">
                                <button class="transition-colors btn-toggle-vis shrink-0 ${node.isVisible ? '' : 'text-gray-400 dark:text-gray-500'}" 
                                        style="${node.isVisible ? 'color: #E6E7EB;' : ''}" 
                                        onmouseenter="this.style.color='#71A4F4'" 
                                        onmouseleave="this.style.color='${node.isVisible ? '#E6E7EB' : ''}'" 
                                        data-key="${node.uniqueKey}" aria-label="Visibility" data-hover-context="Visibility">
                                    <i class="fa-solid ${node.isVisible ? 'fa-eye' : 'fa-eye-slash'} text-[11px] w-3 text-center"></i>
                                </button>
                                
                                <button class="transition-colors btn-solo shrink-0 ${AppState.currentSoloLayerKey === node.uniqueKey ? '' : 'text-gray-400 dark:text-gray-500'}" 
                                        style="${AppState.currentSoloLayerKey === node.uniqueKey ? 'color: #71A4F4;' : ''}" 
                                        onmouseenter="this.style.color='#71A4F4'" 
                                        onmouseleave="this.style.color='${AppState.currentSoloLayerKey === node.uniqueKey ? '#71A4F4' : ''}'" 
                                        data-key="${node.uniqueKey}" aria-label="Solo layer" data-hover-context="Solo layer">
                                    <span class="inline-block w-3 text-center text-[10px] font-black">S</span>
                                </button>
                                
                                <button class="transition-colors btn-zoom shrink-0 text-gray-400 dark:text-gray-500" 
                                        onmouseenter="this.style.color='#71A4F4'" 
                                        onmouseleave="this.style.color=''" 
                                        data-key="${node.uniqueKey}" aria-label="Fit to view" data-hover-context="Fit to view">
                                    <i class="fa-solid fa-bullseye text-[11px] w-3 text-center"></i>
                                </button>
                            </div>

                            <!-- RIGHT ALIGNED -->
                            <div class="flex space-x-2 justify-end">
                                ${!isRasterImage ? `
                                <button class="transition-colors btn-table ${isTableActive ? '' : 'text-gray-400 dark:text-gray-500'}" 
                                        style="${isTableActive ? 'color: #DDCD84;' : ''}" 
                                        onmouseenter="this.style.color='#DDCD84'" 
                                        onmouseleave="this.style.color='${isTableActive ? '#DDCD84' : ''}'" 
                                        data-key="${node.uniqueKey}" aria-label="Attribute table" data-hover-context="Attribute table">
                                    <i class="fa-solid fa-table text-[10px]"></i>
                                </button>

                                ${canEditGeometry ? `<button class="transition-colors btn-geometry-edit ${isGeometryEditActive ? '' : 'text-gray-400 dark:text-gray-500'}"
                                        style="${isGeometryEditActive ? 'color: #71A4F4;' : ''}"
                                        onmouseenter="this.style.color='#71A4F4'"
                                        onmouseleave="this.style.color='${isGeometryEditActive ? '#71A4F4' : ''}'"
                                        data-key="${node.uniqueKey}" aria-label="Edit geometry" data-hover-context="Edit geometry">
                                    <i class="fa-solid fa-pen-to-square text-[10px]"></i>
                                </button>` : ''}
                                
                                <button class="transition-colors btn-edit ${isEditActive ? '' : 'text-gray-400 dark:text-gray-500'}" 
                                        style="${isEditActive ? 'color: #71A4F4;' : ''}" 
                                        onmouseenter="this.style.color='#71A4F4'" 
                                        onmouseleave="this.style.color='${isEditActive ? '#71A4F4' : ''}'" 
                                        data-key="${node.uniqueKey}" aria-label="Edit appearance" data-hover-context="Edit appearance">
                                    <i class="fa-solid fa-palette text-[10px]"></i>
                                </button>
                                
                                <button class="transition-colors btn-crop ${isCropActive ? '' : 'text-gray-400 dark:text-gray-500'}" 
                                        style="${isCropActive ? 'color: #71A4F4;' : ''}" 
                                        onmouseenter="this.style.color='#71A4F4'" 
                                        onmouseleave="this.style.color='${isCropActive ? '#71A4F4' : ''}'" 
                                        data-key="${node.uniqueKey}" aria-label="Crop or filter" data-hover-context="Crop or filter">
                                    <i class="fa-solid fa-crop text-[10px]"></i>
                                </button>
                                
                                <button class="transition-colors btn-split ${isSplitActive ? '' : 'text-gray-400 dark:text-gray-500'}" 
                                        style="${isSplitActive ? 'color: #71A4F4;' : ''}" 
                                        onmouseenter="this.style.color='#71A4F4'" 
                                        onmouseleave="this.style.color='${isSplitActive ? '#71A4F4' : ''}'" 
                                        data-key="${node.uniqueKey}" aria-label="Split layer" data-hover-context="Split layer">
                                    <i class="fa-solid fa-object-ungroup text-[10px]"></i>
                                </button>
                                
                                <button class="transition-colors btn-duplicate text-gray-400 dark:text-gray-500" 
                                        onmouseenter="this.style.color='#71A4F4'" 
                                        onmouseleave="this.style.color=''" 
                                        data-key="${node.uniqueKey}" aria-label="Duplicate" data-hover-context="Duplicate">
                                    <i class="fa-solid fa-clone text-[10px]"></i>
                                </button>
                                
                                <button class="transition-colors btn-export text-gray-400 dark:text-gray-500" 
                                        onmouseenter="this.style.color='#94BC74'" 
                                        onmouseleave="this.style.color=''" 
                                        data-key="${node.uniqueKey}" aria-label="Download" data-hover-context="Download">
                                    <i class="fa-solid fa-download text-[10px]"></i>
                                </button>
                                ` : ''}
                                
                                <button class="transition-colors btn-remove text-gray-400 dark:text-gray-500" 
                                        onmouseenter="this.style.color='#E87975'" 
                                        onmouseleave="this.style.color=''" 
                                        data-key="${node.uniqueKey}" aria-label="Delete" data-hover-context="Delete">
                                    <i class="fa-solid fa-trash text-[10px]"></i>
                                </button>
                            </div>
                        </div>
                    </div>
                </div>`;
            }
        });
        return html;
    };

    addedLayerList.innerHTML = buildNodeHTML(null);

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
                emitWorkspaceAction('autoSaveWorkspace');
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

    document.querySelectorAll('.btn-table').forEach(btn => btn.addEventListener('click', e => emitWorkspaceAction('handleToggleTable', e)));
    document.querySelectorAll('.btn-geometry-edit').forEach(btn => btn.addEventListener('click', e => emitWorkspaceAction('handleToggleGeometryEdit', e)));
    document.querySelectorAll('.btn-edit').forEach(btn => btn.addEventListener('click', e => emitWorkspaceAction('handleToggleEdit', e)));
    document.querySelectorAll('.btn-split').forEach(btn => btn.addEventListener('click', e => emitWorkspaceAction('handleToggleSplit', e)));
    document.querySelectorAll('.btn-crop').forEach(btn => btn.addEventListener('click', e => emitWorkspaceAction('handleToggleCrop', e)));
    document.querySelectorAll('.btn-duplicate').forEach(btn => btn.addEventListener('click', e => emitWorkspaceAction('handleDuplicate', e)));
    document.querySelectorAll('.btn-export').forEach(btn => btn.addEventListener('click', e => emitWorkspaceAction('handleExport', e)));
    document.querySelectorAll('.btn-export-folder').forEach(btn => btn.addEventListener('click', e => emitWorkspaceAction('handleExportFolder', e)));
    document.querySelectorAll('.btn-remove').forEach(btn => btn.addEventListener('click', e => emitWorkspaceAction('handleRemove', e)));
    document.querySelectorAll('.btn-toggle-vis').forEach(btn => btn.addEventListener('click', e => emitWorkspaceAction('handleToggleVisibility', e)));
    document.querySelectorAll('.raster-opacity').forEach(input => input.addEventListener('input', e => emitWorkspaceAction('handleSetRasterOpacity', e)));
    document.querySelectorAll('.btn-solo').forEach(btn => btn.addEventListener('click', e => emitWorkspaceAction('handleToggleSolo', e)));
    document.querySelectorAll('.btn-zoom').forEach(btn => btn.addEventListener('click', e => emitWorkspaceAction('handleZoomToLayer', e)));
    
    document.querySelectorAll('.btn-toggle-folder').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const key = e.currentTarget.getAttribute('data-key');
            const folder = AppState.activeLayers.find(l => l.uniqueKey === key);
            if (folder) {
                folder.isExpanded = !folder.isExpanded;
                renderAddedLayers();
                emitWorkspaceAction('autoSaveWorkspace');
            }
        });
    });

    const searchActive = addedLayerSearch && addedLayerSearch.value.trim() !== '';
    const attachSortable = (el) => {
        new Sortable(el, {
            group: 'nested',
            animation: 90,
            fallbackOnBody: true,
            swapThreshold: 0.9, // Increased from 0.5 to trigger the snap earlier
            invertSwap: true,
            handle: '.drag-handle',
            disabled: searchActive,
            onEnd: function (evt) {
                emitWorkspaceAction('rebuildActiveLayersFromDOM', evt);
            }
        });
    };
    
    attachSortable(addedLayerList);
    document.querySelectorAll('.folder-children').forEach(attachSortable);
    
    emitWorkspaceAction('triggerAddedSearch');
};

import { stateEvents } from './state.js';

// Automatically re-render UI elements when specific state keys change
stateEvents.addEventListener('stateChanged', (e) => {
    const { property } = e.detail;
    
    if (property === 'activeLayers') {
        renderAddedLayers();
    }
});
