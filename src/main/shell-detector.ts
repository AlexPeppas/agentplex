import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { DetectedShell } from '../shared/ipc-channels';

let cachedShells: DetectedShell[] | null = null;

const VERSION_TIMEOUT_MS = 3000;

function execAsync(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: VERSION_TIMEOUT_MS }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

/** On Windows, X_OK isn't meaningful (all files are "executable"), so stat-only is correct. */
function fileExists(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function isExecutable(p: string): boolean {
  try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

async function getVersion(exe: string, args: string[]): Promise<string | null> {
  try { return await execAsync(exe, args); } catch { return null; }
}

/** Extract a semver-like version from shell --version output */
function parseVersion(output: string): string {
  const match = output.match(/(\d+\.\d+(?:\.\d+)?)/);
  return match ? match[1] : '';
}

/** Version arg varies per shell */
const VERSION_ARGS: Record<string, string[]> = {
  bash: ['--version'],
  zsh: ['--version'],
  fish: ['--version'],
  nu: ['--version'],
  elvish: ['--version'],
  pwsh: ['--version'],
  powershell: ['-Command', '$PSVersionTable.PSVersion.ToString()'],
};

// ─── Windows ─────────────────────────────────────────────────────────

async function detectWindows(): Promise<DetectedShell[]> {
  const shells: DetectedShell[] = [];

  // pwsh.exe (PowerShell 7+) — treated as default over Windows PowerShell when present
  let pwshPath: string | null = null;
  for (const candidate of [
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'pwsh.exe'),
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    'C:\\Program Files\\PowerShell\\7-preview\\pwsh.exe',
  ]) {
    if (fileExists(candidate)) { pwshPath = candidate; break; }
  }
  if (!pwshPath) {
    try {
      const p = (await execAsync('where.exe', ['pwsh.exe'])).split('\n')[0].trim();
      if (p && fileExists(p)) pwshPath = p;
    } catch { /* not found */ }
  }

  // powershell.exe (Windows PowerShell 5.x — always present)
  const psPath = 'powershell.exe';

  // Git Bash
  const gitBashCandidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'),
  ];
  let gitBashPath = gitBashCandidates.find(fileExists) || null;

  // Nushell — no well-known install path, rely on where.exe
  let nuPath: string | null = null;

  // Resolve Git Bash and Nushell via where.exe in parallel
  const [gitBashWhere, nuWhere] = await Promise.allSettled([
    gitBashPath ? Promise.resolve(null) : execAsync('where.exe', ['bash.exe']),
    execAsync('where.exe', ['nu.exe']),
  ]);
  if (!gitBashPath && gitBashWhere.status === 'fulfilled' && gitBashWhere.value) {
    const p = gitBashWhere.value.split('\n')[0].trim();
    if (p && fileExists(p)) gitBashPath = p;
  }
  if (nuWhere.status === 'fulfilled' && nuWhere.value) {
    const p = nuWhere.value.split('\n')[0].trim();
    if (p && fileExists(p)) nuPath = p;
  }

  // Fetch versions in parallel
  const [pwshVer, psVer, gitBashVer, nuVer] = await Promise.all([
    pwshPath ? getVersion(pwshPath, ['--version']) : null,
    getVersion(psPath, ['-Command', '$PSVersionTable.PSVersion.ToString()']),
    gitBashPath ? getVersion(gitBashPath, ['--version']) : null,
    nuPath ? getVersion(nuPath, ['--version']) : null,
  ]);

  if (pwshPath) {
    const ver = pwshVer ? parseVersion(pwshVer) : '';
    shells.push({ id: 'pwsh', label: ver ? `PowerShell ${ver}` : 'PowerShell 7', path: pwshPath, type: 'powershell', isDefault: true });
  }

  {
    const ver = psVer ? parseVersion(psVer) : '';
    shells.push({
      id: 'powershell',
      label: ver ? `Windows PowerShell ${ver}` : 'Windows PowerShell',
      path: psPath,
      type: 'powershell',
      isDefault: !pwshPath, // default only if pwsh7 not available
    });
  }

  if (gitBashPath) {
    const ver = gitBashVer ? parseVersion(gitBashVer) : '';
    shells.push({ id: 'gitbash', label: ver ? `Git Bash ${ver}` : 'Git Bash', path: gitBashPath, type: 'bash', isDefault: false });
  }

  if (nuPath) {
    const ver = nuVer ? parseVersion(nuVer) : '';
    shells.push({ id: 'nu', label: ver ? `Nushell ${ver}` : 'Nushell', path: nuPath, type: 'nu', isDefault: false });
  }

  // cmd.exe (always present)
  shells.push({ id: 'cmd', label: 'Command Prompt', path: 'cmd.exe', type: 'cmd', isDefault: false });

  // WSL
  const wslPath = 'C:\\Windows\\System32\\wsl.exe';
  if (fileExists(wslPath)) {
    shells.push({ id: 'wsl', label: 'WSL', path: wslPath, type: 'wsl', isDefault: false });
  }

  return shells;
}

