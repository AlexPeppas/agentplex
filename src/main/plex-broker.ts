import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';
import type { PlexActivity, PlexJob, PlexPermissionDecision, PlexPermissionEvent, PlexResultItem, PlexSteering, PlexTaskSpec, PlexWorkerResult } from '../shared/plex';
import { mergeActivity, validateActivity } from './plex-activity';

interface BrokerState {
  version: 1;
  jobs: PlexJob[];
  results: PlexResultItem[];
  steering?: PlexSteering[];
}

export const PLEX_WORKER_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['status', 'summary', 'evidence', 'limitations'],
  properties: {
    status: { type: 'string', enum: ['completed', 'blocked'] },
    summary: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } },
    limitations: { type: 'array', items: { type: 'string' } },
  },
};

export function validateWorkerResult(value: unknown): PlexWorkerResult {
  if (!value || typeof value !== 'object') throw new Error('Invalid worker result');
  const item = value as Record<string, unknown>;
  const validList = (list: unknown): list is string[] => Array.isArray(list) && list.length <= 30 &&
    list.every(value => typeof value === 'string' && value.trim() && value.length <= 8000);
  if ((item.status !== 'completed' && item.status !== 'blocked') ||
      typeof item.summary !== 'string' || !item.summary.trim() || item.summary.length > 16000 ||
      !validList(item.evidence) || !validList(item.limitations) || JSON.stringify(value).length > 32000) {
    throw new Error('Invalid or oversized worker result');
  }
  return { status: item.status, summary: item.summary, evidence: item.evidence, limitations: item.limitations };
}

/**
 * Single-owner local broker. All mutations commit synchronously before returning;
 * workers never write this file themselves. An external/multi-process transport
 * must route through this owner, not instantiate competing file-backed brokers.
 */
export class PlexBroker {
  private state: BrokerState = { version: 1, jobs: [], results: [] };
  private readonly activity = new Map<string, PlexActivity[]>();

  constructor(
    private readonly file: string,
    private readonly changed: () => void = () => {},
    private readonly now: () => number = Date.now,
    private readonly leaseMs = 30_000,
  ) {
    if (!fs.existsSync(file)) return;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as BrokerState;
    if (raw?.version !== 1 || !Array.isArray(raw.jobs) || !Array.isArray(raw.results)) throw new Error('Invalid broker state');
    const jobIds = new Set<string>();
    const resultIds = new Set<string>();
    for (const job of raw.jobs) {
      if (!job || typeof job.id !== 'string' || jobIds.has(job.id) || typeof job.missionId !== 'string' ||
          typeof job.workerId !== 'string' || !job.task || typeof job.task.id !== 'string' ||
          typeof job.task.title !== 'string' || typeof job.task.instructions !== 'string' || typeof job.task.acceptance !== 'string' ||
          !Array.isArray(job.task.dependsOn) || !job.task.dependsOn.every(id => typeof id === 'string') ||
          !['queued', 'running', 'completed', 'blocked'].includes(job.status) ||
          !Number.isFinite(job.createdAt) ||
          (job.status === 'running' && (typeof job.claimToken !== 'string' || !Number.isFinite(job.leaseUntil)))) {
        throw new Error('Invalid broker job');
      }
      jobIds.add(job.id);
      if (job.permissions !== undefined && (!Array.isArray(job.permissions) || job.permissions.length > 100 ||
        new Set(job.permissions.map(item => item.requestId)).size !== job.permissions.length ||
        job.permissions.some(item => {
          validatePermissionEvent({ ...item, status: item.status === 'pending' ? 'requested' : 'completed' });
          if (item.decision && (!['approve-once', 'reject'].includes(item.decision.value) ||
            !['queued', 'delivering', 'accepted', 'failed'].includes(item.decision.status) ||
            (item.decision.error !== undefined && typeof item.decision.error !== 'string'))) {
            throw new Error('Invalid saved permission decision');
          }
          return !['pending', 'resolved', 'interrupted'].includes(item.status) || !Number.isFinite(item.requestedAt) ||
            (item.status === 'pending' && job.status !== 'running');
        }))) throw new Error('Invalid persisted worker permission requests');
    }
    for (const item of raw.results) {
      const job = raw.jobs.find(job => job.id === item?.jobId);
      if (!item || typeof item.id !== 'string' || resultIds.has(item.id) || !job ||
          item.missionId !== job.missionId || item.workerId !== job.workerId ||
          (item.source !== 'worker' && item.source !== 'broker') || !Number.isFinite(item.createdAt) ||
          job.resultId !== item.id || job.status !== item.result?.status) throw new Error('Invalid broker result');
      validateWorkerResult(item.result);
      resultIds.add(item.id);
    }
    if (raw.jobs.some(job => (job.status === 'completed' || job.status === 'blocked') && !resultIds.has(job.resultId!))) {
      throw new Error('Terminal job is missing its result');
    }
    const keys = raw.jobs.map(job => JSON.stringify([job.missionId, job.task.id]));
    if (new Set(keys).size !== keys.length || raw.jobs.some(job => job.task.dependsOn.some(id =>
      !raw.jobs.some(dep => dep.missionId === job.missionId && dep.task.id === id)))) throw new Error('Invalid saved job dependencies');
    if (raw.steering !== undefined && (!Array.isArray(raw.steering) ||
      new Set(raw.steering.map(item => item?.id)).size !== raw.steering.length ||
      raw.steering.some(item => !item || typeof item.id !== 'string' || typeof item.prompt !== 'string' ||
        item.prompt.length > 8000 || !['pending', 'delivering', 'accepted', 'failed'].includes(item.status) ||
        !raw.jobs.some(job => job.id === item.jobId && job.workerId === item.workerId && job.missionId === item.missionId)))) {
      throw new Error('Invalid persisted steering receipts');
    }
    this.state = raw;
  }

