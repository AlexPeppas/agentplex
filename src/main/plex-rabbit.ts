import { createHash } from 'node:crypto';
import { connect, type Channel, type ChannelModel, type ConfirmChannel, type ConsumeMessage } from 'amqplib';
import type { PlexActivity, PlexAgent, PlexJob, PlexPermissionDecision, PlexPermissionEvent, PlexWorkerResult } from '../shared/plex';
import type { PlexBroker } from './plex-broker';

export interface PlexDispatchRequest {
  missionId: string;
  agents: PlexAgent[];
  broker: PlexBroker;
  signal: AbortSignal;
  steer?: (agent: PlexAgent, job: PlexJob, prompt: string) => Promise<string>;
  registerSteering?: (send: PlexSteeringDelivery | null) => void;
  decidePermission?: (agent: PlexAgent, job: PlexJob, requestId: string, decision: PlexPermissionDecision) => Promise<void>;
  registerPermissionDecision?: (send: PlexPermissionDelivery | null) => void;
  registerWake?: (wake: (() => void) | null) => void;
  execute(agent: PlexAgent, job: PlexJob, signal: AbortSignal,
    submit: (result: PlexWorkerResult) => Promise<void>,
    permission: (event: PlexPermissionEvent) => Promise<void>,
    activity: (events: PlexActivity[]) => Promise<void>): Promise<void>;
}

export type PlexDispatch = (request: PlexDispatchRequest) => Promise<void>;
export type PlexSteeringDelivery = (requestId: string, job: PlexJob) => Promise<string>;
export type PlexPermissionDelivery = (requestId: string, job: PlexJob) => Promise<void>;

const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32);
export const plexQueuePrefix = (home: string) => `plex.${hash(home)}`;
export const plexWorkerQueue = (home: string, workerId: string) => `${plexQueuePrefix(home)}.worker.${hash(workerId)}`;

function rabbitUrl(): string {
  const value = process.env.PLEX_RABBITMQ_URL || 'amqp://localhost:5672';
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error('PLEX_RABBITMQ_URL must be an AMQP URL'); }
  if (!['amqp:', 'amqps:'].includes(url.protocol)) throw new Error('RabbitMQ requires amqp: or amqps:');
  if (url.protocol === 'amqp:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('Non-local RabbitMQ connections require TLS (amqps:)');
  }
  url.searchParams.set('heartbeat', '10');
  return url.toString();
}

function publish(channel: ConfirmChannel, exchange: string, key: string, payload: object, jobId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('RabbitMQ publisher confirmation timed out')), 10_000);
    try {
      channel.publish(exchange, key, Buffer.from(JSON.stringify(payload)), {
        persistent: true, mandatory: true, contentType: 'application/json', messageId: jobId, correlationId: jobId,
      }, error => {
        clearTimeout(timeout);
        if (error) reject(new Error('RabbitMQ did not confirm message persistence'));
        else resolve();
      });
    } catch {
      clearTimeout(timeout);
      reject(new Error('RabbitMQ publication failed'));
    }
  });
}

interface Envelope {
  version: 1;
  missionId: string;
  jobId: string;
  workerId: string;
  claimToken?: string;
  result?: unknown;
  assignmentId?: string;
  conversationId?: string;
  rootJobId?: string;
  squadId?: string;
  agentId?: string;
  eventType?: 'permission' | 'activity';
  permission?: unknown;
  activity?: unknown;
}

function envelope(message: ConsumeMessage): Envelope {
  if (message.content.length > 64_000) throw new Error('Oversized RabbitMQ message');
  const value = JSON.parse(message.content.toString());
  if (!value || value.version !== 1 || ['missionId', 'jobId', 'workerId'].some(key =>
    typeof value[key] !== 'string' || !value[key] || value[key].length > 200)) throw new Error('Invalid RabbitMQ message');
  if (value.eventType !== undefined && (!['permission', 'activity'].includes(value.eventType) || value.result !== undefined)) {
    throw new Error('Invalid RabbitMQ event type');
  }
  return value;
}

