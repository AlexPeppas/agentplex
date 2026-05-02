import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import type { RemoteConfig } from './types';

const CONFIG_DIR = path.join(homedir(), '.agentplex');
const CONFIG_PATH = path.join(CONFIG_DIR, 'remote.json');
const DEFAULT_PORT = 19800;

let cachedConfig: RemoteConfig | null = null;

/** Load existing config or create one with a fresh token. */
export function loadOrCreateConfig(): RemoteConfig {
  if (cachedConfig) return cachedConfig;

  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<RemoteConfig>;
    if (typeof parsed.token === 'string' && parsed.token.length >= 32) {
      cachedConfig = {
        token: parsed.token,
        port: typeof parsed.port === 'number' ? parsed.port : DEFAULT_PORT,
        enabled: parsed.enabled !== false,
      };
      return cachedConfig;
    }
  } catch {
    // File doesn't exist or is malformed — create a new one
  }

  const config: RemoteConfig = {
    token: crypto.randomBytes(32).toString('hex'),
    port: DEFAULT_PORT,
    enabled: true,
  };

  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
  } catch (err: any) {
    console.error('[remote/auth] Failed to write config:', err.message);
  }

  cachedConfig = config;
  return config;
}

/** Validate a bearer token against the stored config. Constant-time comparison. */
export function validateToken(provided: string): boolean {
  const config = loadOrCreateConfig();
  if (provided.length !== config.token.length) return false;
  return crypto.timingSafeEqual(
    Buffer.from(provided, 'utf-8'),
    Buffer.from(config.token, 'utf-8'),
  );
}

/** Extract bearer token from an Authorization header value. */
export function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : null;
}

/** Extract token from a URL query string (?token=...). */
export function extractQueryToken(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url, 'http://localhost');
    return parsed.searchParams.get('token');
  } catch {
    return null;
  }
}

/** Regenerate the token (for security rotation). */
export function regenerateToken(): RemoteConfig {
  cachedConfig = null;
  try {
    fs.unlinkSync(CONFIG_PATH);
  } catch { /* ignore */ }
  return loadOrCreateConfig();
}
