import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { homedir, hostname } from 'os';
import { BrowserWindow } from 'electron';
import { invalidateCache, loadSettings, updateSettings } from './settings-manager';

const execFileAsync = promisify(execFile);

export const SYNC_REPO_NAME = 'agentplex-sync';
const DEFAULT_PROFILE = 'default';

// ── Path helpers (all derived from homedir so mocking works in tests) ───────

function agentplexHome(): string { return path.join(homedir(), '.agentplex'); }
function syncRepoPath(): string { return path.join(agentplexHome(), 'sync-repo'); }
function claudeHome(): string { return path.join(homedir(), '.claude'); }
function settingsPath(): string { return path.join(agentplexHome(), 'settings.json'); }

// Default allowlist for ~/.claude/ sync
const DEFAULT_CLAUDE_SYNC_INCLUDES = ['CLAUDE.md', 'settings.json', 'agents', 'commands', 'plugins'];

function getClaudeSyncIncludes(): Set<string> {
  const settings = loadSettings();
  const custom = settings.syncClaudeIncludes;
  if (Array.isArray(custom) && custom.length > 0) return new Set(custom as string[]);
  return new Set(DEFAULT_CLAUDE_SYNC_INCLUDES);
}

const MAX_FILE_SIZE = 1024 * 1024; // 1MB

export interface SyncStatusInfo {
  status: 'idle' | 'syncing' | 'conflict' | 'error' | 'not-configured';
  lastSyncedAt: string | null;
  error?: string;
}

let currentStatus: SyncStatusInfo = { status: 'not-configured', lastSyncedAt: null };
let syncing = false;

// ── Git helpers ─────────────────────────────────────────────────────────────

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
}

async function gitMayFail(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    });
    return { stdout, stderr, code: 0 };
  } catch (err: any) {
    return { stdout: err.stdout || '', stderr: err.stderr || '', code: err.code ?? 1 };
  }
}

// ── Status broadcasting ─────────────────────────────────────────────────────

function setStatus(status: SyncStatusInfo): void {
  currentStatus = status;
  try {
    BrowserWindow.getAllWindows().forEach((w) => {
      w.webContents.send('sync:statusChanged', status);
    });
  } catch { /* ok in tests */ }
}

// ── File walking ────────────────────────────────────────────────────────────

function walkDir(root: string, excludes: Set<string>, relativeTo: string = root): string[] {
  const results: string[] = [];
  if (!fs.existsSync(root)) return results;

  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const rel = path.relative(relativeTo, path.join(root, entry.name));
    const topLevel = rel.split(path.sep)[0];

    if (excludes.has(topLevel) || excludes.has(entry.name)) continue;
    if (entry.name.startsWith('.git') && entry.name !== '.gitignore') continue;

    if (entry.isDirectory()) {
      results.push(...walkDir(path.join(root, entry.name), excludes, relativeTo));
    } else if (entry.isFile()) {
      try {
        const stat = fs.statSync(path.join(root, entry.name));
        if (stat.size <= MAX_FILE_SIZE) {
          results.push(rel);
        }
      } catch { /* skip unreadable */ }
    }
  }
  return results;
}

function copyFiles(files: string[], sourceRoot: string, destRoot: string): void {
  for (const rel of files) {
    const src = path.join(sourceRoot, rel);
    const dst = path.join(destRoot, rel);
    try {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    } catch (err: any) {
      console.warn(`[sync] Failed to copy ${rel}:`, err.message);
    }
  }
}

// ── Profile helpers ─────────────────────────────────────────────────────────

export function getActiveProfile(): string {
  const settings = loadSettings();
  return (settings.syncActiveProfile as string) || DEFAULT_PROFILE;
}

function profileDir(profile?: string): string {
  return path.join(syncRepoPath(), profile ?? getActiveProfile());
}

// ── Public API: file helpers ────────────────────────────────────────────────

export function getClaudeFilesToSync(): string[] {
  const root = claudeHome();
  if (!fs.existsSync(root)) return [];

  const results: string[] = [];
  for (const name of getClaudeSyncIncludes()) {
    const full = path.join(root, name);
    if (!fs.existsSync(full)) continue;

    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      // Recursively collect files from this allowed directory
      results.push(...walkDir(full, new Set(), root));
    } else if (stat.isFile() && stat.size <= MAX_FILE_SIZE) {
      results.push(name);
    }
  }
  return results;
}

