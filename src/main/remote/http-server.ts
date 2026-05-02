import * as http from 'http';
import type { SessionManager } from '../session-manager';
import type { CliTool } from '../../shared/ipc-channels';
import { extractBearerToken, validateToken } from './auth';
import { RateLimiter } from './rate-limiter';
import { getGitStatus, getFileDiff, saveFile, stageFile, unstageFile, stageAll, unstageAll, gitCommit, gitPush, gitPull, gitLog, gitBranchInfo } from '../git-operations';
import { scanProjects, scanSessionsForProject, getPinnedProjects, updatePinnedProjects, resolveProjectPath } from '../claude-session-scanner';
import { detectShells, getCachedShells } from '../shell-detector';
import { getDefaultShellId, setDefaultShellId } from '../settings-manager';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
// Lazy import to avoid circular dependency (index.ts imports http-server.ts)
function getRelayModule() {
  return require('./index') as typeof import('./index');
}

const VERSION = '1.5.0';

// Rate limit: 100 requests per 10 seconds
const rateLimiter = new RateLimiter(100, 10_000);

// ── Helpers ─────────────────────────────────────────────────────────────────

function jsonResponse(res: http.ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  res.end(json);
}

function errorResponse(res: http.ServerResponse, status: number, error: string, code?: string) {
  jsonResponse(res, status, { error, ...(code && { code }) });
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const MAX_BODY = 2 * 1024 * 1024; // 2MB

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

async function parseJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  const raw = await readBody(req);
  if (!raw) throw new Error('Empty request body');
  return JSON.parse(raw) as T;
}