/** RabbitMQ delivers references; the local ledger remains authoritative for execution and results. */
export function createRabbitDispatch(home: string): PlexDispatch {
  return async ({ missionId, agents, broker, signal, execute, steer, registerSteering, decidePermission, registerPermissionDecision, registerWake }) => {
    if (signal.aborted) return;
    const url = rabbitUrl();
    let connection: ChannelModel;
    try { connection = await connect(url, { timeout: 10_000 }); }
    catch { throw new Error('Cannot connect to RabbitMQ. Start the local broker or configure PLEX_RABBITMQ_URL; no jobs were executed.'); }
    const prefix = plexQueuePrefix(home);
    const asks = `${prefix}.asks`;
    const results = `${prefix}.results`;
    const dead = `${prefix}.dead`;
    const controller = new AbortController();
    const published = new Set<string>();
    const running = new Set<Promise<void>>();
    const steeringPending = new Map<string, { resolve: (id: string) => void; reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>; failReceipt: (error: string) => void }>();
    let failure: Error | undefined;
    let closing = false;
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const fail = (error: unknown) => {
      failure ??= error instanceof Error ? error : new Error(String(error));
      controller.abort();
      finish();
    };
    const abort = () => { controller.abort(); finish(); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    connection.on('error', () => fail(new Error('RabbitMQ connection failed; interrupted jobs will not be replayed automatically')));
    connection.on('close', () => { if (!closing) fail(new Error('RabbitMQ connection closed')); });
    const observe = <T extends Channel>(channel: T): T => {
      channel.on('error', () => fail(new Error('RabbitMQ channel failed')));
      channel.on('close', () => { if (!closing) fail(new Error('RabbitMQ channel closed')); });
      channel.on('return', () => fail(new Error('RabbitMQ could not route a message to its registered consumer queue')));
      return channel;
    };
    const tracked = (operation: () => Promise<void>) => {
      const promise = operation().catch(fail);
      running.add(promise);
      void promise.finally(() => running.delete(promise));
    };
    try {
      const publisher = observe(await connection.createConfirmChannel());
      await publisher.assertExchange(asks, 'direct', { durable: true });
      await publisher.assertQueue(dead, { durable: true });
      const queueOptions = { durable: true, arguments: { 'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': dead } };
      await publisher.assertQueue(results, queueOptions);
      let pumping: Promise<void> = Promise.resolve();
      const pump = () => {
        pumping = pumping.then(async () => {
          if (controller.signal.aborted) return;
          const jobs = broker.jobs(missionId);
          if (jobs.every(job => job.status === 'completed' || job.status === 'blocked')) {
            if (!steeringPending.size) finish();
            return;
          }
          const occupied = new Set(jobs.filter(job => published.has(job.id)).map(job => job.workerId));
          for (const job of jobs) {
            if (published.size >= 2) break;
            if (job.status !== 'queued' || published.has(job.id) || occupied.has(job.workerId) ||
              job.task.dependsOn.some(id => !jobs.some(dep => dep.task.id === id && dep.status === 'completed'))) continue;
            published.add(job.id);
            occupied.add(job.workerId);
            const agent = agents.find(agent => agent.id === job.workerId);
            await publish(publisher, asks, plexWorkerQueue(home, job.workerId),
              { version: 1, missionId, messageId: missionId, jobId: job.id, assignmentId: job.id, workerId: job.workerId,
                conversationId: agent?.conversationId, rootJobId: agent?.rootJobId,
                squadId: agent?.squadId, agentId: agent?.blueprintAgentId }, job.id);
          }
        }).catch(fail);
      };
      const resultChannel = observe(await connection.createChannel());
      await resultChannel.prefetch(1);
      await resultChannel.consume(results, message => {
        if (!message || controller.signal.aborted) {
          if (!message && !closing) fail(new Error('RabbitMQ result subscription was cancelled'));
          return;
        }
        try {
          const item = envelope(message);
          if (item.missionId !== missionId) {
            const prior = broker.jobs(item.missionId).find(job => job.id === item.jobId);
            if (!prior || !['completed', 'blocked'].includes(prior.status)) throw new Error('Unknown or unsettled prior mission result');
            resultChannel.ack(message);
            return;
          }
          if (typeof item.claimToken !== 'string') throw new Error('RabbitMQ result is missing its claim');
          const job = broker.jobs(missionId).find(job => job.id === item.jobId && job.workerId === item.workerId);
          const agent = agents.find(agent => agent.id === item.workerId);
          if (!job || !agent) throw new Error('RabbitMQ result does not match this mission worker');
          if (agent.conversationId && (item.conversationId !== agent.conversationId ||
            item.rootJobId !== agent.rootJobId || item.squadId !== agent.squadId ||
            item.agentId !== agent.blueprintAgentId || item.assignmentId !== item.jobId)) {
            throw new Error('RabbitMQ result affinity does not match the registered instance');
          }
          if (item.eventType === 'permission') {
            broker.permission(item.jobId, item.workerId, item.claimToken, item.permission);
            resultChannel.ack(message);
            return;
          }
          if (item.eventType === 'activity') {
            broker.progress(item.jobId, item.workerId, item.claimToken, item.activity);
            resultChannel.ack(message);
            return;
          }
          broker.submit(item.jobId, item.workerId, item.claimToken, item.result);
          published.delete(item.jobId);
          resultChannel.ack(message);
          pump();
        } catch (error) {
          resultChannel.nack(message, false, false);
          fail(error);
        }
      }, { noAck: false, exclusive: true });
      for (const agent of agents) {
        const queue = plexWorkerQueue(home, agent.id);
        if (steer || decidePermission) {
          const controlQueue = `${queue}.control`;
          await publisher.assertQueue(controlQueue, queueOptions);
          const control = observe(await connection.createChannel());
          await control.prefetch(1);
          await control.consume(controlQueue, message => {
            if (!message || controller.signal.aborted) {
              if (!message && !closing) fail(new Error('RabbitMQ control subscription was cancelled'));
              return;
            }
            tracked(async () => {
              let requestId: string | undefined;
              try {
                const item = envelope(message);
                const raw = JSON.parse(message.content.toString());
                if (typeof raw.requestId !== 'string' || !raw.requestId || raw.requestId.length > 500) throw new Error('Invalid control identity');
                const currentRequestId: string = raw.requestId;
                requestId = currentRequestId;
                if (item.missionId !== missionId || item.workerId !== agent.id ||
                  item.conversationId !== agent.conversationId || item.rootJobId !== agent.rootJobId ||
                  item.squadId !== agent.squadId || item.agentId !== agent.blueprintAgentId || item.assignmentId !== item.jobId ||
                  typeof item.claimToken !== 'string') throw new Error('Steering affinity does not match the running worker');
                const job = broker.jobs(missionId).find(job => job.id === item.jobId)!;
                let messageId: string;
                if (raw.controlType === 'permission') {
                  if (!decidePermission || typeof raw.permissionRequestId !== 'string' ||
                    currentRequestId !== `permission:${item.jobId}:${raw.permissionRequestId}`) throw new Error('Invalid permission control');
                  const decision = broker.claimPermissionDecision(item.jobId, agent.id, item.claimToken, raw.permissionRequestId);
                  await decidePermission(agent, job, raw.permissionRequestId, decision);
                  broker.finishPermissionDecision(item.jobId, raw.permissionRequestId);
                  messageId = raw.permissionRequestId;
                } else {
                  if (raw.controlType !== undefined || !steer) throw new Error('Invalid steering control');
                  const receipt = broker.claimSteering(currentRequestId, item.jobId, agent.id, item.claimToken);
                  messageId = await steer(agent, job, receipt.prompt);
                  broker.finishSteering(currentRequestId, messageId);
                }
                steeringPending.get(currentRequestId)?.resolve(messageId);
                control.ack(message);
              } catch (error) {
                const failure = error instanceof Error ? error : new Error(String(error));
                if (requestId && steeringPending.has(requestId)) {
                  steeringPending.get(requestId)!.failReceipt(failure.message);
                  steeringPending.get(requestId)!.reject(failure);
                } else console.error('[plex] Rejected stale or invalid steering delivery:', failure.message);
                if (!controller.signal.aborted) control.nack(message, false, false);
              } finally {
                if (requestId) {
                  clearTimeout(steeringPending.get(requestId)?.timer);
                  steeringPending.delete(requestId);
                }
                pump();
              }
            });
          }, { noAck: false, exclusive: true });
        }
        await publisher.assertQueue(queue, queueOptions);
        await publisher.bindQueue(queue, asks, queue);
        const inbox = observe(await connection.createChannel());
        await inbox.prefetch(1);
        await inbox.consume(queue, message => {
          if (!message || controller.signal.aborted) {
            if (!message && !closing) fail(new Error('RabbitMQ worker subscription was cancelled'));
            return;
          }
          tracked(async () => {
            try {
              const item = envelope(message);
              if (item.workerId !== agent.id) throw new Error('RabbitMQ delivered a job to the wrong consumer');
              if (agent.conversationId && (item.conversationId !== agent.conversationId ||
                item.rootJobId !== agent.rootJobId || item.squadId !== agent.squadId ||
                item.agentId !== agent.blueprintAgentId || item.assignmentId !== item.jobId)) {
                throw new Error('RabbitMQ assignment affinity does not match the registered instance');
              }
              const saved = broker.jobs(item.missionId).find(job => job.id === item.jobId);
              if (!saved || saved.workerId !== agent.id) throw new Error('RabbitMQ job is not registered in the local ledger');
              if (saved.status === 'completed' || saved.status === 'blocked') { inbox.ack(message); return; }
              if (item.missionId !== missionId) throw new Error('RabbitMQ delivered an unsettled prior mission');
              // A duplicate cannot start a second turn; the original delivery owns its claim.
              if (saved.status === 'running') { inbox.ack(message); return; }
              const claimed = broker.claim(agent.id, missionId, item.jobId);
              if (!claimed) throw new Error('RabbitMQ job is not ready or has no execution capacity');
              await execute(agent, claimed, controller.signal, result =>
                publish(publisher, '', results, { ...item, claimToken: claimed.claimToken, result }, item.jobId),
              permission => publish(publisher, '', results,
                { ...item, claimToken: claimed.claimToken, eventType: 'permission', permission }, item.jobId),
              activity => publish(publisher, '', results,
                { ...item, claimToken: claimed.claimToken, eventType: 'activity', activity }, item.jobId));
              if (!controller.signal.aborted) inbox.ack(message);
            } catch (error) {
              if (!controller.signal.aborted) inbox.nack(message, false, false);
              throw error;
            }
          });
        }, { noAck: false, exclusive: true });
      }
      const sendControl = async (requestId: string, job: PlexJob, failReceipt: (error: string) => void,
        extra: { controlType: 'permission'; permissionRequestId: string } | Record<string, never> = {}) => {
        if (controller.signal.aborted || job.missionId !== missionId) throw new Error('Worker dispatch is no longer active');
        const agent = agents.find(agent => agent.id === job.workerId);
        if (!agent) throw new Error('Unknown steering worker');
        const accepted = new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => {
            failReceipt('Control acknowledgement timed out; outcome unknown, not retried');
            steeringPending.delete(requestId);
            reject(new Error('Control acknowledgement timed out; delivery is uncertain'));
            pump();
          }, 30_000);
          steeringPending.set(requestId, { resolve, reject, timer, failReceipt });
        });
        void accepted.catch(() => {});
        try {
          await publish(publisher, '', `${plexWorkerQueue(home, agent.id)}.control`, {
            ...extra, version: 1, requestId, missionId, jobId: job.id, assignmentId: job.id, workerId: agent.id,
            claimToken: job.claimToken, conversationId: agent.conversationId, rootJobId: agent.rootJobId,
            squadId: agent.squadId, agentId: agent.blueprintAgentId,
          }, requestId);
          return await accepted;
        } catch (error) {
          failReceipt(String(error));
          clearTimeout(steeringPending.get(requestId)?.timer);
          steeringPending.delete(requestId);
          pump();
          throw error;
        }
      };
      if (steer) registerSteering?.((requestId, job) =>
        sendControl(requestId, job, error => broker.finishSteering(requestId, undefined, error)));
      if (decidePermission) registerPermissionDecision?.(async (requestId, job) => {
        await sendControl(`permission:${job.id}:${requestId}`, job,
          error => broker.finishPermissionDecision(job.id, requestId, error), { controlType: 'permission', permissionRequestId: requestId });
      });
      registerWake?.(pump);
      pump();
      await done;
      controller.abort();
      await pumping;
      await Promise.allSettled([...running]);
      if (failure) throw failure;
    } finally {
      registerSteering?.(null);
      registerPermissionDecision?.(null);
      registerWake?.(null);
      for (const pending of steeringPending.values()) {
        clearTimeout(pending.timer);
        pending.failReceipt('Worker dispatch stopped; delivery interrupted, outcome unknown, not replayed');
        pending.reject(new Error('Worker dispatch stopped'));
      }
      steeringPending.clear();
      closing = true;
      controller.abort();
      signal.removeEventListener('abort', abort);
      await Promise.allSettled([...running]);
      // Closing the connection returns any unacknowledged deliveries to RabbitMQ.
      try { await connection.close(); }
      catch { if (!failure) console.error('[plex] RabbitMQ connection cleanup failed'); }
    }
  };
}
