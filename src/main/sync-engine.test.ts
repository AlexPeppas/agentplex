import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

let tmpDir: string;
let agentplexHome: string;
let claudeHome: string;
let syncRepoPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplex-sync-test-'));
  agentplexHome = path.join(tmpDir, '.agentplex');
  claudeHome = path.join(tmpDir, '.claude');
  syncRepoPath = path.join(agentplexHome, 'sync-repo');

  fs.mkdirSync(agentplexHome, { recursive: true });
  fs.mkdirSync(claudeHome, { recursive: true });

  vi.doMock('os', async (importOriginal) => {
    const orig = await importOriginal<typeof import('os')>();
    return { ...orig, homedir: () => tmpDir };
  });

  // Mock electron BrowserWindow (not available in test)
  vi.doMock('electron', () => ({
    BrowserWindow: { getAllWindows: () => [] },
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadModule() {
  return await import('./sync-engine');
}

// ── Helpers to set up fixture files ─────────────────────────────────────────

function writeClaudeFiles() {
  // Files that SHOULD be synced (allowlist: CLAUDE.md, settings.json, agents, commands, plugins)
  fs.mkdirSync(path.join(claudeHome, 'commands'), { recursive: true });
  fs.writeFileSync(path.join(claudeHome, 'commands', 'deploy.md'), '# Deploy command');
  fs.writeFileSync(path.join(claudeHome, 'commands', 'test.md'), '# Test command');

  fs.mkdirSync(path.join(claudeHome, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(claudeHome, 'agents', 'reviewer.yml'), 'name: reviewer');

  fs.mkdirSync(path.join(claudeHome, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(claudeHome, 'plugins', 'my-plugin.json'), '{}');

  fs.writeFileSync(path.join(claudeHome, 'CLAUDE.md'), '# My global instructions');
  fs.writeFileSync(path.join(claudeHome, 'settings.json'), '{"model":"opus"}');

  // Files that should NOT be synced (not in allowlist)
  fs.writeFileSync(path.join(claudeHome, '.clauderc'), 'export CLAUDE_CODE=1');
  fs.writeFileSync(path.join(claudeHome, '.credentials'), 'secret-token');

  fs.mkdirSync(path.join(claudeHome, 'projects', 'some-project'), { recursive: true });
  fs.writeFileSync(path.join(claudeHome, 'projects', 'some-project', 'abc.jsonl'), '{}');

  fs.mkdirSync(path.join(claudeHome, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(claudeHome, 'sessions', 'active.json'), '{}');

  fs.mkdirSync(path.join(claudeHome, 'todos'), { recursive: true });
  fs.writeFileSync(path.join(claudeHome, 'todos', 'tasks.json'), '[]');

  fs.mkdirSync(path.join(claudeHome, 'sub-agents'), { recursive: true });
  fs.writeFileSync(path.join(claudeHome, 'sub-agents', 'old.yml'), 'name: old');
}

function writeAgentplexSettings(settings: Record<string, unknown>) {
  fs.writeFileSync(
    path.join(agentplexHome, 'settings.json'),
    JSON.stringify(settings, null, 2),
  );
}

function initBareGitRepo(): string {
  // Create a bare repo to act as our "GitHub remote"
  const { execFileSync } = require('child_process');
  const bareDir = path.join(tmpDir, 'remote-repo.git');
  execFileSync('git', ['init', '--bare', bareDir], { windowsHide: true });
  return bareDir;
}

function cloneRepoAt(remoteUrl: string, destDir: string) {
  const { execFileSync } = require('child_process');
  execFileSync('git', ['clone', remoteUrl, destDir], { windowsHide: true });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('sync-engine', () => {
  describe('getClaudeFilesToSync', () => {
    it('includes CLAUDE.md, settings.json, agents, commands, plugins', async () => {
      writeClaudeFiles();
      const mod = await loadModule();
      const files = mod.getClaudeFilesToSync();

      expect(files).toContain(path.join('commands', 'deploy.md'));
      expect(files).toContain(path.join('commands', 'test.md'));
      expect(files).toContain(path.join('agents', 'reviewer.yml'));
      expect(files).toContain(path.join('plugins', 'my-plugin.json'));
      expect(files).toContain('CLAUDE.md');
      expect(files).toContain('settings.json');
    });

    it('excludes everything not in the allowlist', async () => {
      writeClaudeFiles();
      const mod = await loadModule();
      const files = mod.getClaudeFilesToSync();

      for (const f of files) {
        expect(f).not.toMatch(/^projects/);
        expect(f).not.toMatch(/^sessions/);
        expect(f).not.toMatch(/^todos/);
        expect(f).not.toMatch(/^sub-agents/);
        expect(f).not.toBe('.credentials');
        expect(f).not.toBe('.clauderc');
      }
    });

    it('excludes files larger than 1MB', async () => {
      // CLAUDE.md is in the allowlist, so test with that name
      fs.writeFileSync(path.join(claudeHome, 'CLAUDE.md'), 'x'.repeat(1024 * 1024 + 1));
      fs.writeFileSync(path.join(claudeHome, 'settings.json'), '{}');

      const mod = await loadModule();
      const files = mod.getClaudeFilesToSync();

      expect(files).toContain('settings.json');
      expect(files).not.toContain('CLAUDE.md');
    });

    it('returns empty array when ~/.claude does not exist', async () => {
      fs.rmSync(claudeHome, { recursive: true, force: true });
      const mod = await loadModule();
      expect(mod.getClaudeFilesToSync()).toEqual([]);
    });
  });

  describe('copyLocalToSyncRepo', () => {
    it('copies agentplex settings into active profile folder', async () => {
      writeAgentplexSettings({ defaultShell: 'bash', fontSize: 14 });
      fs.mkdirSync(syncRepoPath, { recursive: true });

      const mod = await loadModule();
      mod.copyLocalToSyncRepo();

      const dest = path.join(syncRepoPath, 'default', 'agentplex-settings.json');
      expect(fs.existsSync(dest)).toBe(true);
      const content = JSON.parse(fs.readFileSync(dest, 'utf-8'));
      expect(content.defaultShell).toBe('bash');
      expect(content.fontSize).toBe(14);
    });

    it('copies claude files into profile claude/ subdirectory', async () => {
      writeClaudeFiles();
      fs.mkdirSync(syncRepoPath, { recursive: true });

      const mod = await loadModule();
      mod.copyLocalToSyncRepo();

      const profileDir = path.join(syncRepoPath, 'default');
      expect(fs.existsSync(path.join(profileDir, 'claude', 'CLAUDE.md'))).toBe(true);
      expect(fs.existsSync(path.join(profileDir, 'claude', 'commands', 'deploy.md'))).toBe(true);
      expect(fs.existsSync(path.join(profileDir, 'claude', 'agents', 'reviewer.yml'))).toBe(true);
      expect(fs.existsSync(path.join(profileDir, 'claude', 'plugins', 'my-plugin.json'))).toBe(true);

      // Non-allowlisted dirs should not appear
      expect(fs.existsSync(path.join(profileDir, 'claude', 'projects'))).toBe(false);
      expect(fs.existsSync(path.join(profileDir, 'claude', 'sessions'))).toBe(false);
      expect(fs.existsSync(path.join(profileDir, 'claude', 'sub-agents'))).toBe(false);
    });
  });

  describe('applySyncRepoToLocal', () => {
    it('copies agentplex-settings.json back to ~/.agentplex/settings.json', async () => {
      const profileDir = path.join(syncRepoPath, 'default');
      fs.mkdirSync(profileDir, { recursive: true });
      fs.writeFileSync(
        path.join(profileDir, 'agentplex-settings.json'),
        JSON.stringify({ theme: 'light', fontSize: 16 }),
      );

      const mod = await loadModule();
      mod.applySyncRepoToLocal();

      const settings = JSON.parse(
        fs.readFileSync(path.join(agentplexHome, 'settings.json'), 'utf-8'),
      );
      expect(settings.theme).toBe('light');
      expect(settings.fontSize).toBe(16);
    });

    it('copies claude/ files back to ~/.claude without deleting local-only files', async () => {
      // Existing local file that is NOT in sync repo
      fs.writeFileSync(path.join(claudeHome, 'local-only.txt'), 'keep me');

      // Sync repo has a command in the profile folder
      const profileDir = path.join(syncRepoPath, 'default');
      fs.mkdirSync(path.join(profileDir, 'claude', 'commands'), { recursive: true });
      fs.writeFileSync(
        path.join(profileDir, 'claude', 'commands', 'new-cmd.md'),
        '# New command',
      );

      const mod = await loadModule();
      mod.applySyncRepoToLocal();

      // New file should appear
      expect(fs.existsSync(path.join(claudeHome, 'commands', 'new-cmd.md'))).toBe(true);
      // Local-only file should still exist (additive merge)
      expect(fs.existsSync(path.join(claudeHome, 'local-only.txt'))).toBe(true);
    });
  });

  describe('setupSync', () => {
    it('clones the repo and performs initial push when repo is empty', async () => {
      const bareRepo = initBareGitRepo();
      writeClaudeFiles();
      writeAgentplexSettings({ defaultShell: 'bash' });

      const mod = await loadModule();
      const result = await mod.setupSync(bareRepo);

      expect(result.status).toBe('idle');
      expect(result.lastSyncedAt).toBeTruthy();
      expect(fs.existsSync(syncRepoPath)).toBe(true);

      // Settings should be persisted with sync config
      const config = mod.getSyncConfig();
      expect(config).not.toBeNull();
      expect(config!.syncRepoUrl).toBe(bareRepo);
    });

    it('pulls content when repo already has data', async () => {
      const bareRepo = initBareGitRepo();
      const { execFileSync } = require('child_process');

      // Seed the remote with some data
      const seedDir = path.join(tmpDir, 'seed');
      cloneRepoAt(bareRepo, seedDir);
      fs.mkdirSync(path.join(seedDir, 'claude', 'commands'), { recursive: true });
      fs.writeFileSync(
        path.join(seedDir, 'claude', 'commands', 'remote-cmd.md'),
        '# Remote command',
      );
      fs.writeFileSync(
        path.join(seedDir, 'agentplex-settings.json'),
        JSON.stringify({ fontSize: 18 }),
      );
      execFileSync('git', ['add', '-A'], { cwd: seedDir, windowsHide: true });
      execFileSync('git', ['commit', '-m', 'seed'], { cwd: seedDir, windowsHide: true });
      execFileSync('git', ['push', 'origin', 'HEAD'], { cwd: seedDir, windowsHide: true });

      const mod = await loadModule();
      const result = await mod.setupSync(bareRepo);

      expect(result.status).toBe('idle');

      // Remote command should now exist locally
      expect(
        fs.existsSync(path.join(claudeHome, 'commands', 'remote-cmd.md')),
      ).toBe(true);
    });
  });

  describe('pushSync', () => {
    it('returns not-configured when no sync config exists', async () => {
      const mod = await loadModule();
      const result = await mod.pushSync();
      expect(result.status).toBe('not-configured');
    });

    it('commits and pushes local changes', async () => {
      const bareRepo = initBareGitRepo();
      writeClaudeFiles();
      writeAgentplexSettings({ defaultShell: 'bash' });

      const mod = await loadModule();
      await mod.setupSync(bareRepo);

      // Add a new file locally
      fs.writeFileSync(path.join(claudeHome, 'commands', 'new.md'), '# New');

      const result = await mod.pushSync();
      expect(result.status).toBe('idle');
      expect(result.lastSyncedAt).toBeTruthy();

      // Verify the new file is in the remote by cloning fresh
      const verifyDir = path.join(tmpDir, 'verify');
      cloneRepoAt(bareRepo, verifyDir);
      expect(
        fs.existsSync(path.join(verifyDir, 'default', 'claude', 'commands', 'new.md')),
      ).toBe(true);
    });

    it('returns idle with no commit when nothing changed', async () => {
      const bareRepo = initBareGitRepo();
      writeClaudeFiles();
      writeAgentplexSettings({ defaultShell: 'bash' });

      const mod = await loadModule();
      await mod.setupSync(bareRepo);

      // Push again with no changes
      const result = await mod.pushSync();
      expect(result.status).toBe('idle');
    });
  });

  describe('pullSync', () => {
    it('returns not-configured when no sync config exists', async () => {
      const mod = await loadModule();
      const result = await mod.pullSync();
      expect(result.status).toBe('not-configured');
    });

    it('pulls remote changes and applies to local', async () => {
      const bareRepo = initBareGitRepo();
      writeClaudeFiles();
      writeAgentplexSettings({ defaultShell: 'bash' });

      const mod = await loadModule();
      await mod.setupSync(bareRepo);

      // Simulate a push from another machine (using profile folder structure)
      const { execFileSync } = require('child_process');
      const otherDir = path.join(tmpDir, 'other-machine');
      cloneRepoAt(bareRepo, otherDir);
      fs.mkdirSync(path.join(otherDir, 'default', 'claude', 'commands'), { recursive: true });
      fs.writeFileSync(
        path.join(otherDir, 'default', 'claude', 'commands', 'from-laptop.md'),
        '# From laptop',
      );
      execFileSync('git', ['add', '-A'], { cwd: otherDir, windowsHide: true });
      execFileSync('git', ['commit', '-m', 'from laptop'], { cwd: otherDir, windowsHide: true });
      execFileSync('git', ['push', 'origin', 'HEAD'], { cwd: otherDir, windowsHide: true });

      // Now pull
      const result = await mod.pullSync();
      expect(result.status).toBe('idle');

      // File from "laptop" should now exist locally
      expect(
        fs.existsSync(path.join(claudeHome, 'commands', 'from-laptop.md')),
      ).toBe(true);
    });
  });

  describe('disconnectSync', () => {
    it('removes sync config and repo directory', async () => {
      const bareRepo = initBareGitRepo();
      writeAgentplexSettings({ defaultShell: 'bash' });

      const mod = await loadModule();
      await mod.setupSync(bareRepo);

      expect(mod.getSyncConfig()).not.toBeNull();
      expect(fs.existsSync(syncRepoPath)).toBe(true);

      mod.disconnectSync();

      expect(mod.getSyncConfig()).toBeNull();
      expect(fs.existsSync(syncRepoPath)).toBe(false);
    });
  });

  describe('getSyncStatus', () => {
    it('returns not-configured when no config', async () => {
      const mod = await loadModule();
      expect(mod.getSyncStatus().status).toBe('not-configured');
    });

    it('returns idle after successful setup', async () => {
      const bareRepo = initBareGitRepo();
      writeAgentplexSettings({});

      const mod = await loadModule();
      await mod.setupSync(bareRepo);

      expect(mod.getSyncStatus().status).toBe('idle');
    });
  });

  describe('auto-sync', () => {
    it('startAutoSync returns a stop function', async () => {
      const bareRepo = initBareGitRepo();
      writeAgentplexSettings({});

      const mod = await loadModule();
      await mod.setupSync(bareRepo);

      const stop = mod.startAutoSync();
      expect(typeof stop).toBe('function');
      stop(); // should not throw
    });
  });

  describe('getGitHubUser', () => {
    it('parses username and host from gh auth status output', async () => {
      // Mock child_process to simulate gh auth status output
      vi.doMock('child_process', async (importOriginal) => {
        const orig = await importOriginal<typeof import('child_process')>();
        return {
          ...orig,
          execFile: (cmd: string, args: string[], opts: any, cb: any) => {
            if (cmd === 'gh' && args[0] === 'auth' && args[1] === 'status') {
              // gh auth status writes to stderr
              const proc = { stdout: '', stderr: '' };
              cb(null, {
                stdout: '',
                stderr: 'github.com\n  ✓ Logged in to github.com account testuser (keyring)\n  - Active account: true\n',
              });
              return proc;
            }
            return orig.execFile(cmd, args, opts, cb);
          },
        };
      });

      vi.resetModules();
      // Re-mock os and electron after resetModules
      vi.doMock('os', async (importOriginal) => {
        const orig = await importOriginal<typeof import('os')>();
        return { ...orig, homedir: () => tmpDir };
      });
      vi.doMock('electron', () => ({
        BrowserWindow: { getAllWindows: () => [] },
      }));

      const mod = await import('./sync-engine');
      const user = await mod.getGitHubUser();
      expect(user).not.toBeNull();
      expect(user!.username).toBe('testuser');
      expect(user!.host).toBe('github.com');
    });

    it('returns null when gh is not authenticated', async () => {
      vi.doMock('child_process', async (importOriginal) => {
        const orig = await importOriginal<typeof import('child_process')>();
        return {
          ...orig,
          execFile: (cmd: string, args: string[], opts: any, cb: any) => {
            if (cmd === 'gh') {
              cb(new Error('not authenticated'), { stdout: '', stderr: '' });
              return {};
            }
            return orig.execFile(cmd, args, opts, cb);
          },
        };
      });

      vi.resetModules();
      vi.doMock('os', async (importOriginal) => {
        const orig = await importOriginal<typeof import('os')>();
        return { ...orig, homedir: () => tmpDir };
      });
      vi.doMock('electron', () => ({
        BrowserWindow: { getAllWindows: () => [] },
      }));

      const mod = await import('./sync-engine');
      const user = await mod.getGitHubUser();
      expect(user).toBeNull();
    });

    it('handles GHE hosts', async () => {
      vi.doMock('child_process', async (importOriginal) => {
        const orig = await importOriginal<typeof import('child_process')>();
        return {
          ...orig,
          execFile: (cmd: string, args: string[], opts: any, cb: any) => {
            if (cmd === 'gh' && args[0] === 'auth' && args[1] === 'status') {
              cb(null, {
                stdout: '',
                stderr: 'enterprise.github.com\n  ✓ Logged in to enterprise.github.com account jdoe (keyring)\n',
              });
              return {};
            }
            return orig.execFile(cmd, args, opts, cb);
          },
        };
      });

      vi.resetModules();
      vi.doMock('os', async (importOriginal) => {
        const orig = await importOriginal<typeof import('os')>();
        return { ...orig, homedir: () => tmpDir };
      });
      vi.doMock('electron', () => ({
        BrowserWindow: { getAllWindows: () => [] },
      }));

      const mod = await import('./sync-engine');
      const user = await mod.getGitHubUser();
      expect(user).not.toBeNull();
      expect(user!.username).toBe('jdoe');
      expect(user!.host).toBe('enterprise.github.com');
    });
  });

  describe('SYNC_REPO_NAME', () => {
    it('is a fixed constant', async () => {
      const mod = await loadModule();
      expect(mod.SYNC_REPO_NAME).toBe('agentplex-sync');
    });
  });

  describe('profiles', () => {
    describe('listProfiles', () => {
      it('returns ["default"] when sync repo has no profile folders yet', async () => {
        const bareRepo = initBareGitRepo();
        writeAgentplexSettings({});
        writeClaudeFiles();

        const mod = await loadModule();
        await mod.setupSync(bareRepo);

        const profiles = mod.listProfiles();
        expect(profiles).toEqual(['default']);
      });

      it('returns all profile folder names sorted alphabetically', async () => {
        const bareRepo = initBareGitRepo();
        writeAgentplexSettings({});

        const mod = await loadModule();
        await mod.setupSync(bareRepo);

        // Create extra profiles by making folders in the sync repo
        const repo = path.join(agentplexHome, 'sync-repo');
        fs.mkdirSync(path.join(repo, 'work'), { recursive: true });
        fs.writeFileSync(path.join(repo, 'work', 'agentplex-settings.json'), '{}');
        fs.mkdirSync(path.join(repo, 'personal'), { recursive: true });
        fs.writeFileSync(path.join(repo, 'personal', 'agentplex-settings.json'), '{}');

        const profiles = mod.listProfiles();
        expect(profiles).toEqual(['default', 'personal', 'work']);
      });
    });

    describe('createProfile', () => {
      it('creates a new profile folder by copying from current profile', async () => {
        const bareRepo = initBareGitRepo();
        writeAgentplexSettings({ fontSize: 14 });
        writeClaudeFiles();

        const mod = await loadModule();
        await mod.setupSync(bareRepo);

        await mod.createProfile('work');

        const profiles = mod.listProfiles();
        expect(profiles).toContain('work');

        // Should have copied settings from default
        const repo = path.join(agentplexHome, 'sync-repo');
        const workSettings = JSON.parse(
          fs.readFileSync(path.join(repo, 'work', 'agentplex-settings.json'), 'utf-8'),
        );
        expect(workSettings.fontSize).toBe(14);
      });

      it('rejects creating a profile named "default"', async () => {
        const bareRepo = initBareGitRepo();
        writeAgentplexSettings({});

        const mod = await loadModule();
        await mod.setupSync(bareRepo);

        await expect(mod.createProfile('default')).rejects.toThrow();
      });

      it('rejects creating a duplicate profile', async () => {
        const bareRepo = initBareGitRepo();
        writeAgentplexSettings({});

        const mod = await loadModule();
        await mod.setupSync(bareRepo);
        await mod.createProfile('work');

        await expect(mod.createProfile('work')).rejects.toThrow();
      });
    });

    describe('switchProfile', () => {
      it('auto-pushes current profile before switching', async () => {
        const bareRepo = initBareGitRepo();
        writeAgentplexSettings({ fontSize: 12 });
        writeClaudeFiles();

        const mod = await loadModule();
        await mod.setupSync(bareRepo);
        await mod.createProfile('work');

        // Change a local setting
        fs.writeFileSync(
          path.join(agentplexHome, 'settings.json'),
          JSON.stringify({ fontSize: 20 }),
        );

        // Switch to work — should auto-push default first
        await mod.switchProfile('work');

        // Verify default profile in repo has the updated settings
        const repo = path.join(agentplexHome, 'sync-repo');
        const defaultSettings = JSON.parse(
          fs.readFileSync(path.join(repo, 'default', 'agentplex-settings.json'), 'utf-8'),
        );
        expect(defaultSettings.fontSize).toBe(20);
      });

      it('applies the target profile files to local', async () => {
        const bareRepo = initBareGitRepo();
        writeAgentplexSettings({ fontSize: 12 });
        writeClaudeFiles();

        const mod = await loadModule();
        await mod.setupSync(bareRepo);
        await mod.createProfile('work');

        // Modify the work profile's settings directly in repo
        const repo = path.join(agentplexHome, 'sync-repo');
        fs.writeFileSync(
          path.join(repo, 'work', 'agentplex-settings.json'),
          JSON.stringify({ fontSize: 18, theme: 'light' }),
        );

        await mod.switchProfile('work');

        // Local settings should now reflect work profile
        const local = JSON.parse(
          fs.readFileSync(path.join(agentplexHome, 'settings.json'), 'utf-8'),
        );
        expect(local.fontSize).toBe(18);
        expect(local.theme).toBe('light');
      });

      it('updates syncActiveProfile in settings', async () => {
        const bareRepo = initBareGitRepo();
        writeAgentplexSettings({});

        const mod = await loadModule();
        await mod.setupSync(bareRepo);
        await mod.createProfile('personal');
        await mod.switchProfile('personal');

        const settings = mod.getActiveProfile();
        expect(settings).toBe('personal');
      });

      it('rejects switching to a non-existent profile', async () => {
        const bareRepo = initBareGitRepo();
        writeAgentplexSettings({});

        const mod = await loadModule();
        await mod.setupSync(bareRepo);

        await expect(mod.switchProfile('nonexistent')).rejects.toThrow();
      });
    });

    describe('renameProfile', () => {
      it('renames a profile folder in the sync repo', async () => {
        const bareRepo = initBareGitRepo();
        writeAgentplexSettings({});

        const mod = await loadModule();
        await mod.setupSync(bareRepo);
        await mod.createProfile('work');

        await mod.renameProfile('work', 'office');

        const profiles = mod.listProfiles();
        expect(profiles).toContain('office');
        expect(profiles).not.toContain('work');
      });

      it('rejects renaming the default profile', async () => {
        const bareRepo = initBareGitRepo();
        writeAgentplexSettings({});

        const mod = await loadModule();
        await mod.setupSync(bareRepo);

        await expect(mod.renameProfile('default', 'main')).rejects.toThrow();
      });

      it('updates syncActiveProfile if renaming the active profile', async () => {
        const bareRepo = initBareGitRepo();
        writeAgentplexSettings({});

        const mod = await loadModule();
        await mod.setupSync(bareRepo);
        await mod.createProfile('work');
        await mod.switchProfile('work');

        await mod.renameProfile('work', 'office');

        expect(mod.getActiveProfile()).toBe('office');
      });
    });

    describe('deleteProfile', () => {
      it('removes a profile folder from the sync repo', async () => {
        const bareRepo = initBareGitRepo();
        writeAgentplexSettings({});

        const mod = await loadModule();
        await mod.setupSync(bareRepo);
        await mod.createProfile('temp');

        await mod.deleteProfile('temp');

        const profiles = mod.listProfiles();
        expect(profiles).not.toContain('temp');
      });

      it('rejects deleting the default profile', async () => {
        const bareRepo = initBareGitRepo();
        writeAgentplexSettings({});

        const mod = await loadModule();
        await mod.setupSync(bareRepo);

        await expect(mod.deleteProfile('default')).rejects.toThrow();
      });

      it('switches to default if deleting the active profile', async () => {
        const bareRepo = initBareGitRepo();
        writeAgentplexSettings({});

        const mod = await loadModule();
        await mod.setupSync(bareRepo);
        await mod.createProfile('work');
        await mod.switchProfile('work');

        await mod.deleteProfile('work');

        expect(mod.getActiveProfile()).toBe('default');
      });
    });

    describe('profile-aware sync', () => {
      it('copyLocalToSyncRepo writes into the active profile folder', async () => {
        const bareRepo = initBareGitRepo();
        writeAgentplexSettings({ fontSize: 14 });
        writeClaudeFiles();

        const mod = await loadModule();
        await mod.setupSync(bareRepo);

        // Default profile — files should be under default/
        const repo = path.join(agentplexHome, 'sync-repo');
        expect(
          fs.existsSync(path.join(repo, 'default', 'agentplex-settings.json')),
        ).toBe(true);
        expect(
          fs.existsSync(path.join(repo, 'default', 'claude', 'CLAUDE.md')),
        ).toBe(true);
      });

      it('applySyncRepoToLocal reads from the active profile folder', async () => {
        const bareRepo = initBareGitRepo();
        writeAgentplexSettings({});

        const mod = await loadModule();
        await mod.setupSync(bareRepo);
        await mod.createProfile('work');

        // Put specific content in work profile
        const repo = path.join(agentplexHome, 'sync-repo');
        fs.mkdirSync(path.join(repo, 'work', 'claude', 'commands'), { recursive: true });
        fs.writeFileSync(
          path.join(repo, 'work', 'claude', 'commands', 'work-deploy.md'),
          '# Work deploy',
        );

        await mod.switchProfile('work');

        expect(
          fs.existsSync(path.join(claudeHome, 'commands', 'work-deploy.md')),
        ).toBe(true);
      });
    });
  });

  describe('configurable syncClaudeIncludes', () => {
    it('uses custom includes from settings when set', async () => {
      // Write a custom include list that only syncs CLAUDE.md
      writeAgentplexSettings({ syncClaudeIncludes: ['CLAUDE.md'] });
      writeClaudeFiles();

      const mod = await loadModule();
      const files = mod.getClaudeFilesToSync();

      expect(files).toContain('CLAUDE.md');
      expect(files).not.toContain('settings.json');
      expect(files).not.toContain(path.join('commands', 'deploy.md'));
    });

    it('falls back to defaults when syncClaudeIncludes is empty', async () => {
      writeAgentplexSettings({ syncClaudeIncludes: [] });
      writeClaudeFiles();

      const mod = await loadModule();
      const files = mod.getClaudeFilesToSync();

      // Should use defaults
      expect(files).toContain('CLAUDE.md');
      expect(files).toContain(path.join('commands', 'deploy.md'));
    });

    it('seeds syncClaudeIncludes into settings on first sync setup', async () => {
      const bareRepo = initBareGitRepo();
      writeAgentplexSettings({});

      const mod = await loadModule();
      await mod.setupSync(bareRepo);

      // Read settings from disk
      const settings = JSON.parse(
        fs.readFileSync(path.join(agentplexHome, 'settings.json'), 'utf-8'),
      );
      expect(settings.syncClaudeIncludes).toEqual(
        ['CLAUDE.md', 'settings.json', 'agents', 'commands', 'plugins'],
      );
    });
  });

  describe('migrateToProfileLayout', () => {
    it('moves flat layout files into default/ folder', async () => {
      const bareRepo = initBareGitRepo();
      const { execFileSync } = require('child_process');

      // Seed the remote with flat (legacy) layout
      const seedDir = path.join(tmpDir, 'seed');
      cloneRepoAt(bareRepo, seedDir);
      fs.writeFileSync(
        path.join(seedDir, 'agentplex-settings.json'),
        JSON.stringify({ fontSize: 14 }),
      );
      fs.mkdirSync(path.join(seedDir, 'claude', 'commands'), { recursive: true });
      fs.writeFileSync(path.join(seedDir, 'claude', 'commands', 'old.md'), '# Old');
      execFileSync('git', ['add', '-A'], { cwd: seedDir, windowsHide: true });
      execFileSync('git', ['commit', '-m', 'flat layout'], { cwd: seedDir, windowsHide: true });
      execFileSync('git', ['push', 'origin', 'HEAD'], { cwd: seedDir, windowsHide: true });

      // Now setupSync should detect flat layout and migrate
      writeAgentplexSettings({});
      const mod = await loadModule();
      const result = await mod.setupSync(bareRepo);

      expect(result.status).toBe('idle');

      // Verify migration happened — files should be under default/
      const repo = path.join(agentplexHome, 'sync-repo');
      expect(
        fs.existsSync(path.join(repo, 'default', 'agentplex-settings.json')),
      ).toBe(true);
      expect(
        fs.existsSync(path.join(repo, 'default', 'claude', 'commands', 'old.md')),
      ).toBe(true);
      // Flat files should no longer exist at root
      expect(
        fs.existsSync(path.join(repo, 'agentplex-settings.json')),
      ).toBe(false);

      // And the migrated settings should have been applied locally
      expect(
        fs.existsSync(path.join(claudeHome, 'commands', 'old.md')),
      ).toBe(true);
    });
  });

  describe('applySyncRepoToLocal preserves sync config', () => {
    it('does not overwrite syncRepoUrl and syncActiveProfile from synced settings', async () => {
      const bareRepo = initBareGitRepo();
      writeAgentplexSettings({});
      writeClaudeFiles();

      const mod = await loadModule();
      await mod.setupSync(bareRepo);

      // Verify sync config fields survive a pull
      // The synced agentplex-settings.json won't have syncRepoUrl
      // but the local one should retain it after applySyncRepoToLocal
      const settingsAfter = JSON.parse(
        fs.readFileSync(path.join(agentplexHome, 'settings.json'), 'utf-8'),
      );
      expect(settingsAfter.syncRepoUrl).toBe(bareRepo);
      expect(settingsAfter.syncActiveProfile).toBe('default');
    });
  });
});
