import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';

const SETTINGS_PATH = path.join(homedir(), '.agentplex', 'settings.json');

interface AppSettings {
  defaultShell?: string;
  [key: string]: unknown;
}

export function loadSettings(): AppSettings {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || ('defaultShell' in parsed && typeof parsed.defaultShell !== 'string')) {
      throw new Error('settings.json must contain an object with an optional string defaultShell');
    }
    return parsed as AppSettings;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    console.error('[settings] Failed to read:', error);
    throw error;
  }
}

function saveSettings(settings: AppSettings): void {
  const temporaryPath = `${SETTINGS_PATH}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
    const fd = fs.openSync(temporaryPath, 'wx');
    try {
      fs.writeFileSync(fd, JSON.stringify(settings, null, 2), 'utf-8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporaryPath, SETTINGS_PATH);
  } catch (error) {
    console.error('[settings] Failed to save:', error);
    throw error;
  } finally {
    try {
      fs.unlinkSync(temporaryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('[settings] Cannot remove temporary settings:', error);
      }
    }
  }
}

export function getDefaultShellId(): string | undefined {
  return loadSettings().defaultShell;
}

export function setDefaultShellId(id: string): void {
  saveSettings({ ...loadSettings(), defaultShell: id });
}
