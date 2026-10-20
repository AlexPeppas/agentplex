import { useEffect, useRef, useState } from 'react';
import mermaid from 'mermaid';
import DOMPurify from 'dompurify';
import { artifactHtmlDocument } from '../../shared/artifact-links';

mermaid.initialize({
  startOnLoad: false, securityLevel: 'strict', theme: 'neutral', maxTextSize: 50000,
  maxEdges: 500, suppressErrorRendering: true, htmlLabels: false, flowchart: { htmlLabels: false },
});
let renderQueue: Promise<unknown> = Promise.resolve();
let nextDiagram = 0;

export function MermaidPreview({ content }: { content: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  const [source, setSource] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setError('');
    if (host.current) host.current.replaceChildren();
    const target = host.current;
    const render = async () => {
      if (cancelled) return;
      try {
        if (content.length > 50000) throw new Error('Mermaid diagrams are limited to 50,000 characters');
        // File directives must not override the fixed renderer configuration.
        if (/^\s*---|%%\{|^\s*(?:click|link)\s|https?:|url\s*\(|@import/im.test(content)) {
          throw new Error('Mermaid configuration directives and interactive links are disabled in previews');
        }
        const { svg } = await mermaid.render(`artifact-diagram-${++nextDiagram}`, content);
        if (cancelled || !target) return;
        const sanitized = DOMPurify.sanitize(svg, {
          USE_PROFILES: { svg: true, svgFilters: true },
          FORBID_TAGS: ['a', 'image', 'foreignObject', 'script'],
          FORBID_ATTR: ['href', 'xlink:href'],
        });
        const frame = document.createElement('iframe');
        frame.title = 'Mermaid diagram';
        frame.setAttribute('sandbox', '');
        frame.referrerPolicy = 'no-referrer';
        frame.style.cssText = 'border:0;width:100%;height:600px;background:white';
        frame.srcdoc = artifactHtmlDocument(sanitized);
        target.replaceChildren(frame);
      } catch (reason) {
        if (!cancelled) setError(`Cannot render Mermaid: ${reason instanceof Error ? reason.message : String(reason)}`);
      }
    };
    renderQueue = renderQueue.then(render, render);
    return () => { cancelled = true; };
  }, [content]);
  return (
    <div className="overflow-auto flex-1 min-h-0 p-4">
      <button className="text-xs text-accent underline mb-3" onClick={() => setSource(!source)}>
        {source ? 'Show diagram' : 'Show source'}
      </button>
      {error && <div role="alert" className="text-error whitespace-pre-wrap mb-3">{error}</div>}
      <div ref={host} className={`artifact-mermaid bg-white text-black p-3 rounded ${source || error ? 'hidden' : ''}`} />
      {(source || error) && <pre className="text-xs whitespace-pre-wrap break-words">{content}</pre>}
    </div>
  );
}