/** Simple URL pattern matcher. Returns params or null. */
function matchRoute(pattern: string, pathname: string): Record<string, string> | null {
  const patternParts = pattern.split('/');
  const pathParts = pathname.split('/');
  if (patternParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) {
      params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

// ── Route handler type ──────────────────────────────────────────────────────

type RouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  params: Record<string, string>,
  sm: SessionManager,
) => Promise<void>;

interface Route {
  method: string;
  pattern: string;
  handler: RouteHandler;
}

// ── Route definitions ───────────────────────────────────────────────────────

const routes: Route[] = [
  // ── Health (no auth) ──
  {
    method: 'GET',
    pattern: '/api/v1/health',
    handler: async (_req, res) => {
      jsonResponse(res, 200, { status: 'ok', version: VERSION });
    },
  },

  // ── Sessions ──
  {
    method: 'POST',
    pattern: '/api/v1/sessions',
    handler: async (req, res, _params, sm) => {
      const body = await parseJsonBody<{ cwd?: string; cli?: string; resumeSessionId?: string }>(req);
      const info = sm.create(body.cwd, (body.cli || 'claude') as CliTool, body.resumeSessionId);
      jsonResponse(res, 201, info);
    },
  },
  {
    method: 'GET',
    pattern: '/api/v1/sessions',
    handler: async (_req, res, _params, sm) => {
      jsonResponse(res, 200, sm.list());
    },
  },
  {
    method: 'GET',
    pattern: '/api/v1/sessions/persisted',
    handler: async (_req, res, _params, sm) => {
      jsonResponse(res, 200, sm.loadState());
    },
  },
  {
    method: 'GET',
    pattern: '/api/v1/sessions/external',
    handler: async (_req, res, _params, sm) => {
      jsonResponse(res, 200, sm.discoverExternal());
    },
  },
  {
    method: 'GET',
    pattern: '/api/v1/sessions/display-names',
    handler: async (_req, res, _params, sm) => {
      jsonResponse(res, 200, sm.getDisplayNames());
    },
  },
  {
    method: 'POST',
    pattern: '/api/v1/sessions/restore',
    handler: async (_req, res, _params, sm) => {
      const results = sm.restoreAll();
      jsonResponse(res, 200, results);
    },
  },
  {
    method: 'POST',
    pattern: '/api/v1/sessions/adopt',
    handler: async (req, res, _params, sm) => {
      const body = await parseJsonBody<{ sessionUuid: string; cwd: string }>(req);
      if (!body.sessionUuid || !body.cwd) {
        errorResponse(res, 400, 'Missing sessionUuid or cwd');
        return;
      }
      const info = sm.adoptExternal(body.sessionUuid, body.cwd);
      jsonResponse(res, 201, info);
    },
  },
  {
    method: 'GET',
    pattern: '/api/v1/sessions/:id/buffer',
    handler: async (_req, res, params, sm) => {
      const buffer = sm.getBuffer(params.id);
      jsonResponse(res, 200, { buffer });
    },
  },
  {
    method: 'GET',
    pattern: '/api/v1/sessions/:id/cwd',
    handler: async (_req, res, params, sm) => {
      const cwd = sm.getCwd(params.id);
      jsonResponse(res, 200, { cwd });
    },
  },
  {
    method: 'DELETE',
    pattern: '/api/v1/sessions/:id',
    handler: async (_req, res, params, sm) => {
      sm.kill(params.id);
      jsonResponse(res, 200, { ok: true });
    },
  },
  {
    method: 'POST',
    pattern: '/api/v1/sessions/:id/summarize',
    handler: async (req, res, params, sm) => {
      const body = await parseJsonBody<{ sourceLabel: string }>(req);
      // Reuse the summarize logic from ipc-handlers — import dynamically to avoid circular deps
      const jsonlPath = sm.getJsonlPath(params.id);
      let conversation = '';

      if (jsonlPath) {
        try {
          const raw = fs.readFileSync(jsonlPath, 'utf-8');
          const messages: string[] = [];
          for (const line of raw.split('\n')) {
            if (!line.trim()) continue;
            try {
              const record = JSON.parse(line);
              if (record.type === 'user' || record.type === 'assistant') {
                const content = record.message?.content;
                if (typeof content === 'string') {
                  messages.push(`[${record.type === 'user' ? 'User' : 'Assistant'}]\n${content}`);
                } else if (Array.isArray(content)) {
                  for (const block of content) {
                    if (block.type === 'text' && block.text) {
                      messages.push(`[${record.type === 'user' ? 'User' : 'Assistant'}]\n${block.text}`);
                    } else if (block.type === 'tool_use') {
                      const toolName = block.name || 'tool';
                      const desc = block.input?.description || block.input?.command || block.input?.pattern || '';
                      const preview = typeof desc === 'string' ? desc.slice(0, 200) : '';
                      messages.push(`[Tool: ${toolName}]${preview ? ' ' + preview : ''}`);
                    }
                  }
                }
              }
            } catch { /* skip malformed line */ }
          }
          conversation = messages.join('\n\n');
        } catch { /* ignore */ }
      }

      if (!conversation) {
        const buffer = sm.getBuffer(params.id);
        if (buffer) {
          const { stripAnsi } = await import('../../shared/ansi-strip');
          conversation = stripAnsi(buffer).slice(-100_000);
        }
      }

      if (!conversation) {
        jsonResponse(res, 200, { summary: null, error: 'No conversation data available' });
        return;
      }

      const safeContext = conversation.length > 100_000 ? conversation.slice(-100_000) : conversation;
      const safeLabel = (body.sourceLabel || '').slice(0, 200);
      const apiKey = process.env.AGENTPLEX_API_KEY;
      if (!apiKey) {
        jsonResponse(res, 200, { summary: null, error: 'AGENTPLEX_API_KEY not set' });
        return;
      }

      try {
        const { default: Anthropic } = await import('@anthropic-ai/sdk');
        const client = new Anthropic({ apiKey });
        const response = await client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 2000,
          messages: [{
            role: 'user',
            content: `You are summarizing the full conversation of an AI coding assistant session called "${safeLabel}". This summary will be sent to another AI assistant session so it can understand what the source session has been working on.\n\nSummarize the following conversation concisely. Focus on:\n- What task/goal the session is working on\n- Key decisions made or approaches taken\n- Current state (what's done, what's in progress, any blockers)\n- Any important file paths, function names, or technical details\n\nKeep it under 2000 tokens. Be direct and factual.\n\n<conversation>\n${safeContext}\n</conversation>`,
          }],
        });
        const text = response.content.find((b: any) => b.type === 'text');
        jsonResponse(res, 200, { summary: text ? (text as any).text : null, error: null });
      } catch (err: any) {
        jsonResponse(res, 200, { summary: null, error: err.message || 'Summarization failed' });
      }
    },
  },

  // ── Git ──
  {
    method: 'GET',
    pattern: '/api/v1/git/:sessionId/status',
    handler: async (_req, res, params, sm) => {
      const cwd = sm.getSessionCwd(params.sessionId);
      if (!cwd) { errorResponse(res, 404, 'Session not found'); return; }
      jsonResponse(res, 200, await getGitStatus(cwd));
    },
  },
  {
    method: 'POST',
    pattern: '/api/v1/git/:sessionId/diff',
    handler: async (req, res, params, sm) => {
      const cwd = sm.getSessionCwd(params.sessionId);
      if (!cwd) { errorResponse(res, 404, 'Session not found'); return; }
      const status = await getGitStatus(cwd);
      if (!status.isRepo) { errorResponse(res, 400, 'Not a git repository'); return; }
      const body = await parseJsonBody<{ filePath: string; staged?: boolean }>(req);
      jsonResponse(res, 200, await getFileDiff(status.repoRoot, body.filePath, !!body.staged));
    },
  },
  {
    method: 'POST',
    pattern: '/api/v1/git/:sessionId/save',
    handler: async (req, res, params, sm) => {
      const cwd = sm.getSessionCwd(params.sessionId);
      if (!cwd) { errorResponse(res, 404, 'Session not found'); return; }
      const status = await getGitStatus(cwd);
      if (!status.isRepo) { errorResponse(res, 400, 'Not a git repository'); return; }
      const body = await parseJsonBody<{ filePath: string; content: string }>(req);
      await saveFile(status.repoRoot, body.filePath, body.content);
      jsonResponse(res, 200, { ok: true });
    },
  },
  {
    method: 'POST',
    pattern: '/api/v1/git/:sessionId/stage',
    handler: async (req, res, params, sm) => {
      const cwd = sm.getSessionCwd(params.sessionId);
      if (!cwd) { errorResponse(res, 404, 'Session not found'); return; }
      const status = await getGitStatus(cwd);
      if (!status.isRepo) { errorResponse(res, 400, 'Not a git repository'); return; }
      const body = await parseJsonBody<{ filePath: string }>(req);
      await stageFile(status.repoRoot, body.filePath);
      jsonResponse(res, 200, { ok: true });
    },
  },
  {
    method: 'POST',
    pattern: '/api/v1/git/:sessionId/unstage',
    handler: async (req, res, params, sm) => {
      const cwd = sm.getSessionCwd(params.sessionId);
      if (!cwd) { errorResponse(res, 404, 'Session not found'); return; }
      const status = await getGitStatus(cwd);
      if (!status.isRepo) { errorResponse(res, 400, 'Not a git repository'); return; }
      const body = await parseJsonBody<{ filePath: string }>(req);
      await unstageFile(status.repoRoot, body.filePath);
      jsonResponse(res, 200, { ok: true });
    },
  },
  {
    method: 'POST',
    pattern: '/api/v1/git/:sessionId/stage-all',
    handler: async (_req, res, params, sm) => {
      const cwd = sm.getSessionCwd(params.sessionId);
      if (!cwd) { errorResponse(res, 404, 'Session not found'); return; }
      const status = await getGitStatus(cwd);
      if (!status.isRepo) { errorResponse(res, 400, 'Not a git repository'); return; }
      await stageAll(status.repoRoot);
      jsonResponse(res, 200, { ok: true });
    },
  },
  {
    method: 'POST',
    pattern: '/api/v1/git/:sessionId/unstage-all',
    handler: async (_req, res, params, sm) => {
      const cwd = sm.getSessionCwd(params.sessionId);
      if (!cwd) { errorResponse(res, 404, 'Session not found'); return; }
      const status = await getGitStatus(cwd);
      if (!status.isRepo) { errorResponse(res, 400, 'Not a git repository'); return; }
      await unstageAll(status.repoRoot);
      jsonResponse(res, 200, { ok: true });
    },
  },
  {
    method: 'POST',
    pattern: '/api/v1/git/:sessionId/commit',
    handler: async (req, res, params, sm) => {
      const cwd = sm.getSessionCwd(params.sessionId);
      if (!cwd) { errorResponse(res, 404, 'Session not found'); return; }
      const status = await getGitStatus(cwd);
      if (!status.isRepo) { errorResponse(res, 400, 'Not a git repository'); return; }
      const body = await parseJsonBody<{ message: string }>(req);
      if (!body.message?.trim()) { errorResponse(res, 400, 'Commit message required'); return; }
      jsonResponse(res, 200, await gitCommit(status.repoRoot, body.message));
    },
  },
  {
    method: 'POST',
    pattern: '/api/v1/git/:sessionId/push',
    handler: async (_req, res, params, sm) => {
      const cwd = sm.getSessionCwd(params.sessionId);
      if (!cwd) { errorResponse(res, 404, 'Session not found'); return; }
      const status = await getGitStatus(cwd);
      if (!status.isRepo) { errorResponse(res, 400, 'Not a git repository'); return; }
      jsonResponse(res, 200, await gitPush(status.repoRoot));
    },
  },
  {
    method: 'POST',
    pattern: '/api/v1/git/:sessionId/pull',
    handler: async (_req, res, params, sm) => {
      const cwd = sm.getSessionCwd(params.sessionId);
      if (!cwd) { errorResponse(res, 404, 'Session not found'); return; }
      const status = await getGitStatus(cwd);
      if (!status.isRepo) { errorResponse(res, 400, 'Not a git repository'); return; }
      jsonResponse(res, 200, await gitPull(status.repoRoot));
    },
  },
  {
    method: 'GET',
    pattern: '/api/v1/git/:sessionId/log',
    handler: async (_req, res, params, sm) => {
      const cwd = sm.getSessionCwd(params.sessionId);
      if (!cwd) { errorResponse(res, 404, 'Session not found'); return; }
      const status = await getGitStatus(cwd);
      if (!status.isRepo) { errorResponse(res, 400, 'Not a git repository'); return; }
      jsonResponse(res, 200, await gitLog(status.repoRoot));
    },
  },
  {
    method: 'GET',
    pattern: '/api/v1/git/:sessionId/branch',
    handler: async (_req, res, params, sm) => {
      const cwd = sm.getSessionCwd(params.sessionId);
      if (!cwd) { errorResponse(res, 404, 'Session not found'); return; }
      const status = await getGitStatus(cwd);
      if (!status.isRepo) { errorResponse(res, 400, 'Not a git repository'); return; }
      jsonResponse(res, 200, await gitBranchInfo(status.repoRoot));
    },
  },

  // ── Projects / Launcher ──
  {
    method: 'GET',
    pattern: '/api/v1/projects',
    handler: async (_req, res) => {
      jsonResponse(res, 200, await scanProjects());
    },
  },
  {
    method: 'GET',
    pattern: '/api/v1/projects/pins',
    handler: async (_req, res) => {
      jsonResponse(res, 200, getPinnedProjects());
    },
  },
  {
    method: 'PUT',
    pattern: '/api/v1/projects/pins',
    handler: async (req, res) => {
      const body = await parseJsonBody<{ pins: any[] }>(req);
      if (!Array.isArray(body.pins)) { errorResponse(res, 400, 'pins must be an array'); return; }
      updatePinnedProjects(body.pins);
      jsonResponse(res, 200, { ok: true });
    },
  },
  {
    method: 'GET',
    pattern: '/api/v1/projects/:encodedPath/sessions',
    handler: async (_req, res, params) => {
      jsonResponse(res, 200, await scanSessionsForProject(params.encodedPath));
    },
  },
  {
    method: 'GET',
    pattern: '/api/v1/projects/:encodedPath/resolve',
    handler: async (_req, res, params) => {
      const realPath = await resolveProjectPath(params.encodedPath);
      jsonResponse(res, 200, { path: realPath });
    },
  },

  // ── Shells / Settings ──
  {
    method: 'GET',
    pattern: '/api/v1/shells',
    handler: async (_req, res) => {
      jsonResponse(res, 200, await detectShells());
    },
  },
  {
    method: 'GET',
    pattern: '/api/v1/settings/default-shell',
    handler: async (_req, res) => {
      jsonResponse(res, 200, { id: getDefaultShellId() || null });
    },
  },
  {
    method: 'PUT',
    pattern: '/api/v1/settings/default-shell',
    handler: async (req, res) => {
      const body = await parseJsonBody<{ id: string }>(req);
      if (!body.id || !getCachedShells().some((s) => s.id === body.id)) {
        errorResponse(res, 400, 'Unknown shell ID');
        return;
      }
      setDefaultShellId(body.id);
      jsonResponse(res, 200, { ok: true });
    },
  },

  // ── Canvas / Templates ──
  {
    method: 'GET',
    pattern: '/api/v1/canvas',
    handler: async (_req, res) => {
      const canvasPath = path.join(app.getPath('home'), '.agentplex', 'canvas.json');
      try {
        const raw = fs.readFileSync(canvasPath, 'utf-8');
        jsonResponse(res, 200, JSON.parse(raw));
      } catch {
        jsonResponse(res, 200, { elements: [], version: 1 });
      }
    },
  },
  {
    method: 'PUT',
    pattern: '/api/v1/canvas',
    handler: async (req, res) => {
      const body = await parseJsonBody<any>(req);
      const dir = path.join(app.getPath('home'), '.agentplex');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'canvas.json'), JSON.stringify(body), 'utf-8');
      jsonResponse(res, 200, { ok: true });
    },
  },
  {
    method: 'GET',
    pattern: '/api/v1/templates',
    handler: async (_req, res) => {
      const templatesPath = path.join(app.getPath('home'), '.agentplex', 'templates.json');
      try {
        jsonResponse(res, 200, JSON.parse(fs.readFileSync(templatesPath, 'utf-8')));
      } catch {
        jsonResponse(res, 200, []);
      }
    },
  },
  {
    method: 'PUT',
    pattern: '/api/v1/templates',
    handler: async (req, res) => {
      const body = await parseJsonBody<any>(req);
      const dir = path.join(app.getPath('home'), '.agentplex');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'templates.json'), JSON.stringify(body, null, 2), 'utf-8');
      jsonResponse(res, 200, { ok: true });
    },
  },
  // ── Relay Client Control ──
  {
    method: 'POST',
    pattern: '/api/v1/relay/connect',
    handler: async (req, res) => {
      const body = await parseJsonBody<{ relayUrl: string }>(req);
      if (!body.relayUrl) { errorResponse(res, 400, 'relayUrl is required'); return; }
      try {
        const client = await getRelayModule().startRelayClient(body.relayUrl);
        jsonResponse(res, 200, { ok: true, machineId: client.getMachineId(), state: client.getState() });
      } catch (err: any) {
        errorResponse(res, 500, err.message);
      }
    },
  },
  {
    method: 'POST',
    pattern: '/api/v1/relay/disconnect',
    handler: async (_req, res) => {
      getRelayModule().stopRelayClient();
      jsonResponse(res, 200, { ok: true });
    },
  },
  {
    method: 'GET',
    pattern: '/api/v1/relay/status',
    handler: async (_req, res) => {
      const client = getRelayModule().getRelayClient();
      jsonResponse(res, 200, {
        connected: client?.getState() === 'connected',
        state: client?.getState() || 'disconnected',
        machineId: client?.getMachineId() || null,
      });
    },
  },
  {
    method: 'POST',
    pattern: '/api/v1/relay/pair',
    handler: async (_req, res) => {
      const client = getRelayModule().getRelayClient();
      if (!client || client.getState() !== 'connected') {
        errorResponse(res, 400, 'Relay client not connected');
        return;
      }
      try {
        const code = await client.initiatePairing();
        jsonResponse(res, 200, { code, expiresIn: 300 });
      } catch (err: any) {
        errorResponse(res, 500, err.message);
      }
    },
  },
  {
    method: 'GET',
    pattern: '/api/v1/relay/devices',
    handler: async (_req, res) => {
      const { loadPairedDevices } = await import('./key-manager');
      jsonResponse(res, 200, loadPairedDevices());
    },
  },
];