// ─── Unix (macOS / Linux) ────────────────────────────────────────────

const INTERACTIVE_SHELLS = new Set(['bash', 'zsh', 'fish', 'nu', 'elvish', 'pwsh']);

async function detectUnix(): Promise<DetectedShell[]> {
  const shells: DetectedShell[] = [];
  const userDefault = process.env.SHELL || '';
  const seenIds = new Set<string>();
  const versionPromises: { shell: DetectedShell; exe: string }[] = [];

  // Read /etc/shells
  try {
    const content = fs.readFileSync('/etc/shells', 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      if (!isExecutable(trimmed)) continue;

      const basename = path.basename(trimmed);
      if (!INTERACTIVE_SHELLS.has(basename)) continue;
      if (seenIds.has(basename)) {
        if (trimmed === userDefault) {
          const existing = shells.find((s) => s.id === basename);
          if (existing) existing.path = trimmed;
        }
        continue;
      }

      seenIds.add(basename);
      const isDefault = trimmed === userDefault || basename === path.basename(userDefault);
      const shell: DetectedShell = {
        id: basename,
        label: capitalize(basename),
        path: trimmed,
        type: basename,
        isDefault,
      };
      shells.push(shell);
      versionPromises.push({ shell, exe: trimmed });
    }
  } catch {
    // /etc/shells not readable
  }

  // Ensure $SHELL is included
  if (userDefault && isExecutable(userDefault)) {
    const basename = path.basename(userDefault);
    if (!seenIds.has(basename) && INTERACTIVE_SHELLS.has(basename)) {
      const shell: DetectedShell = {
        id: basename,
        label: capitalize(basename),
        path: userDefault,
        type: basename,
        isDefault: true,
      };
      shells.push(shell);
      versionPromises.push({ shell, exe: userDefault });
      seenIds.add(basename);
    }
  }

  // Fallback
  if (shells.length === 0) {
    for (const fallback of ['/bin/zsh', '/bin/bash']) {
      if (isExecutable(fallback)) {
        const basename = path.basename(fallback);
        const shell: DetectedShell = {
          id: basename, label: capitalize(basename), path: fallback,
          type: basename, isDefault: true,
        };
        shells.push(shell);
        versionPromises.push({ shell, exe: fallback });
        break;
      }
    }
  }

  // Fetch versions in parallel — mutates shell.label in place before the sort below
  await Promise.allSettled(
    versionPromises.map(async ({ shell, exe }) => {
      const args = VERSION_ARGS[shell.id] || ['--version'];
      const raw = await getVersion(exe, args);
      if (raw) {
        const ver = parseVersion(raw);
        if (ver) shell.label = `${capitalize(shell.id)} ${ver}`;
      }
    })
  );

  // Sort: default first, then alphabetical
  shells.sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    return a.label.localeCompare(b.label);
  });

  return shells;
}

// ─── Public API ──────────────────────────────────────────────────────

export async function detectShells(): Promise<DetectedShell[]> {
  if (cachedShells) return cachedShells;
  cachedShells = process.platform === 'win32'
    ? await detectWindows()
    : await detectUnix();
  return cachedShells;
}

export function getCachedShells(): DetectedShell[] {
  return cachedShells || [];
}

export function getShellById(id: string): DetectedShell | undefined {
  return (cachedShells || []).find((s) => s.id === id);
}
