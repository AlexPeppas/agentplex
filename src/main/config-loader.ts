import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { encodeProjectPath } from './jsonl-session-watcher';
import type { ClaudeConfig } from '../shared/ipc-channels';

const SETTINGS_PATH = path.join(homedir(), '.agentplex', 'settings.json');
const PROJECTS_DIR = path.join(homedir(), '.agentplex', 'projects');

const DEFAULT_CONFIG: ClaudeConfig = { command: 'claude', flags: [] };

const GLOBAL_TEMPLATE = JSON.stringify({
  claude: { command: '', flags: [] },
}, null, 2);

const PROJECT_TEMPLATE = JSON.stringify({
  claude: { command: '', flags: [] },
}, null, 2);

/** Flags that session-manager appends automatically — strip from user config. */
const RESERVED_FLAGS = new Set(['--session-id', '--resume']);

function readJsonSafe(filePath: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function extractClaudeBlock(obj: Record<string, unknown> | null): { command?: string; flags?: string[] } | null {
  if (!obj || typeof obj.claude !== 'object' || obj.claude === null || Array.isArray(obj.claude)) {
    return null;
  }
  const block = obj.claude as Record<string, unknown>;
  const result: { command?: string; flags?: string[] } = {};

  if ('command' in block && typeof block.command === 'string' && block.command.trim() !== '') {
    result.command = block.command.trim();
  }
  if ('flags' in block && Array.isArray(block.flags)) {
    const raw = (block.flags as unknown[]).filter((f): f is string => typeof f === 'string');
    // Strip reserved flags and their associated values (e.g. --session-id <value> or --session-id=value)
    const cleaned: string[] = [];
    for (let i = 0; i < raw.length; i++) {
      const flag = raw[i];
      // Handle --flag=value form
      const eqName = flag.split('=')[0];
      if (RESERVED_FLAGS.has(eqName)) continue;
      // Handle --flag <value> form: skip the next token too
      if (RESERVED_FLAGS.has(flag)) {
        i++; // skip the next argument (the value)
        continue;
      }
      cleaned.push(flag);
    }
    // Only set flags if non-empty, so empty array inherits from parent config
    if (cleaned.length > 0) {
      result.flags = cleaned;
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Resolve Claude launch config by merging user-level and per-project settings.
 * Read-only — never writes to disk.
 */
export function resolveClaudeConfig(projectPath: string): ClaudeConfig {
  // Read user-level
  const userJson = readJsonSafe(SETTINGS_PATH);
  const userBlock = extractClaudeBlock(userJson);

  // Read per-project
  const encoded = encodeProjectPath(projectPath);
  const projectConfigPath = path.join(PROJECTS_DIR, encoded, 'config.json');
  const projectJson = readJsonSafe(projectConfigPath);
  const projectBlock = extractClaudeBlock(projectJson);

  // Merge: project > user > default
  const command = projectBlock?.command ?? userBlock?.command ?? DEFAULT_CONFIG.command;
  const flags = projectBlock?.flags ?? userBlock?.flags ?? [...DEFAULT_CONFIG.flags];

  return { command, flags };
}

/** Project config file path for a given project directory. */
export function getProjectConfigPath(projectPath: string): string {
  const encoded = encodeProjectPath(projectPath);
  return path.join(PROJECTS_DIR, encoded, 'config.json');
}

/** Ensure a config file exists, creating it with the template if not. Returns the path. */
export function ensureGlobalConfig(): string {
  if (!fs.existsSync(SETTINGS_PATH)) {
    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, GLOBAL_TEMPLATE);
  }
  return SETTINGS_PATH;
}

export function ensureProjectConfig(projectPath: string): string {
  const configPath = getProjectConfigPath(projectPath);
  if (!fs.existsSync(configPath)) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, PROJECT_TEMPLATE);
  }
  return configPath;
}
