import * as fs from 'fs';
import * as path from 'path';
import type { FileItem, FileContentResult } from '../shared/ipc-channels';

const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.json': 'json',
  '.html': 'html',
  '.htm': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.sass': 'scss',
  '.less': 'less',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.c': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.h': 'c',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.rb': 'ruby',
  '.php': 'php',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'ini',
  '.ini': 'ini',
  '.xml': 'xml',
  '.sql': 'sql',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.fish': 'shell',
  '.ps1': 'powershell',
  '.dockerfile': 'dockerfile',
  '.lua': 'lua',
  '.r': 'r',
  '.svg': 'xml',
  '.graphql': 'graphql',
  '.gql': 'graphql',
  '.env': 'shell',
  '.gitignore': 'shell',
  '.npmignore': 'shell',
};

const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.ico',
  '.bmp',
]);

const BINARY_EXTENSIONS = new Set([
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.iso',
  '.zip',
  '.tar',
  '.gz',
  '.bz2',
  '.7z',
  '.rar',
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.mp3',
  '.mp4',
  '.mov',
  '.avi',
  '.mkv',
  '.wav',
  '.flac',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.otf',
  '.wasm',
  '.pyc',
  '.class',
  '.o',
  '.obj',
]);

function inferLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (EXTENSION_LANGUAGE_MAP[ext]) return EXTENSION_LANGUAGE_MAP[ext];
  const basename = path.basename(filePath).toLowerCase();
  if (basename === 'dockerfile') return 'dockerfile';
  if (basename === 'makefile') return 'makefile';
  if (basename.startsWith('.env')) return 'shell';
  return 'plaintext';
}

function getImageMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    case '.svg': return 'image/svg+xml';
    case '.ico': return 'image/x-icon';
    case '.bmp': return 'image/bmp';
    default: return 'application/octet-stream';
  }
}

function resolveSafePath(rootPath: string, subPath: string = ''): string {
  const fullPath = path.join(rootPath, subPath);
  const resolvedFull = path.resolve(fullPath);
  const resolvedRoot = path.resolve(rootPath);
  const rootPrefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;

  const fullCheck = process.platform === 'win32' ? resolvedFull.toLowerCase() : resolvedFull;
  const prefixCheck = process.platform === 'win32' ? rootPrefix.toLowerCase() : rootPrefix;
  const rootCheck = process.platform === 'win32' ? resolvedRoot.toLowerCase() : resolvedRoot;

  if (!fullCheck.startsWith(prefixCheck) && fullCheck !== rootCheck) {
    throw new Error('Path traversal detected');
  }
  return resolvedFull;
}

export async function listFiles(rootPath: string, subPath: string = ''): Promise<FileItem[]> {
  const targetDir = resolveSafePath(rootPath, subPath);
  const entries = await fs.promises.readdir(targetDir, { withFileTypes: true });
  const items: FileItem[] = [];

  for (const entry of entries) {
    // Ignore .git directory
    if (entry.name === '.git') continue;

    const entryFullPath = path.join(targetDir, entry.name);
    const relativePath = path.relative(rootPath, entryFullPath).replace(/\\/g, '/');

    let isDirectory = entry.isDirectory();
    // In case of symlinks, resolve stat
    if (entry.isSymbolicLink()) {
      try {
        const stat = await fs.promises.stat(entryFullPath);
        isDirectory = stat.isDirectory();
      } catch {
        continue;
      }
    }

    let size: number | undefined;
    if (!isDirectory) {
      try {
        const stat = await fs.promises.stat(entryFullPath);
        size = stat.size;
      } catch {
        // ignore stat errors
      }
    }

    items.push({
      name: entry.name,
      path: relativePath,
      isDirectory,
      size,
      extension: isDirectory ? undefined : path.extname(entry.name).toLowerCase(),
    });
  }

  // Sort: directories first, then alphabetical (case-insensitive)
  items.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) {
      return a.isDirectory ? -1 : 1;
    }
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  return items;
}

const MAX_TEXT_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_IMAGE_FILE_SIZE = 20 * 1024 * 1024; // 20MB

export async function readFileContent(rootPath: string, filePath: string): Promise<FileContentResult> {
  const targetPath = resolveSafePath(rootPath, filePath);
  const stat = await fs.promises.stat(targetPath);
  const ext = path.extname(targetPath).toLowerCase();
  const relativePath = path.relative(rootPath, targetPath).replace(/\\/g, '/');

  if (IMAGE_EXTENSIONS.has(ext)) {
    if (stat.size > MAX_IMAGE_FILE_SIZE) {
      return {
        isBinary: true,
        isImage: false,
        size: stat.size,
        path: relativePath,
      };
    }
    const buffer = await fs.promises.readFile(targetPath);
    const mime = getImageMimeType(targetPath);
    const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;
    return {
      isBinary: true,
      isImage: true,
      dataUrl,
      size: stat.size,
      path: relativePath,
    };
  }

  if (BINARY_EXTENSIONS.has(ext)) {
    return {
      isBinary: true,
      isImage: false,
      size: stat.size,
      path: relativePath,
    };
  }

  if (stat.size > MAX_TEXT_FILE_SIZE) {
    return {
      isBinary: true,
      isImage: false,
      size: stat.size,
      path: relativePath,
    };
  }

  const buffer = await fs.promises.readFile(targetPath);

  // Check for null bytes in the first 8000 bytes to detect binary files without matching extension
  const checkLen = Math.min(buffer.length, 8000);
  for (let i = 0; i < checkLen; i++) {
    if (buffer[i] === 0) {
      return {
        isBinary: true,
        isImage: false,
        size: stat.size,
        path: relativePath,
      };
    }
  }

  const content = buffer.toString('utf-8');
  return {
    isBinary: false,
    content,
    language: inferLanguage(targetPath),
    size: stat.size,
    path: relativePath,
  };
}

export async function saveFileContent(rootPath: string, filePath: string, content: string): Promise<void> {
  const targetPath = resolveSafePath(rootPath, filePath);
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.promises.writeFile(targetPath, content, 'utf-8');
}

export async function createFileOrFolder(rootPath: string, targetPath: string, isDirectory: boolean): Promise<void> {
  const fullPath = resolveSafePath(rootPath, targetPath);
  if (isDirectory) {
    await fs.promises.mkdir(fullPath, { recursive: true });
  } else {
    await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.promises.writeFile(fullPath, '', { flag: 'wx' }); // error if exists
  }
}

export async function deleteFileOrFolder(rootPath: string, targetPath: string): Promise<void> {
  const fullPath = resolveSafePath(rootPath, targetPath);
  // Ensure we do not delete the root itself
  if (path.resolve(fullPath) === path.resolve(rootPath)) {
    throw new Error('Cannot delete root directory');
  }
  await fs.promises.rm(fullPath, { recursive: true, force: true });
}