  jobs(missionId: string): PlexJob[] {
    return structuredClone(this.state.jobs.filter(job => job.missionId === missionId));
  }

  results(missionId: string): PlexResultItem[] {
    return structuredClone(this.state.results.filter(result => result.missionId === missionId));
  }

  progress(jobId: string, workerId: string, token: string, value: unknown): void {
    const events = validateActivity(value);
    const job = this.state.jobs.find(job => job.id === jobId);
    if (!job || job.workerId !== workerId || job.claimToken !== token) throw new Error('Activity has no matching worker claim');
    if (job.status === 'completed' || job.status === 'blocked') return;
    this.owner(jobId, workerId, token);
    const entries = this.activity.get(jobId) ?? [];
    events.forEach(event => mergeActivity(entries, event));
    this.activity.set(jobId, entries);
    this.changed();
  }

  getActivity(jobId: string): PlexActivity[] { return structuredClone(this.activity.get(jobId) ?? []); }

  steering(missionId: string): PlexSteering[] {
    return structuredClone((this.state.steering ?? []).filter(item => item.missionId === missionId));
  }

  requestSteering(id: string, jobId: string, prompt: string): PlexSteering {
    if (!id || typeof prompt !== 'string' || !prompt.trim() || prompt.length > 8000) throw new Error('Invalid steering request');
    const prior = this.state.steering?.find(item => item.id === id);
    if (prior) {
      if (prior.jobId !== jobId || prior.prompt !== prompt) throw new Error('Conflicting steering request');
      return structuredClone(prior);
    }
    const job = this.state.jobs.find(job => job.id === jobId);
    if (!job || job.status !== 'running') throw new Error('Worker assignment is no longer running');
    if (this.steering(job.missionId).length >= 100) throw new Error('Mission steering limit reached');
    const item: PlexSteering = { id, missionId: job.missionId, jobId, workerId: job.workerId, prompt, status: 'pending' };
    this.commit(draft => { (draft.steering ??= []).push(item); });
    return structuredClone(item);
  }

  claimSteering(id: string, jobId: string, workerId: string, token: string): PlexSteering {
    this.owner(jobId, workerId, token);
    const item = this.state.steering?.find(item => item.id === id && item.jobId === jobId && item.workerId === workerId);
    if (!item) throw new Error('Unknown steering request');
    if (item.status !== 'pending') throw new Error('Steering already delivered or uncertain; refusing automatic replay');
    this.commit(draft => { draft.steering!.find(item => item.id === id)!.status = 'delivering'; });
    return structuredClone(item);
  }

  finishSteering(id: string, providerMessageId?: string, error?: string): void {
    const prior = this.state.steering?.find(item => item.id === id);
    if (!prior) throw new Error('Unknown steering receipt');
    if (prior.status === 'accepted' || prior.status === 'failed') return;
    this.commit(draft => {
      const item = draft.steering!.find(item => item.id === id)!;
      item.status = error ? 'failed' : 'accepted';
      if (error) item.error = error.slice(0, 2000);
      else {
        if (!providerMessageId) throw new Error('Missing provider steering acknowledgement');
        item.providerMessageId = providerMessageId;
      }
    });
  }