export function copyLocalToSyncRepo(): void {
  const dest = profileDir();
  fs.mkdirSync(dest, { recursive: true });

  // Copy AgentPlex settings
  const src = settingsPath();
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(dest, 'agentplex-settings.json'));
  }

  // Copy Claude folder selectively
  const claudeFiles = getClaudeFilesToSync();
  copyFiles(claudeFiles, claudeHome(), path.join(dest, 'claude'));
}

export function applySyncRepoToLocal(): void {
  const src = profileDir();

  // Apply AgentPlex settings (preserving sync-config fields)
  const syncedSettings = path.join(src, 'agentplex-settings.json');
  if (fs.existsSync(syncedSettings)) {
    fs.mkdirSync(agentplexHome(), { recursive: true });
    const synced = JSON.parse(fs.readFileSync(syncedSettings, 'utf-8'));
    // Preserve local sync config — these are machine-specific
    const current = loadSettings();
    const SYNC_FIELDS = ['syncRepoUrl', 'syncLastSyncedAt', 'syncAutoSync', 'syncActiveProfile'];
    for (const key of SYNC_FIELDS) {
      if (current[key] !== undefined) synced[key] = current[key];
    }
    fs.writeFileSync(settingsPath(), JSON.stringify(synced, null, 2));
    invalidateCache();

    try {
      const newSettings = JSON.parse(fs.readFileSync(settingsPath(), 'utf-8'));
      BrowserWindow.getAllWindows().forEach((w) => {
        w.webContents.send('settings:changed', newSettings);
      });
    } catch { /* ok */ }
  }

  // Apply Claude folder
  const claudeSrcDir = path.join(src, 'claude');
  if (fs.existsSync(claudeSrcDir)) {
    const claudeFiles = walkDir(claudeSrcDir, new Set(), claudeSrcDir);
    fs.mkdirSync(claudeHome(), { recursive: true });
    copyFiles(claudeFiles, claudeSrcDir, claudeHome());
  }
}

// ── GitHub CLI helpers ──────────────────────────────────────────────────────

export interface GitHubUser {
  username: string;
  host: string;
}

export async function getGitHubUser(): Promise<GitHubUser | null> {
  try {
    const { stdout, stderr } = await execFileAsync('gh', ['auth', 'status'], {
      windowsHide: true,
      timeout: 10_000,
    });
    // gh may write to stdout or stderr depending on version
    const output = (stdout || '') + (stderr || '');
    const match = output.match(/Logged in to (\S+) account (\S+)/);
    if (match) {
      return { host: match[1], username: match[2] };
    }
    return null;
  } catch {
    return null;
  }
}

export interface GhLoginProgress {
  status: 'code' | 'waiting' | 'success' | 'error';
  code?: string;
  error?: string;
}

export async function ghLogin(host: string = 'github.com'): Promise<GhLoginProgress> {
  return new Promise((resolve) => {
    const child = execFile(
      'gh',
      ['auth', 'login', '-h', host, '-p', 'https', '-w'],
      { windowsHide: true, timeout: 120_000 },
      (err) => {
        if (err) {
          resolve({ status: 'error', error: err.message });
        } else {
          resolve({ status: 'success' });
        }
      },
    );

    // Capture output for the one-time code
    let output = '';
    child.stdout?.on('data', (chunk: string) => { output += chunk; });
    child.stderr?.on('data', (chunk: string) => { output += chunk; });

    // Broadcast the code once we detect it
    const codeInterval = setInterval(() => {
      const match = output.match(/one-time code:\s*(\S+-\S+)/i)
        || output.match(/code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/);
      if (match) {
        clearInterval(codeInterval);
        BrowserWindow.getAllWindows().forEach((w) => {
          w.webContents.send('sync:ghLoginProgress', { status: 'code', code: match[1] } satisfies GhLoginProgress);
        });
      }
    }, 200);

    // Cleanup interval when process exits
    child.on('exit', () => clearInterval(codeInterval));
  });
}

export async function ensureSyncRepo(): Promise<string> {
  const user = await getGitHubUser();
  if (!user) throw new Error('Not authenticated with GitHub CLI. Run `gh auth login` first.');

  const repoFullName = `${user.username}/${SYNC_REPO_NAME}`;

  const { code } = await gitMayFail(
    ['ls-remote', `https://${user.host}/${repoFullName}.git`],
    process.cwd(),
  );

  if (code !== 0) {
    console.log(`[sync] Creating private repo ${repoFullName} on ${user.host}`);
    await execFileAsync('gh', [
      'repo', 'create', SYNC_REPO_NAME,
      '--private',
      '--description', 'AgentPlex settings sync (auto-created)',
    ], { windowsHide: true, timeout: 30_000 });
  }

  return `https://${user.host}/${repoFullName}.git`;
}

