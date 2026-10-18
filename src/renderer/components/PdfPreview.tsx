import { useEffect, useRef, useState } from 'react';
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = workerUrl;
const MAX_CANVAS_PIXELS = 16 * 1024 * 1024;

export function PdfPreview({ base64 }: { base64: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [scale, setScale] = useState(1);
  const [error, setError] = useState('');
  const [rendering, setRendering] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
    const assets = new URL('pdfjs/', window.location.href).href;
    const loading = getDocument({
      data: bytes,
      cMapUrl: `${assets}cmaps/`,
      standardFontDataUrl: `${assets}standard_fonts/`,
      wasmUrl: `${assets}wasm/`,
      useWorkerFetch: false,
      useSystemFonts: true,
      stopAtErrors: true,
      maxImageSize: MAX_CANVAS_PIXELS,
      canvasMaxAreaInBytes: MAX_CANVAS_PIXELS * 4,
    });
    setDocument(null);
    setPage(1);
    setError('');
    setRendering(true);
    loading.onPassword = () => {
      if (!cancelled) setError('Password-protected PDFs cannot be previewed. Open an unlocked copy.');
      void loading.destroy().catch(reason => console.error('[pdf] Cannot close encrypted document:', reason));
    };
    loading.promise.then(value => {
      if (!cancelled) setDocument(value);
    }).catch(reason => {
      if (!cancelled) setError(previous => previous || `Cannot open PDF: ${reason instanceof Error ? reason.message : String(reason)}`);
    });
    return () => {
      cancelled = true;
      void loading.destroy().catch(reason => console.error('[pdf] Cannot close document:', reason));
    };
  }, [base64]);

  useEffect(() => {
    if (!document || !canvasRef.current) return;
    let cancelled = false;
    let task: RenderTask | undefined;
    setRendering(true);
    setError('');
    // A fresh canvas prevents a cancelled render from colliding with the next one.
    const canvas = canvasRef.current;
    document.getPage(page).then(async pdfPage => {
      if (cancelled) return;
      const viewport = pdfPage.getViewport({ scale });
      const density = Math.min(window.devicePixelRatio || 1, 2);
      const ratio = Math.min(density, Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height)));
      if (!Number.isFinite(ratio) || ratio <= 0 || viewport.width > 32767 || viewport.height > 32767) {
        throw new Error('PDF page dimensions exceed the preview limit');
      }
      canvas.width = Math.max(1, Math.floor(viewport.width * ratio));
      canvas.height = Math.max(1, Math.floor(viewport.height * ratio));
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      task = pdfPage.render({ canvas, viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
      await task.promise;
      if (!cancelled) setRendering(false);
    }).catch(reason => {
      if (!cancelled) {
        setError(`Cannot render PDF page: ${reason instanceof Error ? reason.message : String(reason)}`);
        setRendering(false);
      }
    });
    return () => { cancelled = true; task?.cancel(); };
  }, [document, page, scale]);

  return (
    <div className="flex flex-col flex-1 min-h-0" aria-label="PDF reader">
      <div className="flex items-center gap-3 p-2 text-xs border-b border-border">
        <button disabled={!document || page === 1} onClick={() => setPage(page - 1)}>Previous page</button>
        <span aria-live="polite">Page {page} of {document?.numPages ?? '...'}</span>
        <button disabled={!document || page === document.numPages} onClick={() => setPage(page + 1)}>Next page</button>
        <label className="ml-auto">Zoom <select aria-label="PDF zoom" value={scale} onChange={event => setScale(Number(event.target.value))}>
          {[0.5, 0.75, 1, 1.25, 1.5, 2].map(value => <option key={value} value={value}>{value * 100}%</option>)}
        </select></label>
      </div>
      {error && <div role="alert" className="p-4 text-red-400">{error}</div>}
      {!error && rendering && <div role="status" className="px-3 py-1 text-xs text-fg-muted">Loading PDF page...</div>}
      <div className="flex-1 min-h-0 overflow-auto p-3">
        <canvas key={`${page}:${scale}:${base64.length}`} ref={canvasRef} aria-label={`PDF page ${page}`} role="img"
          data-rendered={!rendering && !error} className="bg-white" style={{ visibility: rendering || error ? 'hidden' : 'visible' }} />
      </div>
    </div>
  );
}
