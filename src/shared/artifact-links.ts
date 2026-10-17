import type { IBuffer } from '@xterm/xterm';

export interface ArtifactReference { start: number; end: number; reference: string }

export function findArtifactReferences(text: string): ArtifactReference[] {
  const results: ArtifactReference[] = [];
  const extension = String.raw`\.(?:markdown|json|html?|md)(?::\d+(?::\d+)?|#L\d+(?:C\d+)?)?`;
  const patterns = [
    new RegExp(String.raw`\[[^\]\r\n]+\]\(([^)\r\n]+${extension})\)`, 'gi'),
    new RegExp(String.raw`\x60([^\x60\r\n]+${extension})\x60`, 'gi'),
    new RegExp(String.raw`["']([^"'\r\n]+${extension})["']`, 'gi'),
    new RegExp(String.raw`(?<![\w/:])([a-z]:[\\/](?![\\/])[^\x60<>"'\r\n]*?${extension})(?=$|[\s),;\x60])`, 'gi'),
    new RegExp(String.raw`((?:file:///)?[^\s\x60<>"'()[\]]+?${extension})(?=$|[\s),;\x60])`, 'gi'),
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const reference = match[1];
      if (/^https?:/i.test(reference)) continue;
      const start = match.index + match[0].indexOf(reference);
      const end = start + reference.length;
      if (results.some(existing => start < existing.end && end > existing.start)) continue;
      results.push({ start, end, reference });
    }
  }
  return results.sort((a, b) => a.start - b.start);
}

export function terminalArtifactReferences(buffer: IBuffer, columns: number, row: number) {
  let first = row - 1;
  while (first > 0 && row - first < 16 && buffer.getLine(first)?.isWrapped) first--;
  let last = row - 1;
  while (last - first < 16 && buffer.getLine(last + 1)?.isWrapped) last++;
  let text = '';
  const positions: { start: { x: number; y: number }; end: { x: number; y: number } }[] = [];
  for (let y = first; y <= last; y++) {
    const line = buffer.getLine(y);
    if (!line) continue;
    for (let x = 0; x < columns; x++) {
      const cell = line.getCell(x);
      if (!cell || cell.getWidth() === 0) continue;
      const chars = cell.getChars() || ' ';
      text += chars;
      for (let index = 0; index < chars.length; index++) positions.push({
        start: { x: x + 1, y: y + 1 }, end: { x: x + cell.getWidth(), y: y + 1 },
      });
    }
  }
  return findArtifactReferences(text).flatMap(link => {
    const start = positions[link.start]?.start;
    const end = positions[link.end - 1]?.end;
    return start && end && start.y <= row && end.y >= row ? [{ reference: link.reference, range: { start, end } }] : [];
  });
}

export function resolveArtifactLink(documentPath: string, href: string): string {
  if (/^[a-z]:[\\/]/i.test(href) || /^file:/i.test(href)) return href;
  const normalized = documentPath.replace(/\\/g, '/');
  return new URL(href, normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`).href;
}

export function artifactHtmlDocument(content: string): string {
  return '<!doctype html><html><head><meta charset="utf-8">'
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:; font-src data:; form-action \'none\'; base-uri \'none\'">'
    + '</head><body>' + content + '</body></html>';
}
