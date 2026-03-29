import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// We'll test the settings-manager by pointing it at a temp directory.
// The module uses homedir() internally, so we mock it.
import { vi } from 'vitest';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplex-test-'));
  vi.doMock('os', async (importOriginal) => {
    const orig = await importOriginal<typeof import('os')>();
    return { ...orig, homedir: () => tmpDir };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadModule() {
  return await import('./settings-manager');
}

describe('settings-manager', () => {
  describe('loadSettings', () => {
    it('returns empty object when settings file does not exist', async () => {
      const mod = await loadModule();
      expect(mod.loadSettings()).toEqual({});
    });

    it('loads existing settings from disk', async () => {
      const dir = path.join(tmpDir, '.agentplex');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'settings.json'),
        JSON.stringify({ defaultShell: 'bash', fontSize: 14 }),
      );

      const mod = await loadModule();
      const settings = mod.loadSettings();
      expect(settings.defaultShell).toBe('bash');
      expect(settings.fontSize).toBe(14);
    });

    it('caches settings after first load', async () => {
      const dir = path.join(tmpDir, '.agentplex');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'settings.json'),
        JSON.stringify({ defaultShell: 'pwsh' }),
      );

      const mod = await loadModule();
      mod.loadSettings();

      // Mutate file on disk — cached value should still be returned
      fs.writeFileSync(
        path.join(dir, 'settings.json'),
        JSON.stringify({ defaultShell: 'changed' }),
      );
      expect(mod.loadSettings().defaultShell).toBe('pwsh');
    });
  });

  describe('getAllSettings', () => {
    it('returns a copy of settings (not the cached reference)', async () => {
      const mod = await loadModule();
      const a = mod.getAllSettings();
      const b = mod.getAllSettings();
      expect(a).toEqual(b);
      expect(a).not.toBe(b); // different object references
    });
  });

  describe('updateSettings', () => {
    it('merges partial settings into existing', async () => {
      const dir = path.join(tmpDir, '.agentplex');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'settings.json'),
        JSON.stringify({ defaultShell: 'bash', fontSize: 12 }),
      );

      const mod = await loadModule();
      mod.updateSettings({ fontSize: 16, fontFamily: 'Fira Code' });

      const result = mod.getAllSettings();
      expect(result.defaultShell).toBe('bash'); // preserved
      expect(result.fontSize).toBe(16); // updated
      expect(result.fontFamily).toBe('Fira Code'); // added
    });

    it('persists to disk', async () => {
      const mod = await loadModule();
      mod.updateSettings({ theme: 'light' });

      const raw = JSON.parse(
        fs.readFileSync(path.join(tmpDir, '.agentplex', 'settings.json'), 'utf-8'),
      );
      expect(raw.theme).toBe('light');
    });

    it('creates the directory if it does not exist', async () => {
      const mod = await loadModule();
      mod.updateSettings({ fontSize: 14 });
      expect(fs.existsSync(path.join(tmpDir, '.agentplex', 'settings.json'))).toBe(true);
    });
  });

  describe('invalidateCache', () => {
    it('forces next loadSettings to read from disk', async () => {
      const dir = path.join(tmpDir, '.agentplex');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'settings.json'),
        JSON.stringify({ defaultShell: 'bash' }),
      );

      const mod = await loadModule();
      mod.loadSettings(); // populate cache

      // Write new content to disk
      fs.writeFileSync(
        path.join(dir, 'settings.json'),
        JSON.stringify({ defaultShell: 'zsh' }),
      );

      // Without invalidate, cache still returns old value
      expect(mod.loadSettings().defaultShell).toBe('bash');

      // After invalidate, reads fresh from disk
      mod.invalidateCache();
      expect(mod.loadSettings().defaultShell).toBe('zsh');
    });
  });

  describe('sync config fields in settings', () => {
    it('stores and retrieves sync repo URL', async () => {
      const mod = await loadModule();
      mod.updateSettings({
        syncRepoUrl: 'https://github.com/user/my-settings.git',
        syncLastSyncedAt: '2026-03-28T10:00:00Z',
        syncAutoSync: true,
      });

      const result = mod.getAllSettings();
      expect(result.syncRepoUrl).toBe('https://github.com/user/my-settings.git');
      expect(result.syncLastSyncedAt).toBe('2026-03-28T10:00:00Z');
      expect(result.syncAutoSync).toBe(true);
    });

    it('handles arbitrary extension keys', async () => {
      const mod = await loadModule();
      mod.updateSettings({ customKey: 'customValue', nested: { a: 1 } });

      const result = mod.getAllSettings();
      expect(result.customKey).toBe('customValue');
      expect(result.nested).toEqual({ a: 1 });
    });
  });

  describe('backward compat', () => {
    it('getDefaultShellId and setDefaultShellId still work', async () => {
      const mod = await loadModule();
      expect(mod.getDefaultShellId()).toBeUndefined();

      mod.setDefaultShellId('gitbash');
      expect(mod.getDefaultShellId()).toBe('gitbash');

      // Should also be visible via getAllSettings
      expect(mod.getAllSettings().defaultShell).toBe('gitbash');
    });
  });
});
