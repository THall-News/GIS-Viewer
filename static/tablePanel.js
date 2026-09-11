// Attribute-table DOM controller. Data acquisition and map feature loading
// remain injectable so this module can be reused by manual and headless flows.
export function attachTableResizer(container, updateStacking = () => {}) {
    if (!container) return;
    container.style.position = 'relative';
    const resizer = container.querySelector('.table-resizer');
    if (!resizer) return;
    resizer.addEventListener('mousedown', event => {
        event.preventDefault();
        const startY = event.clientY;
        const startHeight = container.offsetHeight;
        document.body.classList.add('select-none', 'cursor-row-resize');
        const move = moveEvent => {
            const height = Math.max(100, Math.min(window.innerHeight - 40, startHeight + startY - moveEvent.clientY));
            container.style.maxHeight = 'none';
            container.style.height = `${height}px`;
            updateStacking();
        };
        const stop = () => {
            document.body.classList.remove('select-none', 'cursor-row-resize');
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', stop);
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', stop);
    });
}

export function attachColumnResizers(container) {
    if (!container) return;
    container.querySelectorAll('.tbl-header').forEach(header => {
        const resizer = header.querySelector('.col-resizer');
        if (!resizer) return;
        resizer.addEventListener('mousedown', event => {
            event.stopPropagation();
            event.preventDefault();
            const startX = event.pageX;
            const startWidth = header.offsetWidth;
            document.body.classList.add('select-none', 'cursor-col-resize');
            const move = moveEvent => {
                const width = startWidth + moveEvent.pageX - startX;
                if (width > 30) header.style.minWidth = header.style.width = header.style.maxWidth = `${width}px`;
            };
            const stop = () => {
                document.body.classList.remove('select-none', 'cursor-col-resize');
                document.removeEventListener('mousemove', move);
                document.removeEventListener('mouseup', stop);
            };
            document.addEventListener('mousemove', move);
            document.addEventListener('mouseup', stop);
        });
    });
}

export function createTablePanelController({ container, updateStacking, clearHighlight, renderLayers }) {
    return {
        close() {
            container?.classList.add('hidden');
            container?.classList.remove('flex');
            clearHighlight?.();
            renderLayers?.();
            updateStacking?.();
        },
        showLoading() {
            if (!container) return;
            container.classList.remove('hidden');
            container.classList.add('flex');
            container.innerHTML = '<div class="table-resizer absolute top-0 left-0 w-full h-1.5 cursor-row-resize"></div><div class="flex items-center justify-center h-full pt-2"><p class="text-xs italic animate-pulse">Fetching attributes...</p></div>';
            attachTableResizer(container, updateStacking);
        },
        attachResizers() {
            attachTableResizer(container, updateStacking);
            attachColumnResizers(container);
        }
    };
}
