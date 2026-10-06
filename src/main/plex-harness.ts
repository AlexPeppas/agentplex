import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';
import {
  validatePlexTools, validatePlexModel, PLEX_WORKER_TOOLS,
  type PlexConversation, type PlexSquadBlueprint, type PlexWorkspace,
} from '../shared/plex';
import { PlexCoordinator } from './plex-coordinator';
import type { PlexRunner } from './plex-cli';

interface Ingress {
  id: string;
  conversationId: string;
  text: string;
  status: 'accepted' | 'settled' | 'interrupted';
}
interface Registry {
  version: 1;
  conversations: PlexConversation[];
  blueprints: PlexSquadBlueprint[];
  ingress: Ingress[];
  migrationNotes: string[];
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Plex object');
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) throw new Error('Invalid Plex text');
  return value.trim();
}
function id(value: unknown): string {
  const result = text(value, 100);
  if (!/^[a-zA-Z0-9_-]+$/.test(result)) throw new Error('Invalid Plex ID');
  return result;
}

export function validateBlueprint(value: unknown): PlexSquadBlueprint {
  const raw = object(value);
  if (!Number.isSafeInteger(raw.revision) || Number(raw.revision) < 1 ||
    !Array.isArray(raw.agents) || raw.agents.length < 1 || raw.agents.length > 4) {
    throw new Error('A Squad blueprint needs 1-4 agents and a valid revision');
  }
  const agents = raw.agents.map(value => {
    const agent = object(value);
    return {
      id: id(agent.id), name: text(agent.name, 200), description: text(agent.description, 2000, true),
      instructions: text(agent.instructions, 8000, true), tools: validatePlexTools(agent.tools),
      ...(validatePlexModel(agent.model) ? { model: validatePlexModel(agent.model) } : {}),
    };
  });
  if (new Set(agents.map(agent => agent.id)).size !== agents.length) throw new Error('Duplicate blueprint agent IDs');
  return { id: id(raw.id), name: text(raw.name, 200), revision: Number(raw.revision), agents };
}

/** Application-owned conversations, capability snapshots, ingress deduplication and model lifecycle. */
export class PlexHarness {
  private registry: Registry = { version: 1, conversations: [], blueprints: [], ingress: [], migrationNotes: [] };
  private readonly coordinators = new Map<string, PlexCoordinator>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly file: string;
  private revision = 0;

  constructor(private readonly root: string, private readonly runner: PlexRunner,
    private readonly changed: (workspace: PlexWorkspace) => void) {
    this.file = path.join(root, 'workspace.json');
    if (fs.existsSync(this.file)) {
      const raw = object(JSON.parse(fs.readFileSync(this.file, 'utf8')));
      if (raw.version !== 1 || !Array.isArray(raw.blueprints) || !Array.isArray(raw.conversations) ||
        !Array.isArray(raw.ingress) || !Array.isArray(raw.migrationNotes)) throw new Error('Invalid Plex workspace registry');
      this.registry.blueprints = raw.blueprints.map(validateBlueprint);
      this.registry.conversations = raw.conversations.map(value => {
        const entry = object(value);
        if (!Number.isFinite(entry.createdAt) || !path.isAbsolute(text(entry.cwd, 32000))) throw new Error('Invalid saved mount');
        return { conversationId: id(entry.conversationId), rootJobId: id(entry.rootJobId),
          title: text(entry.title, 200), cwd: String(entry.cwd), blueprint: validateBlueprint(entry.blueprint), createdAt: Number(entry.createdAt) };
      });
      this.registry.ingress = raw.ingress.map(value => {
        const entry = object(value);
        if (!['accepted', 'settled', 'interrupted'].includes(String(entry.status))) throw new Error('Invalid saved ingress');
        return { id: id(entry.id), conversationId: id(entry.conversationId), text: text(entry.text, 8000),
          status: entry.status === 'settled' ? 'settled' : 'interrupted' };
      });
      this.registry.migrationNotes = raw.migrationNotes.map(value => text(value, 4000));
      if (new Set(this.registry.conversations.map(item => item.conversationId)).size !== this.registry.conversations.length ||
        new Set(this.registry.blueprints.map(item => item.id)).size !== this.registry.blueprints.length ||
        new Set(this.registry.ingress.map(item => item.id)).size !== this.registry.ingress.length ||
        this.registry.ingress.some(item => !this.registry.conversations.some(chat => chat.conversationId === item.conversationId))) {
        throw new Error('Duplicate or unbound Plex registry identities');
      }
    } else this.migrate();
    // Load every conversation now so crash recovery does not depend on opening a particular chat.
    this.registry.conversations.forEach(chat => this.coordinator(chat.conversationId));
    this.persist();
  }

