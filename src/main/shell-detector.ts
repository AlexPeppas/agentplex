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

  // Detect Git Bash
  const gitBashPath = 'C:\\Program Files\\Git\\bin\\bash.exe';

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

  if (fileExists(gitBashPath)) {
    shells.push({
      id: 'gitbash',
      label: 'Bash',
      path: gitBashPath,
      type: 'bash',
    });
  }

  return shells;
}

async function detectUnix(): Promise<DetectedShell[]> {
  const shells: DetectedShell[] = [];

  // Detect pwsh (PowerShell 7 on macOS/Linux)
  try {
    const pwshPath = (await execAsync('which', ['pwsh'])).trim();
    if (pwshPath) {
      const versionRaw = await getVersion(pwshPath, ['--version']);
      const ver = versionRaw ? parsePwshMajorVersion(versionRaw) : '';
      shells.push({
        id: 'pwsh',
        label: ver ? `PowerShell ${ver}` : 'PowerShell 7',
        path: pwshPath,
        type: 'powershell',
      });
    }
  } catch { /* not found */ }

  // Bash uses hardcoded path per requirements
  shells.push({
    id: 'bash',
    label: 'Bash',
    path: 'bash',
    type: 'bash',
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
