import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { DetectedShell } from '../shared/ipc-channels';

let cachedShells: DetectedShell[] | null = null;

const VERSION_TIMEOUT_MS = 2000;

function execAsync(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = execFile(cmd, args, { timeout: VERSION_TIMEOUT_MS }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

async function getVersion(exe: string, args: string[]): Promise<string | null> {
  try {
    return await execAsync(exe, args);
  } catch {
    return null;
  }
}

function parsePwshMajorVersion(output: string): string {
  // "PowerShell 7.5.1" → "7"
  const match = output.match(/(\d+)\.\d+/);
  return match ? match[1] : '';
}

function parseWinPsMajorVersion(output: string): string {
  // "5.1.26100.7462" → "5"
  const match = output.match(/^(\d+)\./);
  return match ? match[1] : '';
}

async function detectWindows(): Promise<DetectedShell[]> {
  const shells: DetectedShell[] = [];

  // Detect pwsh.exe (PowerShell 7+)
  let pwshPath: string | null = null;
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'pwsh.exe'),
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  ];
  for (const candidate of candidates) {
    if (fileExists(candidate)) {
      pwshPath = candidate;
      break;
    }
  }
  // Fallback: check PATH via where.exe
  if (!pwshPath) {
    try {
      const wherePath = (await execAsync('where.exe', ['pwsh.exe'])).split('\n')[0].trim();
      if (wherePath && fileExists(wherePath)) {
        pwshPath = wherePath;
      }
    } catch { /* not found */ }
  }

  // Detect powershell.exe (always present on Windows)
  const powershellPath = 'powershell.exe';

  // Detect Git Bash — check multiple install locations
  const gitBashCandidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'),
  ];
  const gitBashPath = gitBashCandidates.find(fileExists) || null;

  // Query versions in parallel
  const [pwshVersionRaw, psVersionRaw] = await Promise.all([
    pwshPath ? getVersion(pwshPath, ['--version']) : Promise.resolve(null),
    getVersion(powershellPath, ['-Command', '$PSVersionTable.PSVersion.ToString()']),
  ]);

  if (pwshPath) {
    const ver = pwshVersionRaw ? parsePwshMajorVersion(pwshVersionRaw) : '';
    shells.push({
      id: 'pwsh',
      label: ver ? `PowerShell ${ver}` : 'PowerShell 7',
      path: pwshPath,
      type: 'powershell',
    });
  }

  if (psVersionRaw) {
    const ver = parseWinPsMajorVersion(psVersionRaw);
    shells.push({
      id: 'powershell',
      label: ver ? `Windows PowerShell ${ver}` : 'Windows PowerShell',
      path: powershellPath,
      type: 'powershell',
    });
  } else {
    // powershell.exe should always exist on Windows, add it anyway
    shells.push({
      id: 'powershell',
      label: 'Windows PowerShell',
      path: powershellPath,
      type: 'powershell',
    });
  }

  if (gitBashPath) {
    shells.push({
      id: 'gitbash',
      label: 'Git Bash',
      path: gitBashPath,
      type: 'bash',
    });
  } else {
    // Fallback: try to find bash via where.exe
    try {
      const whereBash = (await execAsync('where.exe', ['bash'])).split('\n')[0].trim();
      if (whereBash && fileExists(whereBash)) {
        shells.push({ id: 'bash', label: 'Bash', path: whereBash, type: 'bash' });
      }
    } catch { /* not found */ }
  }

  // cmd.exe (always present)
  shells.push({ id: 'cmd', label: 'Command Prompt', path: 'cmd.exe', type: 'bash' });

  // WSL
  const wslPath = 'C:\\Windows\\System32\\wsl.exe';
  if (fileExists(wslPath)) {
    shells.push({ id: 'wsl', label: 'WSL', path: wslPath, type: 'bash' });
  }

  return shells;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function detectUnix(): Promise<DetectedShell[]> {
  const shells: DetectedShell[] = [];
  const userDefault = process.env.SHELL || '';

  // Interactive shells we care about (skip sh, csh, tcsh, ksh, dash)
  const interactiveShells = new Set(['bash', 'zsh', 'fish', 'nu', 'elvish', 'pwsh']);
  const seenIds = new Set<string>();

  // Read /etc/shells for available shells
  try {
    const content = fs.readFileSync('/etc/shells', 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      if (!isExecutable(trimmed)) continue;

      const basename = path.basename(trimmed);
      if (!interactiveShells.has(basename)) continue;
      if (seenIds.has(basename)) {
        // Prefer the path matching $SHELL
        if (trimmed === userDefault) {
          const existing = shells.find((s) => s.id === basename);
          if (existing) existing.path = trimmed;
        }
        continue;
      }

      seenIds.add(basename);
      shells.push({
        id: basename,
        label: capitalize(basename),
        path: trimmed === userDefault ? trimmed : trimmed,
        type: 'bash',
      });
    }
  } catch {
    // /etc/shells not readable
  }

  // Ensure $SHELL is included even if not in /etc/shells
  if (userDefault && isExecutable(userDefault)) {
    const basename = path.basename(userDefault);
    if (!seenIds.has(basename) && interactiveShells.has(basename)) {
      shells.push({
        id: basename,
        label: capitalize(basename),
        path: userDefault,
        type: 'bash',
      });
      seenIds.add(basename);
    }
  }

  // Fallback: ensure at least one shell
  if (shells.length === 0) {
    for (const fallback of ['/bin/zsh', '/bin/bash']) {
      if (isExecutable(fallback)) {
        shells.push({
          id: path.basename(fallback),
          label: capitalize(path.basename(fallback)),
          path: fallback,
          type: 'bash',
        });
        break;
      }
    }
  }

  // Sort: user's default shell first, then alphabetical
  shells.sort((a, b) => {
    const aIsDefault = a.path === userDefault || path.basename(userDefault) === a.id;
    const bIsDefault = b.path === userDefault || path.basename(userDefault) === b.id;
    if (aIsDefault !== bIsDefault) return aIsDefault ? -1 : 1;
    return a.label.localeCompare(b.label);
  });

  return shells;
}

export async function detectShells(): Promise<DetectedShell[]> {
  if (cachedShells) return cachedShells;

  const shells = process.platform === 'win32'
    ? await detectWindows()
    : await detectUnix();

  cachedShells = shells;
  return shells;
}

export function getCachedShells(): DetectedShell[] {
  return cachedShells || [];
}

export function getShellById(id: string): DetectedShell | undefined {
  return (cachedShells || []).find((s) => s.id === id);
}