// ── Public API: sync config ─────────────────────────────────────────────────

export interface SyncConfig {
  syncRepoUrl: string;
  syncLastSyncedAt: string | null;
  syncAutoSync: boolean;
}

export function getSyncConfig(): SyncConfig | null {
  const settings = loadSettings();
  if (!settings.syncRepoUrl) return null;
  return {
    syncRepoUrl: settings.syncRepoUrl as string,
    syncLastSyncedAt: (settings.syncLastSyncedAt as string | null) ?? null,
    syncAutoSync: (settings.syncAutoSync as boolean) ?? false,
  };
}

function saveSyncConfig(repoUrl: string, lastSyncedAt: string | null): void {
  const patch: Record<string, unknown> = { syncRepoUrl: repoUrl, syncLastSyncedAt: lastSyncedAt };
  // Seed syncClaudeIncludes so it's visible in the JSON editor
  if (!loadSettings().syncClaudeIncludes) {
    patch.syncClaudeIncludes = DEFAULT_CLAUDE_SYNC_INCLUDES;
  }
  updateSettings(patch);
}

// ── Detect default branch ───────────────────────────────────────────────────

async function detectDefaultBranch(cwd: string): Promise<string> {
  try {
    const head = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)).trim();
    if (head && head !== 'HEAD') return head;
  } catch { /* fallback */ }
  return 'master';
}

// ── Public API: profiles ────────────────────────────────────────────────────

export function listProfiles(): string[] {
  const repo = syncRepoPath();
  if (!fs.existsSync(repo)) return [DEFAULT_PROFILE];

  const entries = fs.readdirSync(repo, { withFileTypes: true });
  const profiles = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();

  return profiles.length > 0 ? profiles : [DEFAULT_PROFILE];
}

export async function createProfile(name: string): Promise<void> {
  if (name === DEFAULT_PROFILE) throw new Error('Cannot create a profile named "default"');

  const dest = profileDir(name);
  if (fs.existsSync(dest)) throw new Error(`Profile "${name}" already exists`);

  // Copy current profile's content as the starting point
  const currentDir = profileDir();
  if (fs.existsSync(currentDir)) {
    const files = walkDir(currentDir, new Set(), currentDir);
    copyFiles(files, currentDir, dest);
  } else {
    fs.mkdirSync(dest, { recursive: true });
  }

  // Commit
  const repo = syncRepoPath();
  await git(['add', '-A'], repo);
  await git(['commit', '-m', `profile: create "${name}" from "${getActiveProfile()}"`], repo);
  await gitMayFail(['push', 'origin', 'HEAD'], repo);
}

export async function switchProfile(name: string): Promise<void> {
  const profiles = listProfiles();
  if (!profiles.includes(name)) throw new Error(`Profile "${name}" does not exist`);

  // Auto-push current profile before switching
  copyLocalToSyncRepo();
  const repo = syncRepoPath();
  await git(['add', '-A'], repo);
  const { code: diffCode } = await gitMayFail(['diff', '--cached', '--quiet'], repo);
  if (diffCode !== 0) {
    await git(['commit', '-m', `sync: save "${getActiveProfile()}" before switch to "${name}"`], repo);
    await gitMayFail(['push', 'origin', 'HEAD'], repo);
  }

  // Update active profile setting
  updateSettings({ syncActiveProfile: name });

  // Apply the target profile's files to local
  applySyncRepoToLocal();
}

export async function renameProfile(oldName: string, newName: string): Promise<void> {
  if (oldName === DEFAULT_PROFILE) throw new Error('Cannot rename the default profile');

  const repo = syncRepoPath();
  const oldDir = path.join(repo, oldName);
  const newDir = path.join(repo, newName);

  if (!fs.existsSync(oldDir)) throw new Error(`Profile "${oldName}" does not exist`);
  if (fs.existsSync(newDir)) throw new Error(`Profile "${newName}" already exists`);

  fs.renameSync(oldDir, newDir);
  await git(['add', '-A'], repo);
  await git(['commit', '-m', `profile: rename "${oldName}" to "${newName}"`], repo);
  await gitMayFail(['push', 'origin', 'HEAD'], repo);

  // Update active profile if we renamed the active one
  if (getActiveProfile() === oldName) {
    updateSettings({ syncActiveProfile: newName });
  }
}

