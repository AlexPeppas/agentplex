import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';

const SETTINGS_PATH = path.join(homedir(), '.agentplex', 'settings.json');

interface AppSettings {
  defaultShell?: string;
}

let cached: AppSettings | null = null;

export function loadSettings(): AppSettings {
  if (cached) return cached;
  try {
    cached = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
    return cached!;
  } catch {
    cached = {};
    return cached;
  }
}

function saveSettings(settings: AppSettings): void {
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