  enqueue(missionId: string, assignments: { task: PlexTaskSpec; workerId: string }[]): PlexJob[] {
    if (!missionId || !assignments.length || assignments.length > 6) throw new Error('Invalid mission');
    const existing = this.jobs(missionId);
    if (existing.length) {
      if (JSON.stringify(existing.map(job => ({ task: job.task, workerId: job.workerId }))) !== JSON.stringify(assignments)) {
        throw new Error('Mission already enqueued with different assignments');
      }
      return existing;
    }
    const ids = new Set(assignments.map(({ task }) => task.id));
    if (ids.size !== assignments.length || assignments.some(({ task, workerId }) =>
      !workerId || !task.id || task.dependsOn.some(id => !ids.has(id)))) throw new Error('Invalid assignments');
    const visit = (id: string, chain: string[] = []) => {
      if (chain.includes(id)) throw new Error('Cyclic assignments');
      assignments.find(item => item.task.id === id)!.task.dependsOn.forEach(dep => visit(dep, [...chain, id]));
    };
    assignments.forEach(({ task }) => visit(task.id));
    this.commit(draft => {
      draft.jobs.push(...assignments.map(({ task, workerId }): PlexJob => ({
        id: randomUUID(), missionId, task: structuredClone(task), workerId, status: 'queued', createdAt: this.now(),
      })));
    });
    for (const job of this.state.jobs) {
      if (job.status === 'completed' || job.status === 'blocked') this.activity.delete(job.id);
    }
    return this.jobs(missionId);
  }

  append(missionId: string, assignments: { task: PlexTaskSpec; workerId: string }[]): void {
    const existing = this.jobs(missionId);
    if (!existing.length || !assignments.length || assignments.length > 6 || existing.length + assignments.length > 100) {
      throw new Error('Autonomous mission supports at most 100 assignments, six per batch');
    }
    const all = [...existing.map(job => ({ task: job.task, workerId: job.workerId })), ...assignments];
    const ids = new Set(all.map(item => item.task.id));
    if (ids.size !== all.length || assignments.some(item => !item.workerId ||
      item.task.dependsOn.some(id => !ids.has(id)))) throw new Error('Invalid autonomous assignment identity or dependency');
    const visited = new Set<string>();
    const visit = (id: string, chain = new Set<string>()) => {
      if (chain.has(id)) throw new Error('Cyclic autonomous dependency');
      if (visited.has(id)) return;
      all.find(item => item.task.id === id)!.task.dependsOn.forEach(dep => visit(dep, new Set([...chain, id])));
      visited.add(id);
    };
    all.forEach(item => visit(item.task.id));
    this.commit(draft => {
      draft.jobs.push(...assignments.map(({ task, workerId }): PlexJob => ({
        id: randomUUID(), missionId, task: structuredClone(task), workerId, status: 'queued', createdAt: this.now(),
      })));
      this.blockDependents(draft);
    });
  }

  assertClaim(job: PlexJob): void { this.owner(job.id, job.workerId, job.claimToken!); }

  /** Atomic claim: only assigned workers, ready dependencies, max two running. */
  claim(workerId: string, missionId: string, jobId?: string): PlexJob | null {
    this.sweep();
    const jobs = this.state.jobs;
    if (jobs.filter(job => job.status === 'running').length >= 2 ||
        jobs.some(job => job.status === 'running' && job.workerId === workerId)) return null;
    const job = jobs.find(job => job.missionId === missionId && job.workerId === workerId && job.status === 'queued' &&
      (jobId === undefined || job.id === jobId) &&
      job.task.dependsOn.every(id => jobs.some(dep => dep.missionId === missionId && dep.task.id === id && dep.status === 'completed')));
    if (!job) return null;
    this.commit(draft => {
      const claimed = draft.jobs.find(item => item.id === job.id)!;
      claimed.status = 'running';
      claimed.claimToken = randomUUID();
      claimed.leaseUntil = this.now() + this.leaseMs;
    });
    return this.jobs(missionId).find(item => item.id === job.id)!;
  }

  heartbeat(jobId: string, workerId: string, token: string): void {
    this.owner(jobId, workerId, token);
    this.commit(draft => { draft.jobs.find(job => job.id === jobId)!.leaseUntil = this.now() + this.leaseMs; }, false);
  }

