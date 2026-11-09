import type { IBuffer } from '@xterm/xterm';
import { ARTIFACT_EXTENSIONS } from './artifact-formats';

export interface ArtifactReference { start: number; end: number; reference: string }

export function findArtifactReferences(text: string): ArtifactReference[] {
  const results: ArtifactReference[] = [];
  const extensions = Object.keys(ARTIFACT_EXTENSIONS).sort((a, b) => b.length - a.length).join('|');
  const extension = String.raw`\.(?:${extensions})(?::\d+(?::\d+)?|#L\d+(?:C\d+)?)?`;
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
  const isHardWrap = (y: number) => {
    const previous = buffer.getLine(y - 1);
    const current = buffer.getLine(y);
    if (!previous || !current || current.isWrapped) return false;
    const before = previous.translateToString(true).trimEnd();
    const after = current.translateToString(true);
    const indent = after.match(/^ +/)?.[0].length ?? 0;
    if (!indent || indent > 8 || !after.trim()) return false;
    let end = columns;
    while (end > 0 && !previous.getCell(end - 1)?.getChars().trim()) end--;
    if (end < columns - 2) return false;
    // CLI renderers also wrap explicitly with CRLF and continuation indentation.
    // Never extend a completed file reference into the next independent line.
    return !findArtifactReferences(before).some(link => link.end === before.length);
  };
  const collect = (hardWraps: boolean) => {
    const continues = (y: number) => !!buffer.getLine(y)?.isWrapped || (hardWraps && isHardWrap(y));
    let first = row - 1;
    while (first > 0 && row - first < 16 && continues(first)) first--;
    let last = row - 1;
    while (last - first < 16 && continues(last + 1)) last++;
    let text = '';
    const breaks: number[] = [];
    const positions: { start: { x: number; y: number }; end: { x: number; y: number } }[] = [];
    for (let y = first; y <= last; y++) {
      const line = buffer.getLine(y);
      if (!line) continue;
      let startColumn = 0;
      let endColumn = columns;
      if (y > first && hardWraps && isHardWrap(y)) {
        breaks.push(text.length);
        while (startColumn < columns && !line.getCell(startColumn)?.getChars().trim()) startColumn++;
      }
      if (y < last && hardWraps && isHardWrap(y + 1)) {
        while (endColumn > startColumn && !line.getCell(endColumn - 1)?.getChars().trim()) endColumn--;
      }
      for (let x = startColumn; x < endColumn; x++) {
        const cell = line.getCell(x);
        if (!cell || cell.getWidth() === 0) continue;
        const chars = cell.getChars() || ' ';
        text += chars;
        for (let index = 0; index < chars.length; index++) positions.push({
          start: { x: x + 1, y: y + 1 }, end: { x: x + cell.getWidth(), y: y + 1 },
        });
      }
    }
    if (hardWraps && !breaks.length) return [];
    return findArtifactReferences(text).flatMap(link => {
      if (hardWraps && (!breaks.some(offset => link.start < offset && link.end > offset) ||
          !/^(?:[a-z]:[\\/]|file:|[\\/]|[\w.-]+[\\/])/i.test(link.reference))) return [];
      const start = positions[link.start]?.start;
      const end = positions[link.end - 1]?.end;
      return start && end && start.y <= row && end.y >= row ? [{ reference: link.reference, range: { start, end } }] : [];
    });
  };
  const recovered = collect(true);
  return [...recovered, ...collect(false).filter(link => !recovered.some(full =>
    full.range.start.y <= link.range.start.y && full.range.end.y >= link.range.end.y &&
    (full.range.start.y < link.range.start.y || full.range.start.x <= link.range.start.x) &&
    (full.range.end.y > link.range.end.y || full.range.end.x >= link.range.end.x)))];
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