  private migrate() {
    const templates = path.join(path.dirname(this.root), 'templates.json');
    if (fs.existsSync(templates)) {
      const saved: unknown = JSON.parse(fs.readFileSync(templates, 'utf8'));
      if (!Array.isArray(saved)) throw new Error('Legacy templates cannot be migrated: expected a list');
      for (const value of saved) {
        const template = object(value);
        const name = text(template.name, 200);
        if (!Array.isArray(template.sessions) || template.sessions.length < 1 || template.sessions.length > 4 ||
          template.sessions.some(member => object(member).cli !== 'copilot')) {
          this.registry.migrationNotes.push(`"${name}" was not imported: only squads of 1-4 Copilot agents are supported. Original templates.json is unchanged.`);
          continue;
        }
        this.registry.blueprints.push(validateBlueprint({
          id: `migrated-${createHash('sha256').update(String(template.id)).digest('hex').slice(0, 24)}`,
          name, revision: 1, agents: template.sessions.map((value, index) => {
            const member = object(value);
            return { id: `agent-${index}`, name: member.name, description: member.description ?? '',
              instructions: '', tools: [...PLEX_WORKER_TOOLS] };
          }),
        }));
      }
      this.registry.migrationNotes.push('Imported compatible Squads as blueprints. Legacy cwd/session IDs were not adopted; mount a workspace for each new chat. Original templates.json is unchanged.');
    }
    if (fs.existsSync(path.join(path.dirname(this.root), 'plex-poc', 'state.json'))) {
      this.registry.migrationNotes.push('Previous POC chat, tasks and CLI history remain in plex-poc. They span multiple workspaces and are not silently rebound to a new mounted conversation.');
    }
  }

  private persist() {
    fs.mkdirSync(this.root, { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.registry), { mode: 0o600 });
    fs.renameSync(`${this.file}.tmp`, this.file);
  }

  private commit(update: (draft: Registry) => void) {
    const previous = this.registry;
    this.registry = structuredClone(previous);
    try { update(this.registry); this.persist(); }
    catch (error) { this.registry = previous; throw error; }
  }

  private coordinator(conversationId: string): PlexCoordinator {
    const existing = this.coordinators.get(conversationId);
    if (existing) return existing;
    const mount = this.registry.conversations.find(item => item.conversationId === conversationId);
    if (!mount) throw new Error('Unknown Plex conversation');
    const coordinator = new PlexCoordinator(
      path.join(this.root, 'chats', mount.conversationId, 'state.json'), this.runner, () => [],
      () => { if (this.coordinators.has(conversationId)) this.changed(this.snapshot()); }, mount);
    this.coordinators.set(conversationId, coordinator);
    return coordinator;
  }

  snapshot(): PlexWorkspace {
    return structuredClone({
      revision: ++this.revision,
      conversations: this.registry.conversations.map(chat => ({
        ...chat, phase: this.coordinators.get(chat.conversationId)?.snapshot().phase ?? 'idle',
      })),
      blueprints: this.registry.blueprints, migrationNotes: this.registry.migrationNotes,
      states: Object.fromEntries([...this.coordinators].map(([key, coordinator]) => [key, coordinator.snapshot()])),
    });
  }

  createConversation(cwd: unknown, blueprintId: unknown, requestId: unknown): PlexWorkspace {
    const conversationId = id(requestId);
    const selectedId = id(blueprintId);
    const directory = text(cwd, 32000);
    if (!path.isAbsolute(directory) || !fs.statSync(directory).isDirectory()) throw new Error('Choose an existing workspace directory');
    const canonical = fs.realpathSync(directory);
    const existing = this.registry.conversations.find(chat => chat.conversationId === conversationId);
    if (existing) {
      if (existing.cwd !== canonical || existing.blueprint.id !== selectedId) throw new Error('Conflicting conversation creation request');
      this.coordinator(conversationId);
      return this.snapshot();
    }
    const blueprint = this.registry.blueprints.find(item => item.id === selectedId);
    if (!blueprint) throw new Error('Choose a saved Squad blueprint');
    const chat: PlexConversation = {
      conversationId, rootJobId: randomUUID(), cwd: canonical, blueprint: structuredClone(blueprint),
      title: `${path.basename(canonical)} - ${blueprint.name}`.slice(0, 200), createdAt: Date.now(),
    };
    this.commit(draft => { draft.conversations.push(chat); });
    this.coordinator(conversationId).start();
    const snapshot = this.snapshot();
    this.changed(snapshot);
    return snapshot;
  }

