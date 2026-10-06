import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';
import type { PlexActivity, PlexAgent, PlexJob, PlexMount, PlexPermissionEvent, PlexPermissionDecision, PlexPermissionResponder, PlexQuestionRequest, PlexWorkerResult } from '../shared/plex';
import type { PlexBroker } from './plex-broker';
import type { PlexRunner } from './plex-cli';
import { PlexWorker } from './plex-worker';

/** Owns subprocess affinity and serial execution, never delegates identity decisions to the model. */
export class PlexMultiplexer {
  private readonly active = new Set<string>();
  private readonly steering = new Map<string, { jobId: string; send: ((prompt: string) => Promise<string>) | null }>();
  private readonly permissions = new Map<string, { jobId: string; respond: PlexPermissionResponder | null }>();

  async decidePermission(agent: PlexAgent, job: PlexJob, requestId: string, decision: PlexPermissionDecision): Promise<void> {
    const instance = this.permissions.get(agent.id);
    if (!instance || instance.jobId !== job.id || !instance.respond) throw new Error('No live permission channel for this assignment');
    await instance.respond(requestId, decision);
  }

  async steer(agent: PlexAgent, job: PlexJob, prompt: string): Promise<string> {
    const instance = this.steering.get(agent.id);
    if (!instance || instance.jobId !== job.id || !instance.send) {
      throw new Error('Worker is starting or finished; no live steering channel is available');
    }
    return instance.send(prompt);
  }

  constructor(private readonly home: string, private readonly broker: PlexBroker, private readonly runner: PlexRunner,
    private readonly mount?: PlexMount,
    private readonly ask?: (job: PlexJob, question: PlexQuestionRequest, signal: AbortSignal) => Promise<{ answer: string; wasFreeform: boolean }>) {}

  async execute(agent: PlexAgent, job: PlexJob, signal: AbortSignal,
    submit: (result: PlexWorkerResult) => Promise<void>,
    permission?: (event: PlexPermissionEvent) => Promise<void>,
    activity?: (events: PlexActivity[]) => Promise<void>): Promise<void> {
    if (job.workerId !== agent.id || this.active.has(agent.id)) throw new Error('Agent instance is mismatched or already executing');
    if (this.mount) {
      if (agent.cwd !== this.mount.cwd || agent.conversationId !== this.mount.conversationId ||
        agent.rootJobId !== this.mount.rootJobId) throw new Error('Agent instance does not match the conversation mount');
      if (!fs.statSync(this.mount.cwd).isDirectory() || fs.realpathSync(this.mount.cwd) !== this.mount.cwd) {
        throw new Error('Mounted workspace changed; refusing to launch the agent in a different directory');
      }
    }
    this.active.add(agent.id);
    const control = { jobId: job.id, send: null as ((prompt: string) => Promise<string>) | null };
    this.steering.set(agent.id, control);
    const permissionControl: { jobId: string; respond: PlexPermissionResponder | null } = { jobId: job.id, respond: null };
    this.permissions.set(agent.id, permissionControl);
    try {
      const conversationHome = path.join(this.home, 'conversations',
        `worker-${createHash('sha256').update(agent.id).digest('hex')}`);
      await new PlexWorker(agent, this.broker, this.runner, conversationHome).execute(job, signal, submit, permission, activity,
        send => { control.send = send; }, respond => { permissionControl.respond = respond; },
        this.ask ? (question, questionSignal = signal) => this.ask!(job, question, questionSignal) : undefined);
    } finally { this.active.delete(agent.id); this.steering.delete(agent.id); this.permissions.delete(agent.id); }
  }
}