export async function deleteProfile(name: string): Promise<void> {
  if (name === DEFAULT_PROFILE) throw new Error('Cannot delete the default profile');

  const repo = syncRepoPath();
  const dir = path.join(repo, name);
  if (!fs.existsSync(dir)) throw new Error(`Profile "${name}" does not exist`);

  fs.rmSync(dir, { recursive: true, force: true });
  await git(['add', '-A'], repo);
  await git(['commit', '-m', `profile: delete "${name}"`], repo);
  await gitMayFail(['push', 'origin', 'HEAD'], repo);

  // Switch to default if we deleted the active profile
  if (getActiveProfile() === name) {
    updateSettings({ syncActiveProfile: DEFAULT_PROFILE });
    applySyncRepoToLocal();
  }
}

// ── Public API: sync operations ─────────────────────────────────────────────

export async function setupSyncAuto(): Promise<SyncStatusInfo> {
  try {
    const repoUrl = await ensureSyncRepo();
    return setupSync(repoUrl);
  } catch (err: any) {
    const status: SyncStatusInfo = { status: 'error', lastSyncedAt: null, error: err.message };
    setStatus(status);
    return status;
  }
}

export async function setupSync(repoUrl: string): Promise<SyncStatusInfo> {
  if (syncing) return { status: 'error', lastSyncedAt: null, error: 'Sync already in progress' };
  syncing = true;

  try {
    const repo = syncRepoPath();

    // Clean up existing sync-repo if remote differs
    if (fs.existsSync(repo)) {
      try {
        const remote = (await git(['remote', 'get-url', 'origin'], repo)).trim();
        if (remote !== repoUrl) {
          fs.rmSync(repo, { recursive: true, force: true });
        }
      } catch {
        fs.rmSync(repo, { recursive: true, force: true });
      }
    }

    if (!fs.existsSync(repo)) {
      await execFileAsync('git', ['clone', repoUrl, repo], {
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
      });
    }

    // Ensure active profile is set
    if (!loadSettings().syncActiveProfile) {
      updateSettings({ syncActiveProfile: DEFAULT_PROFILE });
    }

    // Check if repo has any commits
    const { code: logCode } = await gitMayFail(['log', '--oneline', '-1'], repo);
    const isEmpty = logCode !== 0;

    if (isEmpty) {
      // Empty repo — initial push into default profile folder
      copyLocalToSyncRepo();
      await git(['add', '-A'], repo);
      const { code: diffCode } = await gitMayFail(['diff', '--cached', '--quiet'], repo);
      if (diffCode !== 0) {
        await git(['commit', '-m', `sync: initial from ${hostname()}`], repo);
        await gitMayFail(['push', 'origin', 'HEAD'], repo);
      }
    } else {
      // Repo has content — check if it uses the profile folder structure
      const defaultDir = path.join(repo, DEFAULT_PROFILE);
      if (!fs.existsSync(defaultDir)) {
        // Legacy flat layout — migrate to profile structure
        await migrateToProfileLayout(repo);
      }
      applySyncRepoToLocal();
    }

    const now = new Date().toISOString();
    saveSyncConfig(repoUrl, now);
    const status: SyncStatusInfo = { status: 'idle', lastSyncedAt: now };
    setStatus(status);
    return status;
  } catch (err: any) {
    console.error('[sync] Setup failed:', err.message);
    const status: SyncStatusInfo = { status: 'error', lastSyncedAt: null, error: err.message || 'Setup failed' };
    setStatus(status);
    return status;
  } finally {
    syncing = false;
    suppressWatcher = true;
    setTimeout(() => { suppressWatcher = false; }, 2000);
  }
}

async function migrateToProfileLayout(repo: string): Promise<void> {
  console.log('[sync] Migrating flat layout to profile folders');
  const defaultDir = path.join(repo, DEFAULT_PROFILE);
  fs.mkdirSync(defaultDir, { recursive: true });

  // Move agentplex-settings.json and claude/ into default/
  const settingsFile = path.join(repo, 'agentplex-settings.json');
  if (fs.existsSync(settingsFile)) {
    fs.renameSync(settingsFile, path.join(defaultDir, 'agentplex-settings.json'));
  }
  const claudeDir = path.join(repo, 'claude');
  if (fs.existsSync(claudeDir)) {
    fs.renameSync(claudeDir, path.join(defaultDir, 'claude'));
  }

  await git(['add', '-A'], repo);
  const { code } = await gitMayFail(['diff', '--cached', '--quiet'], repo);
  if (code !== 0) {
    await git(['commit', '-m', 'sync: migrate to profile folder structure'], repo);
    await gitMayFail(['push', 'origin', 'HEAD'], repo);
  }
}