  saveBlueprint(value: unknown): PlexWorkspace {
    const blueprint = validateBlueprint(value);
    this.commit(draft => {
      const index = draft.blueprints.findIndex(item => item.id === blueprint.id);
      if (index >= 0) {
        if (draft.blueprints[index].revision !== blueprint.revision) throw new Error('Blueprint changed; reload before saving');
        draft.blueprints[index] = { ...blueprint, revision: blueprint.revision + 1 };
      } else {
        if (blueprint.revision !== 1) throw new Error('New blueprint must start at revision 1');
        draft.blueprints.push(blueprint);
      }
    });
    const snapshot = this.snapshot();
    this.changed(snapshot);
    return snapshot;
  }

  deleteBlueprint(value: unknown): PlexWorkspace {
    const blueprintId = id(value);
    this.commit(draft => { draft.blueprints = draft.blueprints.filter(item => item.id !== blueprintId); });
    const snapshot = this.snapshot();
    this.changed(snapshot);
    return snapshot;
  }

  async chat(conversationId: unknown, messageId: unknown, value: unknown): Promise<PlexWorkspace> {
    const chatId = id(conversationId);
    const ingressId = id(messageId);
    const message = text(value, 8000);
    const coordinator = this.coordinator(chatId);
    const existing = this.registry.ingress.find(item => item.id === ingressId);
    if (existing) {
      if (existing.conversationId !== chatId || existing.text !== message) throw new Error('Conflicting ingress idempotency key');
      await this.pending.get(ingressId);
      return this.snapshot();
    }
    if (!coordinator.canAcceptMessage()) {
      throw new Error('Finish, approve or reject this conversation request first');
    }
    this.commit(draft => { draft.ingress.push({ id: ingressId, conversationId: chatId, text: message, status: 'accepted' }); });
    const operation = (async () => {
      try {
        await coordinator.chat(message, ingressId);
        this.commit(draft => { draft.ingress.find(item => item.id === ingressId)!.status = 'settled'; });
      } finally { this.pending.delete(ingressId); }
    })();
    this.pending.set(ingressId, operation);
    await operation;
    return this.snapshot();
  }

  async approve(conversationId: unknown, approvalId: unknown): Promise<PlexWorkspace> {
    await this.coordinator(id(conversationId)).approve(id(approvalId));
    return this.snapshot();
  }

  cancel(conversationId: unknown, approvalId?: unknown): PlexWorkspace {
    const coordinator = this.coordinator(id(conversationId));
    const state = coordinator.snapshot();
    if ((approvalId !== undefined || state.phase === 'awaiting-approval') &&
      (state.phase !== 'awaiting-approval' || state.approvalId !== id(approvalId))) {
      throw new Error('This plan is stale; reload before rejecting it');
    }
    coordinator.cancel();
    return this.snapshot();
  }

  transcript(conversationId: unknown, agentId: unknown) {
    return this.coordinator(id(conversationId)).transcript(id(agentId));
  }

  async decidePermission(conversationId: unknown, jobId: unknown, requestId: unknown, decision: unknown): Promise<PlexWorkspace> {
    if (decision !== 'approve-once' && decision !== 'reject') throw new Error('Unsupported permission decision');
    await this.coordinator(id(conversationId)).decidePermission(id(jobId), text(requestId, 200), decision);
    return this.snapshot();
  }

  async answerQuestion(conversationId: unknown, questionId: unknown, answer: unknown): Promise<PlexWorkspace> {
    await this.coordinator(id(conversationId)).answerQuestion(id(questionId), text(answer, 8000));
    return this.snapshot();
  }

  dispose() { this.coordinators.forEach(coordinator => coordinator.dispose()); }
}