  permission(jobId: string, workerId: string, token: string, value: unknown): void {
    const event = validatePermissionEvent(value);
    const job = this.state.jobs.find(job => job.id === jobId);
    if (!job || job.workerId !== workerId || job.claimToken !== token) throw new Error('Permission event has no matching worker claim');
    // Late/redelivered events cannot reopen a terminal assignment.
    if (job.status === 'completed' || job.status === 'blocked') return;
    this.owner(jobId, workerId, token);
    const prior = job.permissions?.find(item => item.requestId === event.requestId);
    if (prior && (event.status === 'requested' || prior.status !== 'pending')) return;
    if (!prior && event.status === 'completed') return;
    if (!prior && (job.permissions?.length ?? 0) >= 100) throw new Error('Worker exceeded permission request limit');
    this.commit(draft => {
      const target = draft.jobs.find(item => item.id === jobId)!;
      target.permissions ??= [];
      const existing = target.permissions.find(item => item.requestId === event.requestId);
      if (existing) existing.status = 'resolved';
      else target.permissions.push({ ...event, status: 'pending', requestedAt: this.now() });
    });
  }

  requestPermissionDecision(job: PlexJob, requestId: string, value: PlexPermissionDecision): void {
    this.owner(job.id, job.workerId, job.claimToken!);
    if (value !== 'approve-once' && value !== 'reject') throw new Error('Unsupported permission decision');
    const permission = this.state.jobs.find(item => item.id === job.id)?.permissions?.find(item => item.requestId === requestId);
    if (!permission || permission.status !== 'pending') throw new Error('Permission request is stale or not pending');
    if (permission.decision) throw new Error('Permission decision was already attempted; refusing replay');
    this.commit(draft => {
      draft.jobs.find(item => item.id === job.id)!.permissions!.find(item => item.requestId === requestId)!.decision = {
        value, status: 'queued',
      };
    });
  }

  claimPermissionDecision(jobId: string, workerId: string, token: string, requestId: string): PlexPermissionDecision {
    this.owner(jobId, workerId, token);
    const permission = this.state.jobs.find(item => item.id === jobId)?.permissions?.find(item => item.requestId === requestId);
    if (!permission || permission.status !== 'pending' || permission.decision?.status !== 'queued') {
      throw new Error('Permission decision is stale, unregistered or already attempted');
    }
    const value = permission.decision.value;
    this.commit(draft => {
      draft.jobs.find(item => item.id === jobId)!.permissions!.find(item => item.requestId === requestId)!.decision!.status = 'delivering';
    });
    return value;
  }

  finishPermissionDecision(jobId: string, requestId: string, error?: string): void {
    const decision = this.state.jobs.find(item => item.id === jobId)?.permissions?.find(item => item.requestId === requestId)?.decision;
    if (!decision) throw new Error('Unknown permission decision');
    if (decision.status === 'accepted' || decision.status === 'failed') return;
    this.commit(draft => {
      const target = draft.jobs.find(item => item.id === jobId)!.permissions!.find(item => item.requestId === requestId)!.decision!;
      target.status = error ? 'failed' : 'accepted';
      if (error) target.error = error.slice(0, 2000);
    });
  }

  submit(jobId: string, workerId: string, token: string, value: unknown): PlexResultItem {
    const result = validateWorkerResult(value);
    const prior = this.state.jobs.find(job => job.id === jobId);
    if (prior?.resultId && prior.workerId === workerId && prior.claimToken === token) {
      const item = this.state.results.find(item => item.id === prior.resultId)!;
      if (item.source === 'worker' && JSON.stringify(item.result) === JSON.stringify(result)) return structuredClone(item);
      throw new Error('Conflicting or stale result submission');
    }
    this.owner(jobId, workerId, token);
    if (result.status === 'completed' && prior?.permissions?.some(item => item.status === 'pending')) {
      throw new Error('Worker cannot complete an assignment with unresolved permission requests');
    }
    this.commit(draft => {
      this.finish(draft, draft.jobs.find(job => job.id === jobId)!, result, 'worker');
      this.blockDependents(draft);
    });
    return structuredClone(this.state.results.find(item => item.jobId === jobId)!);
  }

  sweep(): void {
    if (!this.state.jobs.some(job => job.status === 'running' && job.leaseUntil! <= this.now())) return;
    this.commit(draft => {
      draft.jobs.filter(job => job.status === 'running' && job.leaseUntil! <= this.now()).forEach(job =>
        this.finish(draft, job, this.blocked('Worker lease expired; no automatic retry'), 'broker'));
      this.blockDependents(draft);
    });
  }