export async function pushSync(): Promise<SyncStatusInfo> {
  if (syncing) return { ...currentStatus, error: 'Sync already in progress' };
  const config = getSyncConfig();
  if (!config) return { status: 'not-configured', lastSyncedAt: null };

  syncing = true;
  setStatus({ status: 'syncing', lastSyncedAt: config.syncLastSyncedAt });

  try {
    const repo = syncRepoPath();

    copyLocalToSyncRepo();
    await git(['add', '-A'], repo);

    const { code: diffCode } = await gitMayFail(['diff', '--cached', '--quiet'], repo);
    if (diffCode === 0) {
      const status: SyncStatusInfo = { status: 'idle', lastSyncedAt: config.syncLastSyncedAt };
      setStatus(status);
      return status;
    }

    const timestamp = new Date().toISOString();
    await git(['commit', '-m', `sync: ${timestamp} from ${hostname()}`], repo);

    const branch = await detectDefaultBranch(repo);
    const { code: pullCode, stderr: pullErr } = await gitMayFail(
      ['pull', '--rebase', 'origin', branch], repo,
    );

    if (pullCode !== 0 && pullErr.includes('CONFLICT')) {
      await gitMayFail(['rebase', '--abort'], repo);
      const status: SyncStatusInfo = { status: 'conflict', lastSyncedAt: config.syncLastSyncedAt };
      setStatus(status);
      return status;
    }

    const { code: pushCode, stderr: pushErr } = await gitMayFail(['push', 'origin', 'HEAD'], repo);
    if (pushCode !== 0 && !pushErr.includes('->')) {
      throw new Error(pushErr || 'Push failed');
    }

    const now = new Date().toISOString();
    saveSyncConfig(config.syncRepoUrl, now);
    const status: SyncStatusInfo = { status: 'idle', lastSyncedAt: now };
    setStatus(status);
    return status;
  } catch (err: any) {
    console.error('[sync] Push failed:', err.message);
    const status: SyncStatusInfo = { status: 'error', lastSyncedAt: config.syncLastSyncedAt, error: err.message };
    setStatus(status);
    return status;
  } finally {
    syncing = false;
    suppressWatcher = true;
    setTimeout(() => { suppressWatcher = false; }, 2000);
  }
}

export async function pullSync(): Promise<SyncStatusInfo> {
  if (syncing) return { ...currentStatus, error: 'Sync already in progress' };
  const config = getSyncConfig();
  if (!config) return { status: 'not-configured', lastSyncedAt: null };

  syncing = true;
  setStatus({ status: 'syncing', lastSyncedAt: config.syncLastSyncedAt });

  try {
    const repo = syncRepoPath();
    const branch = await detectDefaultBranch(repo);

    const { code: stashCode } = await gitMayFail(['stash'], repo);

    const { code: pullCode, stderr: pullErr } = await gitMayFail(
      ['pull', 'origin', branch], repo,
    );

    if (pullCode !== 0 && pullErr.includes('CONFLICT')) {
      const status: SyncStatusInfo = { status: 'conflict', lastSyncedAt: config.syncLastSyncedAt };
      setStatus(status);
      return status;
    }

    if (pullCode !== 0) {
      throw new Error(pullErr || 'Pull failed');
    }

    if (stashCode === 0) {
      await gitMayFail(['stash', 'pop'], repo);
    }

    applySyncRepoToLocal();

    const now = new Date().toISOString();
    saveSyncConfig(config.syncRepoUrl, now);
    const status: SyncStatusInfo = { status: 'idle', lastSyncedAt: now };
    setStatus(status);
    return status;
  } catch (err: any) {
    console.error('[sync] Pull failed:', err.message);
    const status: SyncStatusInfo = { status: 'error', lastSyncedAt: config.syncLastSyncedAt, error: err.message };
    setStatus(status);
    return status;
  } finally {
    syncing = false;
    suppressWatcher = true;
    setTimeout(() => { suppressWatcher = false; }, 2000);
  }
}

