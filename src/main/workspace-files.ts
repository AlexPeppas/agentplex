import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkspaceDirectory, WorkspaceFile } from '../shared/ipc-channels';

const MAX_ENTRIES = 500;
const MAX_FILE_BYTES = 1024 * 1024;

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
  const kind = extension === '.json' ? 'json' : extension === '.md' || extension === '.markdown' ? 'markdown'
    : extension === '.html' || extension === '.htm' ? 'html' : null;
  if (!kind) throw new Error('Preview supports JSON, Markdown and HTML files only');
  const handle = await fs.open(resolved, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('The selected path is not a regular file');
    if (stat.size > MAX_FILE_BYTES) throw new Error('File exceeds the 1 MiB preview limit');
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const next = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (!next.bytesRead) break;
      bytesRead += next.bytesRead;
    }
    if (bytesRead > MAX_FILE_BYTES) throw new Error('File exceeds the 1 MiB preview limit');
    const bytes = buffer.subarray(0, bytesRead);
    if (bytes.includes(0)) throw new Error('Binary files cannot be previewed');
    let content: string;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new Error('File is not valid UTF-8 text'); }
    return { path: resolved, name: path.basename(resolved), kind, content };
  } finally {
    await handle.close();
  }
}
