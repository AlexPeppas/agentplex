import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import type { GitStatusResult, GitChangedFile, GitFileDiffResult, GitLogEntry, GitBranchInfo, GitCommandResult } from '../shared/ipc-channels';

const execFileAsync = promisify(execFile);

const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.mts': 'typescript',
  '.json': 'json',
  '.html': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less',
  '.md': 'markdown',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.c': 'c',
  '.cpp': 'cpp',
  '.h': 'c',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.rb': 'ruby',
  '.php': 'php',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'ini',
  '.xml': 'xml',
  '.sql': 'sql',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.ps1': 'powershell',
  '.dockerfile': 'dockerfile',
  '.lua': 'lua',
  '.r': 'r',
  '.svg': 'xml',
};

function inferLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (EXTENSION_LANGUAGE_MAP[ext]) return EXTENSION_LANGUAGE_MAP[ext];
  const basename = path.basename(filePath).toLowerCase();
  if (basename === 'dockerfile') return 'dockerfile';
  if (basename === 'makefile') return 'makefile';
  return 'plaintext';
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
}

export async function getGitStatus(cwd: string): Promise<GitStatusResult> {
  try {
    const repoRoot = (await git(['rev-parse', '--show-toplevel'], cwd)).trim();
    const output = await git(['status', '--porcelain=v1'], repoRoot);
    const files: GitChangedFile[] = [];

    for (const line of output.split('\n')) {
      if (!line.trim()) continue;
      const indexStatus = line[0];
      const workTreeStatus = line[1];
      const filePath = line.slice(3).trim();

      // If there's a rename arrow, take the new name
      const actualPath = filePath.includes(' -> ')
        ? filePath.split(' -> ')[1]
        : filePath;

      // Determine the effective status and staging
      if (indexStatus !== ' ' && indexStatus !== '?') {
        // Staged change
        files.push({
          path: actualPath,
          status: indexStatus as GitChangedFile['status'],
          staged: true,
        });
      }
      if (workTreeStatus !== ' ' && workTreeStatus !== '?') {
        // Unstaged change
        const existing = files.find(f => f.path === actualPath && f.staged);
        if (!existing) {
          files.push({
            path: actualPath,
            status: workTreeStatus as GitChangedFile['status'],
            staged: false,
          });
        } else {
          // File has both staged and unstaged changes - add unstaged entry too
          files.push({
            path: actualPath,
            status: workTreeStatus as GitChangedFile['status'],
            staged: false,
          });
        }
      }
      if (indexStatus === '?' && workTreeStatus === '?') {
        // Untracked
        files.push({ path: actualPath, status: '?', staged: false });
      }
    }

    return { isRepo: true, files, repoRoot };
  } catch {
    return { isRepo: false, files: [], repoRoot: '' };
  }
}

async function gitShowOrEmpty(args: string[], cwd: string): Promise<string> {
  try {
    return await git(args, cwd);
  } catch {
    return '';
  }
}

async function readFileOrEmpty(filePath: string): Promise<string> {
  try {
    return await fs.promises.readFile(filePath, 'utf-8');
  } catch {
    return '';
  }
}

export async function getFileDiff(
  repoRoot: string,
  filePath: string,
  staged: boolean,
): Promise<GitFileDiffResult> {
  const fullPath = path.join(repoRoot, filePath);

  // Security: ensure resolved path is within repo root
  const resolvedFull = path.resolve(fullPath);
  const resolvedRoot = path.resolve(repoRoot);
  if (!resolvedFull.startsWith(resolvedRoot + path.sep) && resolvedFull !== resolvedRoot) {
    throw new Error('Path traversal detected');
  }

  let original: string;
  let modified: string;

  if (staged) {
    // Staged: original = HEAD version, modified = index (staged) version
    original = await gitShowOrEmpty(['show', `HEAD:${filePath}`], repoRoot);
    modified = await gitShowOrEmpty(['show', `:${filePath}`], repoRoot);
  } else {
    // Unstaged: original = index version (or HEAD if not staged), modified = working tree
    modified = await readFileOrEmpty(fullPath);
    original = await gitShowOrEmpty(['show', `:${filePath}`], repoRoot);
    if (!original) {
      original = await gitShowOrEmpty(['show', `HEAD:${filePath}`], repoRoot);
    }
  }

  return { original, modified, language: inferLanguage(filePath) };
}

export async function saveFile(
  repoRoot: string,
  filePath: string,
  content: string,
): Promise<void> {
  const fullPath = path.join(repoRoot, filePath);
  const resolvedFull = path.resolve(fullPath);
  const resolvedRoot = path.resolve(repoRoot);
  if (!resolvedFull.startsWith(resolvedRoot + path.sep) && resolvedFull !== resolvedRoot) {
    throw new Error('Path traversal detected');
  }
  await fs.promises.writeFile(fullPath, content, 'utf-8');
}

export async function stageFile(repoRoot: string, filePath: string): Promise<void> {
  await git(['add', '--', filePath], repoRoot);
}

export async function unstageFile(repoRoot: string, filePath: string): Promise<void> {
  try {
    await git(['reset', 'HEAD', '--', filePath], repoRoot);
  } catch {
    // If there's no HEAD (initial commit), unstage differently
    await git(['rm', '--cached', '--', filePath], repoRoot);
  }
}

export async function gitCommit(repoRoot: string, message: string): Promise<GitCommandResult> {
  try {
    const output = await git(['commit', '-m', message], repoRoot);
    return { success: true, output: output.trim() };
  } catch (err: any) {
    return { success: false, output: err.stderr || err.message || 'Commit failed' };
  }
}

export async function gitPush(repoRoot: string): Promise<GitCommandResult> {
  try {
    const output = await git(['push'], repoRoot);
    return { success: true, output: output.trim() || 'Push successful' };
  } catch (err: any) {
    // git push writes to stderr even on success
    const stderr = err.stderr || '';
    if (err.code === 0 || stderr.includes('->')) {
      return { success: true, output: stderr.trim() || 'Push successful' };
    }
    return { success: false, output: stderr || err.message || 'Push failed' };
  }
}

export async function gitPull(repoRoot: string): Promise<GitCommandResult> {
  try {
    const output = await git(['pull'], repoRoot);
    return { success: true, output: output.trim() || 'Already up to date' };
  } catch (err: any) {
    return { success: false, output: err.stderr || err.message || 'Pull failed' };
  }
}

export async function gitLog(repoRoot: string, count = 20): Promise<GitLogEntry[]> {
  try {
    const SEP = '|||';
    const output = await git(
      ['log', `--max-count=${count}`, `--pretty=format:%H${SEP}%h${SEP}%s${SEP}%an${SEP}%ar`],
      repoRoot,
    );
    if (!output.trim()) return [];
    return output.trim().split('\n').map((line) => {
      const [hash, shortHash, subject, author, date] = line.split(SEP);
      return { hash, shortHash, subject, author, date };
    });
  } catch {
    return [];
  }
}

export async function gitBranchInfo(repoRoot: string): Promise<GitBranchInfo> {
  const current = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot)).trim();

  let tracking: string | null = null;
  let ahead = 0;
  let behind = 0;

  try {
    tracking = (await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], repoRoot)).trim();
  } catch {
    // No upstream configured
  }

  if (tracking) {
    try {
      const counts = (await git(['rev-list', '--left-right', '--count', `${tracking}...HEAD`], repoRoot)).trim();
      const [b, a] = counts.split(/\s+/).map(Number);
      behind = b || 0;
      ahead = a || 0;
    } catch { /* ignore */ }
  }

  return { current, tracking, ahead, behind };
}
