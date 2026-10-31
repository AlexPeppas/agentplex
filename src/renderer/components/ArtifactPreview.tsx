import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { WorkspaceFile } from '../../shared/ipc-channels';
import { artifactHtmlDocument, resolveArtifactLink } from '../../shared/artifact-links';
import { TablePreview } from './TablePreview';

const PdfPreview = lazy(() => import('./PdfPreview').then(module => ({ default: module.PdfPreview })));
const MermaidPreview = lazy(() => import('./MermaidPreview').then(module => ({ default: module.MermaidPreview })));

interface ArtifactPreviewProps {
  sessionId: string; cwd: string; reference: string; onOpenFile: (reference: string) => void;
}

interface PreviewView {
  page: number;
  scale: number;
  sheet: number;
}

const INITIAL_VIEW: PreviewView = { page: 1, scale: 1, sheet: 0 };

export function ArtifactPreview({ active = true, ...props }: ArtifactPreviewProps & { active?: boolean }) {
  const [view, setView] = useState(INITIAL_VIEW);
  const updateView = useCallback((patch: Partial<PreviewView>) => setView(previous => ({ ...previous, ...patch })), []);
  return active ? <LoadedArtifactPreview {...props} view={view} onViewChange={updateView} /> : null;
}

function LoadedArtifactPreview({ sessionId, cwd, reference, onOpenFile, view, onViewChange }: ArtifactPreviewProps & {
  view: PreviewView; onViewChange: (patch: Partial<PreviewView>) => void;
}) {
  const [file, setFile] = useState<WorkspaceFile | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const setPage = useCallback((page: number) => onViewChange({ page }), [onViewChange]);
  const setScale = useCallback((scale: number) => onViewChange({ scale }), [onViewChange]);
  const setSheet = useCallback((sheet: number) => onViewChange({ sheet }), [onViewChange]);
  useEffect(() => {
    let cancelled = false;
    setFile(null);
    setError('');
    window.agentPlex.readWorkspaceFile(sessionId, reference)
      .then(value => { if (!cancelled) setFile(value); })
      .catch(reason => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { cancelled = true; };
  }, [sessionId, cwd, reference, revision]);
  let json = '';
  let jsonError = '';
  if (file?.kind === 'json') {
    try { json = JSON.stringify(JSON.parse(file.content), null, 2); }
    catch (reason) { jsonError = `Invalid JSON: ${reason instanceof Error ? reason.message : String(reason)}`; json = file.content; }
  }
  return (
    <section aria-label="File preview" className="h-full flex flex-col min-h-0 text-fg bg-surface">
      <div className="flex shrink-0 items-center gap-2 px-3 py-2 text-xs border-b border-border">
        <span className="truncate flex-1" title={file?.path || reference}>{file?.path || reference}</span>
        <span className="text-fg-muted">Read only</span>
        <button onClick={() => { onViewChange(INITIAL_VIEW); setRevision(revision + 1); }} title="Reload file">Reload</button>
      </div>
      {error && <div role="alert" className="p-4 text-red-400 break-words">{error}</div>}
      {!file && !error && <div className="p-4 text-fg-muted">Loading file...</div>}
      {file?.kind === 'text' && <pre className="overflow-auto p-4 text-xs whitespace-pre-wrap break-words">{file.content}</pre>}
      {file?.kind === 'table' && <TablePreview sheets={[file.sheet]} selected={view.sheet} onSelect={setSheet} />}
      {file?.kind === 'workbook' && <TablePreview sheets={file.sheets} truncated={file.truncated} selected={view.sheet} onSelect={setSheet} />}
      {file?.kind === 'document' && <>
        <div className="shrink-0 max-h-24 overflow-auto text-xs text-fg-muted px-3 py-2">
          {file.warnings.map((warning, index) => <p key={index}>{warning}</p>)}
        </div>
        {file.format === 'text' ? <pre className="overflow-auto p-4 text-sm whitespace-pre-wrap break-words">{file.content}</pre>
          : <iframe title={`Word preview: ${file.name}`} sandbox="" referrerPolicy="no-referrer"
            className="flex-1 w-full border-0 bg-white" srcDoc={artifactHtmlDocument(file.content)} />}
      </>}
      {file?.kind === 'mermaid' && <Suspense fallback={<div className="p-4 text-fg-muted">Loading diagram renderer...</div>}>
        <MermaidPreview key={`${file.path}:${revision}`} content={file.content} />
      </Suspense>}
      {file?.kind === 'pdf' && <Suspense fallback={<div className="p-4 text-fg-muted">Loading PDF reader...</div>}>
        <PdfPreview key={revision} base64={file.base64} page={view.page} scale={view.scale} onPageChange={setPage} onScaleChange={setScale} />
      </Suspense>}
      {file?.kind === 'json' && <div className="overflow-auto p-4 text-xs">
        {jsonError && <div role="alert" className="text-red-400 mb-3">{jsonError}</div>}
        <pre>{json}</pre>
      </div>}
      {file?.kind === 'markdown' && (
        <article className="artifact-markdown overflow-auto p-4 text-sm leading-relaxed">
          <ReactMarkdown skipHtml remarkPlugins={[remarkGfm]} urlTransform={url =>
            /^(?:https?:|file:)/i.test(url) || /^[a-z]:[\\/]/i.test(url) || !/^[a-z][a-z\d+.-]*:/i.test(url) ? url : ''
          } components={{
            pre: ({ children, node }) => node?.children.some(child => child.type === 'element'
              && child.tagName === 'code' && Array.isArray(child.properties.className)
              && child.properties.className.includes('language-mermaid'))
              ? <div>{children}</div> : <pre>{children}</pre>,
            code: ({ className, children }) => className === 'language-mermaid'
              ? <Suspense fallback={<span>Loading diagram renderer...</span>}><MermaidPreview content={String(children)} /></Suspense>
              : <code className={className}>{children}</code>,
            a: ({ href, children }) => <a href={href} className="text-accent underline" onClick={event => {
              event.preventDefault();
              if (!href || href.startsWith('#')) return;
              if (/^https?:/i.test(href)) {
                window.agentPlex.openExternal(href).catch(reason => setError(String(reason)));
              } else onOpenFile(resolveArtifactLink(file.path, href));
            }}>{children}</a>,
            img: ({ alt }) => <span className="text-fg-muted">[Image: {alt || 'not loaded in preview'}]</span>,
          }}>{file.content}</ReactMarkdown>
        </article>
      )}
      {file?.kind === 'html' && <>
        <div className="text-xs text-fg-muted px-3 py-1">Sandboxed HTML: scripts, forms, navigation and network resources disabled.</div>
        <iframe title={`HTML preview: ${file.name}`} sandbox="" referrerPolicy="no-referrer"
          className="flex-1 w-full border-0 bg-white" srcDoc={artifactHtmlDocument(file.content)} />
      </>}
    </section>
  );
}
