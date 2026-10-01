// src/pages/Uploads.jsx
import React from 'react';
import { Topbar } from '../components/Layout';
import { Card, CardHead, Btn, Spinner, Empty, ErrorBanner } from '../components/ui';
import { getUploadUrl, uploadFileToS3, fetchUploads, deleteUpload } from '../api/client';
import { RefreshControl } from '../components/sections';
import { usePageRefresh } from '../hooks/usePageRefresh';
import { useUnsavedChanges } from '../hooks/useNavigation';

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatDate(iso) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default function Uploads() {
  const [files, setFiles] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);
  const [dragOver, setDragOver] = React.useState(false);
  const [inFlight, setInFlight] = React.useState([]); // [{name, progress, error}]
  const fileInputRef = React.useRef(null);
  const [lastUpdated, setLastUpdated] = React.useState(null);

  const loadFiles = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchUploads();
      setFiles(res.files || []);
      setLastUpdated(new Date());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { loadFiles(); }, [loadFiles]);
  usePageRefresh(loadFiles);
  const uploading = inFlight.some((f) => !f.error && f.progress < 100);
  useUnsavedChanges(uploading, 'A file is still uploading. Leaving now cancels the upload.');

  async function handleFiles(fileList) {
    const list = Array.from(fileList || []);
    if (!list.length) return;

    for (const file of list) {
      const entry = { name: file.name, progress: 0, error: null };
      setInFlight(prev => [...prev, entry]);

      try {
        const { upload_url } = await getUploadUrl(file.name, file.type);
        await uploadFileToS3(upload_url, file, (pct) => {
          setInFlight(prev => prev.map(f => f.name === entry.name ? { ...f, progress: pct } : f));
        });
        setInFlight(prev => prev.filter(f => f.name !== entry.name));
        await loadFiles();
      } catch (e) {
        setInFlight(prev => prev.map(f => f.name === entry.name ? { ...f, error: e.message } : f));
      }
    }
  }

  async function handleDelete(key) {
    if (!window.confirm('Delete this file? This cannot be undone.')) return;
    try {
      await deleteUpload(key);
      setFiles(prev => prev.filter(f => f.key !== key));
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <div className="rs-page">
      <Topbar
        title="Uploads"
        subtitle="Upload files directly to S3 — stored in the job-scheduler bucket"
        actions={<>
          <RefreshControl onRefresh={loadFiles} refreshing={loading} lastUpdated={lastUpdated} />
          <Btn variant="primary" size="sm" onClick={() => fileInputRef.current?.click()}>Upload file</Btn>
        </>}
      />
      <div className="rs-page-body">
        {error && <ErrorBanner message={error} />}

        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => { handleFiles(e.target.files); e.target.value = ''; }}
        />

        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFiles(e.dataTransfer.files); }}
          onClick={() => fileInputRef.current?.click()}
          style={{
            border: `2px dashed ${dragOver ? 'var(--accent, #365D9D)' : '#C9D1DC'}`,
            borderRadius: 'var(--radius-lg)',
            padding: '36px 24px',
            textAlign: 'center',
            cursor: 'pointer',
            marginBottom: 20,
            background: dragOver ? 'rgba(73,149,255,0.06)' : '#FAFBFC',
            transition: 'all 0.15s',
          }}
        >
          <div style={{ fontSize: 14, color: '#202938', fontWeight: 600, marginBottom: 4 }}>
            Drag &amp; drop files here, or click to browse
          </div>
          <div style={{ fontSize: 12, color: '#657185' }}>
            Files upload directly to S3 via a presigned URL — nothing passes through this server.
          </div>
        </div>

        {inFlight.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20 }}>
            {inFlight.map((f) => (
              <Card key={f.name}>
                <div style={{ padding: '10px 16px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 6 }}>
                    <span style={{ color: '#202938', fontWeight: 500 }}>{f.name}</span>
                    <span style={{ color: f.error ? '#DC2626' : '#657185' }}>
                      {f.error ? 'Failed' : `${f.progress}%`}
                    </span>
                  </div>
                  {!f.error ? (
                    <div style={{ height: 4, background: '#DCE2EA', borderRadius: 2, overflow: 'hidden' }}>
                      <div style={{
                        height: '100%', width: `${f.progress}%`,
                        background: '#365D9D', transition: 'width 0.15s',
                      }} />
                    </div>
                  ) : (
                    <div style={{ fontSize: 12, color: '#DC2626' }}>{f.error}</div>
                  )}
                </div>
              </Card>
            ))}
          </div>
        )}

        <Card>
          <CardHead>
            <div style={{ fontSize: 'var(--fs-section-title)', fontWeight: 600, color: '#202938' }}>
              Files {files.length > 0 && `(${files.length})`}
            </div>
            <Btn variant="default" size="sm" onClick={loadFiles}>Refresh</Btn>
          </CardHead>

          {loading ? (
            <div style={{ padding: 32, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
          ) : files.length === 0 ? (
            <Empty message="No files uploaded yet." />
          ) : (
            <div>
              {files.map((f) => (
                <div key={f.key} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '12px 18px', borderBottom: '1px solid #DCE2EA', fontSize: 13,
                }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ color: '#202938', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {f.filename}
                    </div>
                    <div style={{ color: '#657185', fontSize: 12, marginTop: 2 }}>
                      {formatBytes(f.size)} · {formatDate(f.last_modified)}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                    <Btn variant="default" size="sm" onClick={() => window.open(f.download_url, '_blank')}>
                      Download
                    </Btn>
                    <Btn variant="danger" size="sm" onClick={() => handleDelete(f.key)}>
                      Delete
                    </Btn>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
