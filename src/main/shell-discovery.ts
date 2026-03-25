import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import type { ShellInfo } from '../shared/ipc-channels';

let cachedShells: ShellInfo[] | null = null;

/** Capitalize first letter: 'zsh' -> 'Zsh' */
function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Check if a file exists and is executable */
function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function discoverUnixShells(): ShellInfo[] {
  const userDefault = process.env.SHELL || '';
  const shells: ShellInfo[] = [];
  const seenIds = new Map<string, ShellInfo>();

  // Common shells we care about (skip sh, csh, tcsh, ksh, dash as they're rarely used interactively)
  const interactiveShells = new Set(['bash', 'zsh', 'fish', 'nu', 'elvish', 'pwsh']);

  try {
    const content = fs.readFileSync('/etc/shells', 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      if (!isExecutable(trimmed)) continue;

      const basename = path.basename(trimmed);
      if (!interactiveShells.has(basename)) continue;

      const isDefault = trimmed === userDefault;
      const existing = seenIds.get(basename);

      // If we already have this shell, prefer the one matching $SHELL
      if (existing) {
        if (isDefault && !existing.isDefault) {
          existing.path = trimmed;
          existing.isDefault = true;
        }
        continue;
      }

      const info: ShellInfo = {
        id: basename,
        name: capitalize(basename),
        path: trimmed,
        isDefault,
      };
      seenIds.set(basename, info);
      shells.push(info);
    }
  } catch {
    // /etc/shells not readable — fall back to $SHELL
  }

  // If $SHELL wasn't found in /etc/shells, add it directly
  if (userDefault && !shells.some((s) => s.isDefault) && isExecutable(userDefault)) {
    const basename = path.basename(userDefault);
    const existing = seenIds.get(basename);
    if (existing) {
      existing.isDefault = true;
      existing.path = userDefault;
    } else {
      shells.push({
        id: basename,
        name: capitalize(basename),
        path: userDefault,
        isDefault: true,
      });
    }
  }

  // Ensure at least one shell exists
  if (shells.length === 0) {
    for (const fallback of ['/bin/zsh', '/bin/bash']) {
      if (isExecutable(fallback)) {
        shells.push({
          id: path.basename(fallback),
          name: capitalize(path.basename(fallback)),
          path: fallback,
          isDefault: true,
        });
        break;
      }
    }
  }

  return shells;
}

function discoverWindowsShells(): ShellInfo[] {
  const shells: ShellInfo[] = [];

  // PowerShell (always available on Windows)
  shells.push({
    id: 'powershell',
    name: 'PowerShell',
    path: 'powershell.exe',
    isDefault: true,
  });

  // cmd.exe
  shells.push({
    id: 'cmd',
    name: 'Command Prompt',
    path: 'cmd.exe',
    isDefault: false,
  });

  // Git Bash — check multiple common install locations
  const gitBashPaths = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    `${process.env.LOCALAPPDATA || ''}\\Programs\\Git\\bin\\bash.exe`,
  ].filter(Boolean);

  for (const p of gitBashPaths) {
    if (isExecutable(p)) {
      shells.push({
        id: 'bash',
        name: 'Git Bash',
        path: p,
        isDefault: false,
      });
      break;
    }
  }

  // If Git Bash not found at known paths, try `where bash`
  if (!shells.some((s) => s.id === 'bash')) {
    try {
      const result = execFileSync('where', ['bash'], { encoding: 'utf-8', timeout: 3000 });
      const firstLine = result.trim().split('\n')[0]?.trim();
      if (firstLine && isExecutable(firstLine)) {
        shells.push({
          id: 'bash',
          name: 'Bash',
          path: firstLine,
          isDefault: false,
        });
      }
    } catch {
      // bash not found on PATH
    }
  }

  // WSL
  const wslPath = 'C:\\Windows\\System32\\wsl.exe';
  if (isExecutable(wslPath)) {
    shells.push({
      id: 'wsl',
      name: 'WSL',
      path: wslPath,
      isDefault: false,
    });
  }

  return shells;
}

/** Return all available shells on this system (cached for app lifetime). */
export function getAvailableShells(): ShellInfo[] {
  if (cachedShells) return cachedShells;
  cachedShells = process.platform === 'win32'
    ? discoverWindowsShells()
    : discoverUnixShells();

  // Sort: default first, then alphabetical
  cachedShells.sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return cachedShells;
}

/** Return the full path of the user's default shell. */
export function getDefaultShell(): string {
  const shells = getAvailableShells();
  const def = shells.find((s) => s.isDefault);
  return def?.path || (process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh');
}

/** Find a shell by its id (e.g. 'zsh', 'bash', 'powershell'). Returns null if not found. */
export function findShellById(id: string): ShellInfo | null {
  return getAvailableShells().find((s) => s.id === id) || null;
}
