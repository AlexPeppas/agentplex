import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';

export interface AppPreferences {
  defaultShell?: string;
  fontSize?: number;
  fontFamily?: string;
  theme?: 'dark' | 'light';
  terminalBellEnabled?: boolean;
  editorWordWrap?: 'off' | 'on';
  syncRepoUrl?: string;
  syncLastSyncedAt?: string | null;
  syncAutoSync?: boolean;
  [key: string]: unknown;
}

const SETTINGS_PATH = path.join(homedir(), '.agentplex', 'settings.json');

let cached: AppPreferences | null = null;

export function loadSettings(): AppPreferences {
  if (cached) return cached;
  try {
    cached = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
    return cached!;
  } catch {
    cached = {};
    return cached;
  }
}

function saveSettings(settings: AppPreferences): void {
  cached = settings;
  try {
    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  } catch (err: any) {
    console.error('[settings] Failed to save:', err.message);
  }
}

export function getDefaultShellId(): string | undefined {
  return loadSettings().defaultShell;
}

export function setDefaultShellId(id: string): void {
  const settings = loadSettings();
  settings.defaultShell = id;
  saveSettings(settings);
}

export function getAllSettings(): AppPreferences {
  return { ...loadSettings() };
}

export function updateSettings(partial: Partial<AppPreferences>): void {
  const current = loadSettings();
  saveSettings({ ...current, ...partial });
}

export function invalidateCache(): void {
  cached = null;
}