  cancel(missionId: string, reason = 'Cancelled by user'): void {
    this.blockWhere(job => job.missionId === missionId, reason);
  }

  recover(): void {
    this.blockWhere(() => true, 'Broker restarted; interrupted work is blocked, not replayed');
    if (this.state.jobs.some(job => job.permissions?.some(item => ['queued', 'delivering'].includes(item.decision?.status ?? '')))) {
      this.commit(draft => draft.jobs.forEach(job => job.permissions?.forEach(item => {
        if (item.decision && ['queued', 'delivering'].includes(item.decision.status)) {
          item.decision.status = 'failed';
          item.decision.error = 'Restart interrupted decision delivery; outcome unknown, not replayed';
        }
      })));
    }
    if (this.state.steering?.some(item => item.status === 'pending' || item.status === 'delivering')) {
      this.commit(draft => draft.steering!.forEach(item => {
        if (item.status === 'pending' || item.status === 'delivering') {
          item.status = 'failed'; item.error = 'Restart interrupted delivery; outcome unknown, not replayed';
        }
      }));
    }
  }

  private blockWhere(predicate: (job: PlexJob) => boolean, reason: string) {
    if (!this.state.jobs.some(job => predicate(job) && (job.status === 'running' || job.status === 'queued'))) return;
    this.commit(draft => {
      draft.jobs.filter(job => predicate(job) && (job.status === 'running' || job.status === 'queued')).forEach(job =>
        this.finish(draft, job, this.blocked(reason), 'broker'));
    });
  }

  private owner(id: string, worker: string, token: string) {
    const job = this.state.jobs.find(job => job.id === id);
    if (!job || job.status !== 'running' || job.workerId !== worker || job.claimToken !== token || job.leaseUntil! <= this.now()) {
      throw new Error('Claim is missing, expired, or belongs to another worker');
    }
  }

  private blocked(reason: string): PlexWorkerResult {
    return { status: 'blocked', summary: reason, evidence: [], limitations: [reason] };
  }

  private finish(draft: BrokerState, job: PlexJob, result: PlexWorkerResult, source: PlexResultItem['source']) {
    const id = randomUUID();
    job.status = result.status;
    job.resultId = id;
    job.permissions?.forEach(item => { if (item.status === 'pending') item.status = 'interrupted'; });
    delete job.leaseUntil;
    draft.results.push({ id, jobId: job.id, missionId: job.missionId, workerId: job.workerId, source, createdAt: this.now(), result });
  }

  private blockDependents(draft: BrokerState) {
    let changed: boolean;
    do {
      changed = false;
      for (const job of draft.jobs) {
        if (job.status === 'queued' && job.task.dependsOn.some(id =>
          draft.jobs.some(dep => dep.missionId === job.missionId && dep.task.id === id && dep.status === 'blocked'))) {
          this.finish(draft, job, this.blocked('A prerequisite is blocked'), 'broker');
          changed = true;
        }
      }
    } while (changed);
  }

  private commit(mutate: (draft: BrokerState) => void, notify = true) {
    const draft = structuredClone(this.state);
    mutate(draft);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const descriptor = fs.openSync(`${this.file}.tmp`, 'w', 0o600);
    try {
      fs.writeFileSync(descriptor, JSON.stringify(draft));
      fs.fsyncSync(descriptor);
    } finally { fs.closeSync(descriptor); }
    fs.renameSync(`${this.file}.tmp`, this.file);
    this.state = draft;
    if (notify) this.changed();
  }
}

export function validatePermissionEvent(value: unknown): PlexPermissionEvent {
  if (!value || typeof value !== 'object') throw new Error('Invalid worker permission event');
  const item = value as Record<string, unknown>;
  if (typeof item.requestId !== 'string' || !item.requestId.trim() || item.requestId.length > 200 ||
    (item.status !== 'requested' && item.status !== 'completed')) throw new Error('Invalid worker permission identity');
  const result: PlexPermissionEvent = { requestId: item.requestId, status: item.status };
  for (const key of ['kind', 'toolName', 'description', 'resource', 'command'] as const) {
    if (item[key] === undefined) continue;
    if (typeof item[key] !== 'string' || item[key].length > 4000) throw new Error('Invalid worker permission details');
    result[key] = item[key];
  }
  return result;
}
