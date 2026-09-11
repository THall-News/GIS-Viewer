import { AppState } from './state.js';
import { map } from './mapEngine.js';
import { attachTableResizer as attachTableResizerDom } from './tablePanel.js';

export function createAttributeTableController(deps) {
    const { container: attributeTableContainer, renderAddedLayers, ensureGeoJSON, showToast, downloadBlob, updateStacking, closeTablePanel } = deps;
    // 6. ATTRIBUTE TABLE RENDERING
    // ==========================================
    const attachTableResizer = () => {
        if (attributeTableContainer) attributeTableContainer.style.position = 'relative';
        
        const resizer = attributeTableContainer?.querySelector('.table-resizer');
        if (!resizer) return;
        
        let isResizing = false;
        resizer.addEventListener('mousedown', (e) => {
            e.preventDefault();
            isResizing = true;
            document.body.classList.add('select-none', 'cursor-row-resize');
    
            const startY = e.clientY;
            const startHeight = attributeTableContainer.offsetHeight;
    
            const doDrag = (moveEvt) => {
                if (!isResizing) return;
                const dy = startY - moveEvt.clientY;
                const newHeight = Math.max(100, Math.min(window.innerHeight - 40, startHeight + dy));
                
                attributeTableContainer.style.maxHeight = 'none';
                attributeTableContainer.style.height = `${newHeight}px`;
                updateStacking();
            };
    
            const stopDrag = () => {
                if (isResizing) {
                    isResizing = false;
                    document.body.classList.remove('select-none', 'cursor-row-resize');
                    window.removeEventListener('mousemove', doDrag);
                    window.removeEventListener('mouseup', stopDrag);
                }
            };
    
            window.addEventListener('mousemove', doDrag);
            window.addEventListener('mouseup', stopDrag);
        });
    };
    
    const attachColumnResizers = () => {
        const ths = attributeTableContainer.querySelectorAll('.tbl-header');
        ths.forEach(th => {
            const resizer = th.querySelector('.col-resizer');
            if (!resizer) return;
            let startX, startWidth;
            
            resizer.addEventListener('mousedown', (e) => {
                e.stopPropagation(); 
                e.preventDefault();
                startX = e.pageX;
                startWidth = th.offsetWidth;
                
                document.body.classList.add('select-none', 'cursor-col-resize');
                
                const onMouseMove = (moveEvt) => {
                    const newWidth = startWidth + (moveEvt.pageX - startX);
                    if (newWidth > 30) {
                        th.style.minWidth = `${newWidth}px`;
                        th.style.width = `${newWidth}px`;
                        th.style.maxWidth = `${newWidth}px`;
                    }
                };
                
                const onMouseUp = () => {
                    document.body.classList.remove('select-none', 'cursor-col-resize');
                    document.removeEventListener('mousemove', onMouseMove);
                    document.removeEventListener('mouseup', onMouseUp);
                };
                
                document.addEventListener('mousemove', onMouseMove);
                document.addEventListener('mouseup', onMouseUp);
            });
        });
    };
    
    let currentTableLayerName = "";
    
    const highlightTableRow = (rowId) => {
        if (!attributeTableContainer || attributeTableContainer.classList.contains('hidden')) return;
    
        if (rowId >= 100 && !AppState.tableShowAll) {
            AppState.tableShowAll = true;
            renderTableContent(currentTableLayerName);
        }
    
        const isAlreadyHighlighted = AppState.highlightLayer && AppState.highlightLayer._row_id === rowId;
            
        if (AppState.highlightLayer) {
            map.removeLayer(AppState.highlightLayer);
            AppState.highlightLayer = null;
        }
    
        document.querySelectorAll('.tbl-row').forEach(row => {
            row.classList.remove('bg-blue-100', 'dark:bg-blue-800/60');
            row.classList.add('hover:bg-blue-50', 'dark:hover:bg-blue-900/30');
        });
    
        if (isAlreadyHighlighted) return;
    
        const targetFeature = AppState.currentTableFeatures.find(f => f.__row_id === rowId);
        if (targetFeature && targetFeature.geometry) {
            if (!map.getPane('highlightPane')) {
                map.createPane('highlightPane');
                map.getPane('highlightPane').style.zIndex = 2500; 
                map.getPane('highlightPane').style.pointerEvents = 'none'; 
            }
    
            AppState.highlightLayer = L.geoJSON(targetFeature, {
                pane: 'highlightPane', 
                interactive: false,
                style: { color: '#00ffff', weight: 5, opacity: 1, fillColor: '#00ffff', fillOpacity: 0.3 },
                pointToLayer: (feature, latlng) => {
                    return L.circleMarker(latlng, { pane: 'highlightPane', interactive: false, radius: 10, color: '#00ffff', weight: 4, opacity: 1, fillColor: '#00ffff', fillOpacity: 0.3 });
                }
            }).addTo(map);
            AppState.highlightLayer._row_id = rowId; 
        }
        
        const targetRow = attributeTableContainer.querySelector(`.tbl-row[data-id="${rowId}"]`);
        if (targetRow) {
            targetRow.classList.remove('hover:bg-blue-50', 'dark:hover:bg-blue-900/30');
            targetRow.classList.add('bg-blue-100', 'dark:bg-blue-800/60');
            targetRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    };
    
    const renderTableContent = (layerName) => {
        currentTableLayerName = layerName;
        const layer = AppState.activeLayers.find(l => l.uniqueKey === AppState.activeTableLayerKey);
        
        let displayFeatures = [...AppState.currentTableFeatures];
        
        if (!AppState.tableShowAll) {
            displayFeatures = displayFeatures.slice(0, 100);
        }
        
        if (AppState.tableSortCol) {
            displayFeatures = sortFeatures(displayFeatures, AppState.tableSortCol, AppState.tableSortAsc);
        }
    
        let tableHtml = `
            <div class="table-resizer absolute top-0 left-0 w-full h-1.5 bg-gray-200 hover:bg-blue-400 dark:bg-gray-700 dark:hover:bg-blue-500 cursor-row-resize z-50 transition-colors" title="Drag to resize"></div>
            <div class="flex justify-between items-center mb-1 shrink-0 border-b border-gray-200 dark:border-gray-700 pb-1 pt-1.5">
                <div class="text-xs font-bold text-gray-700 dark:text-gray-200">${layerName} Data</div>
                
                <div class="flex items-center space-x-2 pr-1">
                    <button id="btn-download-csv" class="bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 text-[10px] px-2 py-0.5 rounded font-medium border border-gray-300 dark:border-gray-600 transition-colors shadow-xs flex items-center" title="Download table as CSV">
                        <i class="fa-solid fa-file-csv mr-1 text-emerald-600 dark:text-emerald-400"></i> Download CSV
                    </button>
                    <button id="btn-bake-coords" class="bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 text-[10px] px-2 py-0.5 rounded font-medium border border-gray-300 dark:border-gray-600 transition-colors shadow-xs flex items-center" title="Extract coordinates to data columns">
                        <i class="fa-solid fa-location-dot mr-1 text-blue-600 dark:text-blue-400"></i> Bake Lat/Long
                    </button>
                    <button onclick="window.closeTablePanel()" class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 px-1"><i class="fa-solid fa-times text-xs"></i></button>
                </div>
            </div>
            <div class="flex-1 overflow-auto min-h-0 custom-scroll border border-gray-200 dark:border-gray-700 rounded">
                <table class="min-w-full text-xs text-left border-collapse bg-white dark:bg-gray-800 table-auto">
                    <thead class="bg-gray-100 dark:bg-gray-700 sticky top-0 shadow-xs z-10"><tr>`;
        
        AppState.currentTableHeaders.forEach(h => { 
            let sortIcon = '<i class="fa-solid fa-sort ml-1 text-gray-400 opacity-40"></i>';
            if (AppState.tableSortCol === h) {
                sortIcon = AppState.tableSortAsc 
                    ? '<i class="fa-solid fa-sort-up ml-1 text-blue-600 dark:text-blue-400"></i>' 
                    : '<i class="fa-solid fa-sort-down ml-1 text-blue-600 dark:text-blue-400"></i>';
            }
            tableHtml += `
                <th class="px-2 py-1 border border-gray-200 dark:border-gray-600 font-semibold text-gray-700 dark:text-gray-200 whitespace-nowrap cursor-pointer hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors select-none tbl-header relative" data-col="${h}">
                    <span class="mr-2 pointer-events-none">${h} ${sortIcon}</span>
                    <div class="col-resizer absolute top-0 right-0 w-1.5 h-full cursor-col-resize hover:bg-blue-400 dark:hover:bg-blue-500 z-10 transition-colors" title="Drag to resize"></div>
                </th>`; 
        });
        tableHtml += '</tr></thead><tbody>';
    
        displayFeatures.forEach(f => {
            const isHighlighted = AppState.highlightLayer && AppState.highlightLayer._row_id === f.__row_id;
            const rowClass = isHighlighted ? 'bg-blue-100 dark:bg-blue-800/60' : 'hover:bg-blue-50 dark:hover:bg-blue-900/30';
    
            tableHtml += `<tr class="tbl-row cursor-pointer transition-colors ${rowClass}" data-id="${f.__row_id}">`;
            AppState.currentTableHeaders.forEach(h => {
                const val = f.properties ? f.properties[h] : '';
                const displayVal = (val !== null && val !== undefined) ? val : '';
                tableHtml += `<td class="px-2 py-0.5 border border-gray-200 dark:border-gray-700 text-gray-800 dark:text-gray-300 whitespace-nowrap overflow-hidden text-ellipsis" title="${displayVal}">${displayVal}</td>`;
            });
            tableHtml += '</tr>';
        });
    
        tableHtml += '</tbody></table></div>';
        
        const totalCount = layer && !layer.isLocalGeoJSON ? (layer.remoteFeatureCount || AppState.currentTableFeatures.length) : AppState.currentTableFeatures.length;
        const isPreviewing = !AppState.tableShowAll && (totalCount > 100 || totalCount === '?');
    
        if (isPreviewing) {
           tableHtml += `<p class="text-[10px] text-blue-600 dark:text-blue-400 mt-1 italic text-center shrink-0 cursor-pointer hover:underline font-semibold transition-colors" id="btn-load-full-table">Showing ${displayFeatures.length} of ${totalCount} records for preview. Click here to load full table.</p>`;
        } else {
           tableHtml += `<p class="text-[9px] text-gray-400 dark:text-gray-500 mt-1 italic text-center shrink-0 cursor-default">Showing all ${displayFeatures.length} records.</p>`;
        }
        
        attributeTableContainer.innerHTML = tableHtml;
        attachTableResizerDom(attributeTableContainer, updateStacking);
        attachColumnResizers();
    
        const btnLoadFull = attributeTableContainer.querySelector('#btn-load-full-table');
        if (btnLoadFull) {
            btnLoadFull.addEventListener('click', async () => {
                if (layer && !layer.isLocalGeoJSON) {
                    btnLoadFull.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-1"></i> Downloading full dataset...';
                    btnLoadFull.classList.remove('hover:underline', 'cursor-pointer');
                    
                    const success = await ensureGeoJSON(layer);
                    if (success) {
                        AppState.currentTableFeatures = layer.geoJsonData.features || [];
                        AppState.currentTableFeatures.forEach((f, i) => f.__row_id = i);
                    } else {
                        showToast("Failed to fetch full dataset.", true);
                        return;
                    }
                }
                
                AppState.tableShowAll = true;
                renderTableContent(layerName);
            });
        }
    
        const btnDownloadCsv = attributeTableContainer.querySelector('#btn-download-csv');
        if (btnDownloadCsv) {
            btnDownloadCsv.addEventListener('click', async () => {
                if (!layer) return;
    
                if (!layer.isLocalGeoJSON) {
                    btnDownloadCsv.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-1 text-emerald-600 dark:text-emerald-400"></i> Fetching Data...';
                    btnDownloadCsv.disabled = true;
                    const success = await ensureGeoJSON(layer);
                    if (!success) {
                        btnDownloadCsv.innerHTML = '<i class="fa-solid fa-file-csv mr-1 text-emerald-600 dark:text-emerald-400"></i> Download CSV';
                        btnDownloadCsv.disabled = false;
                        return;
                    }
                }
    
                const featuresToExport = layer.geoJsonData.features || [];
                if (featuresToExport.length === 0) return showToast("No data available to export.", true);
    
                const csvString = featuresToCsv(featuresToExport);
    
                const safeName = (layerName || 'export').replace(/[^a-z0-9]/gi, '_').toLowerCase();
                const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
                downloadBlob(blob, `${safeName}.csv`);
                
                showToast(`Downloaded CSV with ${featuresToExport.length} records!`);
                btnDownloadCsv.innerHTML = '<i class="fa-solid fa-file-csv mr-1 text-emerald-600 dark:text-emerald-400"></i> Download CSV';
                btnDownloadCsv.disabled = false;
            });
        }
    
        const btnBakeCoords = attributeTableContainer.querySelector('#btn-bake-coords');
        if (btnBakeCoords) {
            btnBakeCoords.addEventListener('click', async () => {
                if (!layer) return;
    
                if (!layer.isLocalGeoJSON) {
                    btnBakeCoords.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-1 text-blue-600 dark:text-blue-400"></i> Fetching Data...';
                    btnBakeCoords.disabled = true;
                    const success = await ensureGeoJSON(layer);
                    if (!success) {
                        btnBakeCoords.innerHTML = '<i class="fa-solid fa-location-dot mr-1 text-blue-600 dark:text-blue-400"></i> Bake Lat/Long';
                        btnBakeCoords.disabled = false;
                        return;
                    }
                }
    
                const count = bakeFeatureCoordinates(layer.geoJsonData.features, turf);
    
                if (count > 0) {
                    autoSaveWorkspace();
                    showToast(`Baked LAT/LONG to ${count} features!`);
                    AppState.activeTableLayerKey = null; 
                    handleToggleTable(layer.uniqueKey);
                } else {
                    showToast("No valid geometries found.", true);
                    btnBakeCoords.innerHTML = '<i class="fa-solid fa-location-dot mr-1 text-blue-600 dark:text-blue-400"></i> Bake Lat/Long';
                    btnBakeCoords.disabled = false;
                }
            });
        }
    
        document.querySelectorAll('.tbl-header').forEach(th => {
            th.addEventListener('click', (e) => {
                const col = e.currentTarget.getAttribute('data-col');
                if (AppState.tableSortCol === col) AppState.tableSortAsc = !AppState.tableSortAsc;
                else { AppState.tableSortCol = col; AppState.tableSortAsc = true; }
                renderTableContent(layerName); 
            });
        });
    
        document.querySelectorAll('.tbl-row').forEach(tr => {
            tr.addEventListener('click', (e) => {
                const rowId = parseInt(e.currentTarget.getAttribute('data-id'), 10);
                highlightTableRow(rowId);
            });
        });
    };
    
    const handleToggleTable = async (e) => {
      const key = e.currentTarget ? e.currentTarget.getAttribute('data-key') : e;
      const layer = AppState.activeLayers.find(l => l.uniqueKey === key);
      if (!layer || layer.isFolder) return;
    
      if (AppState.activeTableLayerKey === key && e.currentTarget) { closeTablePanel(); return; }
    
      closeTablePanel();
      AppState.activeTableLayerKey = key;
      AppState.tableShowAll = false;
      renderAddedLayers(); 
      
      if (!attributeTableContainer) return;
      attributeTableContainer.classList.remove('hidden');
      attributeTableContainer.classList.add('flex');
      
      attributeTableContainer.innerHTML = `
        <div class="table-resizer absolute top-0 left-0 w-full h-1.5 bg-gray-200 hover:bg-blue-400 dark:bg-gray-700 dark:hover:bg-blue-500 cursor-row-resize z-50 transition-colors" title="Drag to resize"></div>
        <div class="flex items-center justify-center h-full pt-2">
            <p class="text-xs text-gray-500 dark:text-gray-400 italic animate-pulse">Fetching attributes...</p>
        </div>`;
      attachTableResizerDom(attributeTableContainer, updateStacking);
      updateStacking(); // Ensure it pushes up smoothly immediately
    
      try {
        let features = [];
        
        if (layer.isLocalGeoJSON) {
          features = layer.geoJsonData.features || [];
        } else {
          if (!layer.exportUrl) throw new Error("No data endpoint available.");
          
          try {
              if (!layer.exportUrl.includes('WFS')) {
                  const countUrl = layer.exportUrl.split('query?')[0] + 'query?where=1=1&returnCountOnly=true&f=json';
                  const countRes = await fetch(`/proxy?url=${encodeURIComponent(countUrl)}`);
                  const countData = await countRes.json();
                  if (countData.count !== undefined) layer.remoteFeatureCount = countData.count;
              }
          } catch (e) {
              console.warn("Could not fetch total count", e);
          }
    
          let queryUrl = layer.exportUrl;
          if (queryUrl.includes('WFS')) queryUrl += '&maxFeatures=100';
          else if (queryUrl.includes('f=geojson')) queryUrl += '&resultRecordCount=100';
    
          const res = await fetch(`/proxy?url=${encodeURIComponent(queryUrl)}`);
          if (!res.ok) throw new Error
          const data = await res.json();
          features = data.features || [];
        }
    
        if (features.length === 0 || !features[0].properties || Object.keys(features[0].properties).length === 0) {
          attributeTableContainer.innerHTML = `
            <div class="table-resizer absolute top-0 left-0 w-full h-1.5 bg-gray-200 hover:bg-blue-400 dark:bg-gray-700 dark:hover:bg-blue-500 cursor-row-resize z-50 transition-colors" title="Drag to resize"></div>
            <div class="flex justify-between items-center mb-1 shrink-0 border-b border-gray-200 dark:border-gray-700 pb-1 pt-1.5">
                <div class="text-xs font-bold text-gray-700 dark:text-gray-200">${layer.displayName} Data</div>
                <button onclick="window.closeTablePanel()" class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 px-1"><i class="fa-solid fa-times"></i></button>
            </div>
            <p class="text-xs text-gray-500 dark:text-gray-400 italic p-2 text-center">No attributes available.</p>`;
          attachTableResizerDom(attributeTableContainer, updateStacking);
          return;
        }
    
        features.forEach((f, i) => {
            f.__row_id = i;
            if (!f.properties) f.properties = {};
            f.properties.__row_id = i; 
        });
        AppState.currentTableFeatures = features;
    
        const headerSet = new Set();
        features.forEach(f => {
            if (f.properties) Object.keys(f.properties).forEach(k => headerSet.add(k));
        });
        
        let headers = Array.from(headerSet).filter(h => h !== '__row_id');
        const bakedCols = ['COLOR_FILL', 'COLOR_OUTLINE', 'LATITUDE', 'LONGITUDE'];
        
        AppState.currentTableHeaders = headers
            .filter(h => !bakedCols.includes(h))
            .concat(headers.filter(h => bakedCols.includes(h)));
        
        AppState.tableSortCol = null;
        AppState.tableSortAsc = true;
        renderTableContent(layer.displayName);
    
        if (layer.mapLayer) {
            if (layer._onMapFeatureClick) {
                layer.mapLayer.off('click', layer._onMapFeatureClick);
            }
            
            layer._onMapFeatureClick = (clickEvt) => {
                if (AppState.activeTableLayerKey !== layer.uniqueKey) return;
                const rowId = clickEvt.layer?.feature?.properties?.__row_id ?? clickEvt.layer?.feature?.__row_id;
                
                if (rowId !== null && rowId !== undefined) {
                    highlightTableRow(rowId);
                }
            };
            layer.mapLayer.on('click', layer._onMapFeatureClick);
        }
    
      } catch (err) {
        console.error('Attribute table failed to load:', err);
        attributeTableContainer.innerHTML = `
          <div class="table-resizer absolute top-0 left-0 w-full h-1.5 bg-gray-200 hover:bg-blue-400 dark:bg-gray-700 dark:hover:bg-blue-500 cursor-row-resize z-50 transition-colors" title="Drag to resize"></div>
          <div class="flex justify-between items-center mb-1 shrink-0 border-b border-gray-200 dark:border-gray-700 pb-1 pt-1.5">
              <div class="text-xs font-bold text-gray-700 dark:text-gray-200">${layer.displayName} Data</div>
              <button onclick="window.closeTablePanel()" class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 px-1"><i class="fa-solid fa-times"></i></button>
          </div>
          <p class="text-xs text-red-500 dark:text-red-400 italic p-2 text-center">Failed to load attribute data.</p>`;
        attachTableResizerDom(attributeTableContainer, updateStacking);
      }
    };
    
    
    return { handleToggleTable, highlightTableRow, renderTableContent };
}