export function getSyncStatus(): SyncStatusInfo {
  if (!getSyncConfig()) return { status: 'not-configured', lastSyncedAt: null };
  return currentStatus;
}

export function disconnectSync(): void {
  updateSettings({ syncRepoUrl: undefined, syncLastSyncedAt: undefined, syncAutoSync: undefined, syncActiveProfile: undefined });
  try { fs.rmSync(syncRepoPath(), { recursive: true, force: true }); } catch { /* ok */ }
  setStatus({ status: 'not-configured', lastSyncedAt: null });
}

// ── Auto-sync ───────────────────────────────────────────────────────────────

const AUTO_SYNC_POLL_MS = 5 * 60 * 1000; // 5 minutes
const DEBOUNCE_MS = 30_000; // 30 seconds after last local change

// Suppress file-watcher triggers while a sync operation is running
let suppressWatcher = false;

export function startAutoSync(): () => void {
  // Ensure syncClaudeIncludes is seeded so it's visible in the JSON editor
  if (!loadSettings().syncClaudeIncludes) {
    updateSettings({ syncClaudeIncludes: DEFAULT_CLAUDE_SYNC_INCLUDES });
  }

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const watchers: fs.FSWatcher[] = [];

  function schedulePush() {
    // Ignore events triggered by our own sync writes
    if (suppressWatcher || syncing) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      pushSync().catch((err) => console.error('[auto-sync] push error:', err));
    }, DEBOUNCE_MS);
  }

  // Only watch ~/.claude dirs/files — NOT settings.json (it changes on every sync config update)
  try {
    const claude = claudeHome();
    if (fs.existsSync(claude)) {
      for (const dir of getClaudeSyncIncludes()) {
        const full = path.join(claude, dir);
        if (!fs.existsSync(full)) continue;
        try {
          const stat = fs.statSync(full);
          if (stat.isDirectory()) {
            watchers.push(fs.watch(full, { recursive: true }, schedulePush));
          }
        } catch { /* skip */ }
      }
      watchers.push(fs.watch(claude, (_event, filename) => {
        if (filename && getClaudeSyncIncludes().has(filename)) {
          schedulePush();
        }
      }));
    }
  } catch { /* ok */ }

  // Poll remote using GitHub API with ETags (304 = no change, nearly free)
  pollTimer = setInterval(() => {
    checkRemoteAndPull().catch((err) => console.error('[auto-sync] poll error:', err));
  }, AUTO_SYNC_POLL_MS);

  return () => {
    if (pollTimer) clearInterval(pollTimer);
    if (debounceTimer) clearTimeout(debounceTimer);
    for (const w of watchers) {
      try { w.close(); } catch { /* ok */ }
    }
  };
}

// ── Lightweight GitHub API poll ─────────────────────────────────────────────

let lastEtag: string | null = null;

async function checkRemoteAndPull(): Promise<void> {
  if (syncing) return;

  const config = getSyncConfig();
  if (!config) return;

  // Parse owner/repo from the sync URL
  const match = config.syncRepoUrl.match(/([^/]+)\/([^/.]+?)(?:\.git)?$/);
  if (!match) {
    // Fallback to git fetch if URL can't be parsed
    await pullSync();
    return;
  }

  const [, owner, repo] = match;

  try {
    // Use gh api which handles auth automatically, pass ETag for conditional request
    const args = ['api', `repos/${owner}/${repo}/commits?per_page=1`, '--include'];
    if (lastEtag) {
      args.push('-H', `If-None-Match: ${lastEtag}`);
    }

    const result = await execFileAsync('gh', args, {
      windowsHide: true,
      timeout: 15_000,
    }).catch((err: any) => ({ stdout: err.stdout || '', stderr: err.stderr || '' }));

    const output = (result as any).stdout || '';

    // Check for 304 Not Modified
    if (output.includes('304 Not Modified') || output.includes('HTTP/2 304')) {
      return; // Nothing changed remotely
    }

    // Extract ETag from response headers
    const etagMatch = output.match(/etag:\s*"?([^"\r\n]+)"?/i);
    if (etagMatch) {
      lastEtag = etagMatch[1];
    }

    // Remote has new commits — do a pull
    console.log('[auto-sync] Remote changed, pulling...');
    await pullSync();
  } catch {
    // If gh api fails (not installed, no auth, etc.), fall back to git fetch poll
    await pullSync();
  }
}
