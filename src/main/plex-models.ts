import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { copilotCommand, githubToken } from './plex-cli';
import { validatePlexModel, type PlexModel } from '../shared/plex';

export function parseCopilotModels(value: unknown): PlexModel[] {
  if (!Array.isArray(value) || !value.length || value.length > 500) throw new Error('Copilot returned no usable model catalogue');
  const models = value.map(value => {
    if (!value || typeof value !== 'object') throw new Error('Invalid Copilot model entry');
    const item = value as Record<string, unknown>;
    const id = validatePlexModel(item.modelId);
    if (!id || typeof item.name !== 'string' || !item.name || item.name.length > 300) throw new Error('Invalid Copilot model entry');
    const meta = item._meta as Record<string, unknown> | undefined;
    return { id, name: item.name, enabled: !meta?.copilotEnablement || meta.copilotEnablement === 'enabled' };
  });
  if (new Set(models.map(model => model.id)).size !== models.length) throw new Error('Duplicate Copilot model IDs');
  return models;
}

/** ACP session/new returns the authenticated catalogue without sending a prompt or invoking tools. */
export async function discoverPlexModels(): Promise<PlexModel[]> {
  const token = await githubToken();
  const home = fs.mkdtempSync(path.join(tmpdir(), 'plex-models-'));
  try {
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ disableAllHooks: true, 'ide.autoConnect': false }));
    return await new Promise<PlexModel[]>((resolve, reject) => {
      const env: NodeJS.ProcessEnv = { ...process.env, COPILOT_HOME: home, COPILOT_GITHUB_TOKEN: token, COPILOT_ALLOW_ALL: 'false' };
      delete env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS;
      const child = spawn(copilotCommand(), ['--acp', '--no-auto-update', '--no-custom-instructions',
        '--disable-builtin-mcps', '--no-remote', '--no-remote-export'], {
        cwd: home, env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
      });
      let buffer = '';
      let models: PlexModel[] | undefined;
      let failure: Error | undefined;
      let finished = false;
      const stop = (error?: Error) => {
        if (finished) return;
        finished = true;
        failure = error;
        child.kill();
      };
      const timer = setTimeout(() => stop(new Error('Copilot model discovery timed out')), 40_000);
      const send = (id: number, method: string, params: object) =>
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      child.stdout.setEncoding('utf8');
      child.stderr.resume();
      child.stdin.on('error', error => stop(new Error(`Cannot query Copilot models: ${error.message}`)));
      child.on('error', error => { failure = new Error(`Cannot start Copilot model discovery: ${error.message}`); });
      child.stdout.on('data', (chunk: string) => {
        if (finished) return;
        try {
          buffer += chunk;
          if (buffer.length > 4_000_000) throw new Error('Oversized Copilot model response');
          let newline: number;
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
            if (!line.trim()) continue;
            const response = JSON.parse(line);
            if (response.error) throw new Error(`Copilot model discovery failed: ${response.error.message ?? 'Protocol error'}`);
            if (response.id === 1 && response.result) send(2, 'session/new', { cwd: home, mcpServers: [] });
            else if (response.id === 2 && response.result) {
              models = parseCopilotModels(response.result.models?.availableModels);
              stop();
            } else if (response.method && response.id !== undefined) {
              child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: response.id,
                error: { code: -32601, message: 'Model discovery does not support client operations' } }) + '\n');
            }
          }
        } catch (error) { stop(error instanceof Error ? error : new Error(String(error))); }
      });
      child.on('close', () => {
        clearTimeout(timer);
        if (failure) reject(failure);
        else if (!models) reject(new Error('Copilot exited without a model catalogue'));
        else resolve(models);
      });
      send(1, 'initialize', { protocolVersion: 1, clientCapabilities: {},
        clientInfo: { name: 'AgentPlex', version: '1' } });
    });
  } finally { fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}

let pending: Promise<PlexModel[]> | undefined;
export function listPlexModels(): Promise<PlexModel[]> {
  return pending ??= discoverPlexModels().finally(() => { pending = undefined; });
}
