class FileUploader {
    constructor() {
        this.dropZone = document.getElementById('drop-zone');
        this.fileInput = document.getElementById('file-input');
        this.fileInfo = document.getElementById('file-info');
        this.fileName = document.getElementById('file-name');
        this.fileSize = document.getElementById('file-size');
        this.removeBtn = document.getElementById('file-remove');
        this.selectedFile = null;
        this.onFileSelected = null;
        this.onFileRemoved = null;

        this._initEvents();
    }

    _initEvents() {
        ['dragenter', 'dragover'].forEach(evt => {
            this.dropZone.addEventListener(evt, (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.dropZone.classList.add('drag-active');
            });
        });

        ['dragleave', 'drop'].forEach(evt => {
            this.dropZone.addEventListener(evt, (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.dropZone.classList.remove('drag-active');
            });
        });

        this.dropZone.addEventListener('drop', (e) => {
            const files = e.dataTransfer.files;
            if (files.length > 0) this._handleFile(files[0]);
        });

        this.fileInput.addEventListener('change', (e) => {
            if (e.target.files.length > 0) this._handleFile(e.target.files[0]);
        });

        this.removeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.clear();
            if (this.onFileRemoved) this.onFileRemoved();
        });

        this.dropZone.addEventListener('click', (e) => {
            if (e.target === this.removeBtn) return;
            if (!this.selectedFile) this.fileInput.click();
        });
    }

    _handleFile(file) {
        this.selectedFile = file;
        this.fileName.textContent = file.name;
        this.fileSize.textContent = `(${this._formatSize(file.size)})`;
        this.fileInfo.hidden = false;

        // Show warning for large files in browser mode
        const warning = document.getElementById('file-size-warning');
        if (warning) {
            warning.hidden = file.size < 2 * 1024 * 1024 * 1024; // 2 GB
        }

        if (this.onFileSelected) this.onFileSelected(file);
    }

    clear() {
        this.selectedFile = null;
        this.fileInput.value = '';
        this.fileInfo.hidden = true;
        const warning = document.getElementById('file-size-warning');
        if (warning) warning.hidden = true;
    }

    _formatSize(bytes) {
        if (bytes >= 1e9) return (bytes / 1e9).toFixed(2) + ' GB';
        if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + ' MB';
        return (bytes / 1e3).toFixed(0) + ' KB';
    }
}
