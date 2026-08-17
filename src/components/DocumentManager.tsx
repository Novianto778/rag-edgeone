import { useState, useEffect, useRef, ChangeEvent, DragEvent, useCallback } from "react";
import { useT } from "../i18n";
import "./DocumentManager.css";

interface Props {
  conversationId?: string;
}

interface UploadingFile {
  id: string;
  name: string;
  size: number;
  progress: number;
  status: "uploading" | "ready" | "error";
  errorMessage?: string;
}

interface CatalogDoc {
  docId: string;
  docName: string;
  storedName?: string;
  fileSize: number;
  uploadedAt: string;
  type: string;
  status?: string;
  chunkCount?: number;
}

export default function DocumentManager({}: Props) {
  const { t } = useT();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [loadingDocs, setLoadingDocs] = useState(true);
  const [uploadList, setUploadList] = useState<UploadingFile[]>([]);
  const [catalogDocs, setCatalogDocs] = useState<CatalogDoc[]>([]);

  // Fetch real document list from backend endpoint
  const fetchCatalog = useCallback(async () => {
    setLoadingDocs(true);
    try {
      const res = await fetch("/list-documents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.status === "success" && Array.isArray(data.documents)) {
        setCatalogDocs(data.documents);
      }
    } catch (err) {
      console.warn("Failed to fetch document catalog from /list-documents:", err);
    } finally {
      setLoadingDocs(false);
    }
  }, []);

  useEffect(() => {
    fetchCatalog();
  }, [fetchCatalog]);

  const handleFiles = async (files: FileList | File[]) => {
    const validFiles = Array.from(files).filter(
      (f) => f.name.endsWith(".pdf") || f.name.endsWith(".docx")
    );

    if (validFiles.length === 0) {
      alert("Please select a valid PDF or DOCX file.");
      return;
    }

    for (const file of validFiles) {
      const uploadId = crypto.randomUUID();
      const newUpload: UploadingFile = {
        id: uploadId,
        name: file.name,
        size: file.size,
        progress: 30,
        status: "uploading",
      };

      setUploadList((prev) => [newUpload, ...prev]);

      try {
        const formData = new FormData();
        formData.append("file", file);

        const res = await fetch("/upload", {
          method: "POST",
          body: formData,
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || `HTTP ${res.status}`);
        }

        setUploadList((prev) =>
          prev.map((u) =>
            u.id === uploadId ? { ...u, progress: 100, status: "ready" } : u
          )
        );

        // Refresh dynamic document list from server
        fetchCatalog();
      } catch (err: any) {
        console.error("Upload error:", err);
        setUploadList((prev) =>
          prev.map((u) =>
            u.id === uploadId
              ? { ...u, status: "error", errorMessage: err.message || "Upload failed" }
              : u
          )
        );
      }
    }
  };

  const handleDelete = async (docId: string, storedName?: string) => {
    if (!confirm("Are you sure you want to delete this document from the knowledge base?")) return;

    try {
      const res = await fetch("/delete-document", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ docId, storedName }),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      if (data.status === "success") {
        setCatalogDocs((prev) => prev.filter((d) => d.docId !== docId));
      }
    } catch (err) {
      alert("Failed to delete document.");
      console.error("Delete error:", err);
    }
  };

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFiles(e.dataTransfer.files);
    }
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFiles(e.target.files);
    }
  };

  const formatBytes = (bytes: number) => {
    if (!bytes) return "0 B";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className="doc-manager-panel">
      {/* ── Upload Box ── */}
      <div className="doc-upload-card">
        <h3 className="doc-upload-title">{t("upload.title")}</h3>
        <p className="doc-upload-subtitle">{t("upload.hint")}</p>

        <div
          className={`doc-dropzone ${isDragging ? "dragging" : ""}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.docx"
            multiple
            style={{ display: "none" }}
            onChange={handleFileChange}
          />
          <div className="dropzone-icon">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
          </div>
          <p className="dropzone-prompt">{t("upload.dragDrop")}</p>
          <button type="button" className="btn-browse-files">
            {t("upload.browse")}
          </button>
        </div>

        {/* Upload Progress List */}
        {uploadList.length > 0 && (
          <div className="upload-progress-list">
            {uploadList.map((item) => (
              <div key={item.id} className="upload-item-card">
                <div className="upload-item-header">
                  <div className="upload-file-info">
                    <svg className="file-type-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                    </svg>
                    <span className="file-name">{item.name}</span>
                    <span className="file-size">({formatBytes(item.size)})</span>
                  </div>
                  <span className={`status-badge ${item.status}`}>
                    {item.status === "uploading" ? "Uploading to EdgeOne..." : item.status === "ready" ? "Uploaded" : "Error"}
                  </span>
                </div>
                <div className="progress-bar-bg">
                  <div className="progress-bar-fill" style={{ width: `${item.progress}%` }} />
                </div>
                {item.errorMessage && <p className="upload-error-msg">{item.errorMessage}</p>}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Document Catalog Section ── */}
      <div className="doc-catalog-section">
        <div className="catalog-header">
          <h3>{t("docs.catalog")}</h3>
        </div>

        {loadingDocs ? (
          <div className="catalog-empty-card">Loading documents...</div>
        ) : catalogDocs.length === 0 ? (
          <div className="catalog-empty-card">
            {t("docs.empty")}
          </div>
        ) : (
          <div className="catalog-grid">
            {catalogDocs.map((doc) => (
              <div key={doc.docId} className="doc-item-card">
                <div className="doc-card-badge">{doc.type || "PDF"}</div>
                <div className="doc-card-body">
                  <div className="doc-card-top-row">
                    <h4 className="doc-title">{doc.docName}</h4>
                    <button
                      type="button"
                      className="doc-delete-btn"
                      title="Delete document"
                      onClick={() => handleDelete(doc.docId, doc.storedName)}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                    </button>
                  </div>
                  <p className="doc-desc">ID: {doc.docId}</p>
                  <div className="doc-meta-row">
                    <span className="meta-tag">⚡ Ready</span>
                    {doc.chunkCount != null && doc.chunkCount > 0 && (
                      <span className="meta-tag">📑 {doc.chunkCount} chunks</span>
                    )}
                    {doc.fileSize > 0 && (
                      <span className="meta-tag">💾 {formatBytes(doc.fileSize)}</span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
