import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import sanitizeHtml from 'sanitize-html';
import { parse } from 'csv-parse/sync';
import { artifactKind } from '../shared/artifact-formats';
import { readOfficePreview } from './office-preview';
import type { WorkspaceDirectory, WorkspaceFile } from '../shared/ipc-channels';

const MAX_ENTRIES = 500;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_PDF_BYTES = 20 * 1024 * 1024;

function contains(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

async function resolveScoped(root: string, reference: string): Promise<string> {
  const canonicalRoot = await fs.realpath(root);
  const candidate = path.resolve(root, reference);
  if (!contains(path.resolve(root), candidate) && !contains(canonicalRoot, candidate)) throw new Error('Path is outside the session workspace');
  const canonicalPath = await fs.realpath(candidate);
  if (!contains(canonicalRoot, canonicalPath)) throw new Error('Link points outside the session workspace');
  return canonicalPath;
}

export async function listWorkspaceDirectory(root: string, directory = ''): Promise<WorkspaceDirectory> {
  const folder = await resolveScoped(root, directory);
  const entries: WorkspaceDirectory['entries'] = [];
  let truncated = false;
  const handle = await fs.opendir(folder);
  for await (const entry of handle) {
    if (entries.length === MAX_ENTRIES) { truncated = true; break; }
    const entryPath = path.join(folder, entry.name);
    let isDirectory = entry.isDirectory();
    let blocked = false;
    if (entry.isSymbolicLink()) {
      try {
        isDirectory = (await fs.stat(await resolveScoped(root, entryPath))).isDirectory();
      } catch {
        blocked = true;
      }
    }
    entries.push({ name: entry.name, path: entryPath, directory: isDirectory, blocked });
  }
  entries.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
  return { entries, truncated };
}

export async function readWorkspaceFile(root: string, reference: string, artifactRoot?: string): Promise<WorkspaceFile> {
  let target = reference.trim().replace(/^<|>$/g, '').replace(/#L\d+(?:C\d+)?$/i, '').replace(/:\d+(?::\d+)?$/, '');
  if (/^file:/i.test(target)) target = fileURLToPath(target);
  if (!target || target.includes('\0')) throw new Error('Invalid file reference');
  if (/^[a-z][a-z\d+.-]*:/i.test(target) && !/^[a-z]:[\\/]/i.test(target)) {
    throw new Error('Only local file references can be previewed');
  }
  const artifactCandidate = artifactRoot && path.isAbsolute(target) && contains(path.resolve(artifactRoot), path.resolve(target));
  let resolved: string;
  try {
    resolved = await resolveScoped(artifactCandidate && artifactRoot ? artifactRoot : root, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !artifactRoot || !/^(?:\.[\\/])?files[\\/]/.test(target)) throw error;
    resolved = await resolveScoped(artifactRoot, target.replace(/^(?:\.[\\/])?files[\\/]/, ''));
  }
  const extension = path.extname(resolved).toLowerCase();
  const kind = artifactKind(extension);
  if (!kind) throw new Error('Unsupported preview format. Use a text/code, CSV/TSV, DOC/DOCX, XLSX, Mermaid, JSON, Markdown, HTML or PDF file.');
  const handle = await fs.open(resolved, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('The selected path is not a regular file');
    const binary = kind === 'pdf' || kind === 'document' || kind === 'workbook';
    const limit = binary ? MAX_PDF_BYTES : MAX_FILE_BYTES;
    const limitError = `File exceeds the ${binary ? '20' : '1'} MiB preview limit`;
    if (stat.size > limit) throw new Error(limitError);
    const buffer = Buffer.alloc(limit + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const next = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (!next.bytesRead) break;
      bytesRead += next.bytesRead;
    }
    if (bytesRead > limit) throw new Error(limitError);
    const bytes = buffer.subarray(0, bytesRead);
    if (kind === 'pdf') {
      if (bytes.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('File is not a valid PDF document');
      return { path: resolved, name: path.basename(resolved), kind, base64: bytes.toString('base64') };
    }
    if (kind === 'document' || kind === 'workbook') {
      return { path: resolved, name: path.basename(resolved), ...await readOfficePreview(bytes, extension) };
    }
    let content: string;
    const encoding = bytes[0] === 255 && bytes[1] === 254 ? 'utf-16le'
      : bytes[0] === 254 && bytes[1] === 255 ? 'utf-16be' : 'utf-8';
    try { content = new TextDecoder(encoding, { fatal: true }).decode(bytes); }
    catch { throw new Error('File is not valid UTF-8 or BOM-marked UTF-16 text'); }
    if (content.includes('\0')) throw new Error('Binary files cannot be previewed as text');
    if (kind === 'table') {
      const records: string[][] = parse(content, {
        delimiter: extension === '.tsv' ? '\t' : ',', bom: true, skip_empty_lines: true,
        relax_column_count: true, max_record_size: 128 * 1024, to: 1001,
      });
      let cells = 20000;
      let truncated = records.length > 1000 || records.some(row => row.length > 100);
      const rows: string[][] = [];
      for (const row of records.slice(0, 1000)) {
        const values = row.slice(0, 100);
        if (values.length > cells) { truncated = true; break; }
        rows.push(values);
        cells -= values.length;
      }
      return { path: resolved, name: path.basename(resolved), kind, sheet: { name: path.basename(resolved), rows, truncated } };
    }
    if (kind === 'html') content = sanitizeHtml(content, {
      allowedTags: false, allowedAttributes: false, allowVulnerableTags: true,
      allowedSchemesByTag: { img: ['data', 'http', 'https'] },
      exclusiveFilter: frame => ['script', 'iframe', 'frame', 'object', 'embed', 'base', 'meta'].includes(frame.tag),
      transformTags: {
        '*': (tagName, attribs) => {
          for (const attribute of Object.keys(attribs)) {
            if (attribute.startsWith('on') || ['href', 'xlink:href', 'action', 'formaction', 'autofocus'].includes(attribute)) delete attribs[attribute];
          }
          return { tagName, attribs };
        },
      },
    });
    return { path: resolved, name: path.basename(resolved), kind, content };
  } finally {
    await handle.close();
  }
}