// Routes that skip auth
const NO_AUTH_PATTERNS = new Set(['/api/v1/health']);

// ── Request handler ─────────────────────────────────────────────────────────

export function createRequestHandler(sm: SessionManager) {
  return async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const method = req.method?.toUpperCase() || 'GET';
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    // CORS preflight
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
      });
      res.end();
      return;
    }

    // Auth check (skip for health endpoint)
    if (!NO_AUTH_PATTERNS.has(pathname)) {
      const token = extractBearerToken(req.headers.authorization);
      if (!token || !validateToken(token)) {
        errorResponse(res, 401, 'Unauthorized', 'INVALID_TOKEN');
        return;
      }
    }

    // Rate limiting
    const clientKey = req.socket.remoteAddress || 'unknown';
    if (!rateLimiter.check(clientKey)) {
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'Retry-After': String(rateLimiter.retryAfter(clientKey)),
      });
      res.end(JSON.stringify({ error: 'Too many requests', code: 'RATE_LIMITED' }));
      return;
    }

    // Route matching
    for (const route of routes) {
      if (route.method !== method) continue;
      const params = matchRoute(route.pattern, pathname);
      if (params) {
        try {
          await route.handler(req, res, params, sm);
        } catch (err: any) {
          console.error(`[remote/http] ${method} ${pathname} error:`, err.message);
          errorResponse(res, 500, err.message || 'Internal server error');
        }
        return;
      }
    }

    errorResponse(res, 404, `Not found: ${method} ${pathname}`);
  };
}

export function stopRateLimiter() {
  rateLimiter.stop();
}
