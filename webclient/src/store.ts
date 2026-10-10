import { create } from 'zustand';
import { openDB } from 'idb';
import type {
  SessionInfo,
  PairedMachine,
  MachineStatus,
  MachineCommand,
  MachineEvent,
  SessionTrace,
  MachineCapabilities,
  CommandResult,
} from './relay/types';
import { EMPTY_TRACE } from './relay/types';
import { RelayClient } from './relay/client';
import { isTraceChannel, isTraceEvent, reduceTrace } from '../../src/shared/session-trace';

const PAIRED_DB = 'agentplex-state';
const PAIRED_STORE = 'paired';
const MACHINES_KEY = 'machines';
const LEGACY_KEY = 'machine'; // single-machine layout from the original prototype

/** Composite key for terminal buffers — session ids are only unique per machine. */
export function termKey(machineId: string, sessionId: string): string {
  return `${machineId}:${sessionId}`;
}

const DISCONNECTED: MachineStatus = { relayState: 'disconnected', online: false, error: null };
const TERMINAL_BUFFER_LIMIT = 512 * 1024;

async function getDB() {
  return openDB(PAIRED_DB, 1, {
    upgrade(db) { db.createObjectStore(PAIRED_STORE); },
  });
}

async function loadMachines(): Promise<PairedMachine[]> {
  try {
    const db = await getDB();
    const arr = (await db.get(PAIRED_STORE, MACHINES_KEY)) as PairedMachine[] | undefined;
    if (arr && arr.length) return arr;

    // Migrate the legacy single-machine record into the new array layout.
    const legacy = (await db.get(PAIRED_STORE, LEGACY_KEY)) as PairedMachine | undefined;
    if (legacy) {
      await db.put(PAIRED_STORE, [legacy], MACHINES_KEY);
      await db.delete(PAIRED_STORE, LEGACY_KEY);
      return [legacy];
    }
    return [];
  } catch {
    return [];
  }
}

async function persistMachines(machines: PairedMachine[]): Promise<void> {
  const db = await getDB();
  await db.put(PAIRED_STORE, machines, MACHINES_KEY);
}

interface AppState {
  // Paired machines (persisted) and their live connection status.
  machines: PairedMachine[];
  status: Record<string, MachineStatus>; // machineId → status

  // Merged session list across all machines. Every session is tagged machineId.
  sessions: SessionInfo[];
  displayNames: Record<string, Record<string, string>>; // machineId → sessionId → name
  capabilities: Record<string, MachineCapabilities>;

  // Terminal buffers keyed by termKey(machineId, sessionId).
  terminalData: Record<string, string>;
  terminalGeneration: Record<string, number>;

  // Live trace state (plan/tasks/subagents) keyed by termKey(machineId, sessionId).
  traces: Record<string, SessionTrace>;
  traceRevisions: Record<string, number>;

  // Currently focused session (machine-scoped).
  active: { machineId: string; sessionId: string } | null;

  // Live relay clients, one per machine. Not part of render state.
  clients: Map<string, RelayClient>;

  // Actions
  initRelay: () => Promise<void>;
  addMachine: (m: PairedMachine) => Promise<void>;
  removeMachine: (machineId: string) => Promise<void>;
  setActiveSession: (machineId: string, sessionId: string) => void;
  clearActiveSession: () => void;
  sendCommand: (machineId: string, cmd: MachineCommand) => void;
  executeCommand: (machineId: string, cmd: MachineCommand) => Promise<CommandResult>;
  requestBuffer: (machineId: string, sessionId: string) => void;
}

export const useStore = create<AppState>((set, get) => {
  function patchStatus(machineId: string, patch: Partial<MachineStatus>) {
    set(s => ({
      status: {
        ...s.status,
        [machineId]: { ...(s.status[machineId] ?? DISCONNECTED), ...patch },
      },
    }));
  }

  function handleEvent(machineId: string, event: MachineEvent) {
    if (isTraceEvent(event)) {
      const k = termKey(machineId, event.sessionId);
      const previous = get().traces[k];
      set(s => {
        if (event.revision !== undefined && event.revision <= (s.traceRevisions[k] ?? -1)) return {};
        const current = s.traces[k] ?? EMPTY_TRACE;
        const next = event.trace ?? reduceTrace(current, event);
        const completed = current.subagents.filter(sa => sa.status === 'completed' &&
          !next.subagents.some(nextAgent => nextAgent.subagentId === sa.subagentId));
        return {
          traces: { ...s.traces, [k]: { ...next, subagents: [...next.subagents, ...completed] } },
          traceRevisions: event.revision === undefined ? s.traceRevisions :
            { ...s.traceRevisions, [k]: event.revision },
        };
      });
      if (event.type === 'subagent:complete' && previous !== get().traces[k]) {
        const completed = get().traces[k]?.subagents.find(sa => sa.subagentId === event.subagentId);
        if (completed) setTimeout(() => set(s => {
          const trace = s.traces[k];
          if (!trace?.subagents.includes(completed)) return {};
          return { traces: { ...s.traces, [k]: {
            ...trace, subagents: trace.subagents.filter(sa => sa !== completed),
          } } };
        }), 4000);
      }
      return;
    }
    if (isTraceChannel(event.type)) {
      console.error('[remote/trace] Invalid desktop trace event:', event.type);
      patchStatus(machineId, { traceReady: false, error: 'Invalid desktop trace event' });
      return;
    }

    switch (event.type) {
      case 'session:list':
        set(s => {
          const ids = new Set(event.sessions.map(session => session.id));
          const belongsToMissingSession = (key: string) =>
            key.startsWith(`${machineId}:`) && !ids.has(key.slice(machineId.length + 1));
          const traces = Object.fromEntries(Object.entries(s.traces).filter(([key]) => !belongsToMissingSession(key)));
          const traceRevisions = Object.fromEntries(Object.entries(s.traceRevisions).filter(([key]) => !belongsToMissingSession(key)));
          for (const session of event.sessions) {
            const snapshot = event.traces?.[session.id];
            if (!snapshot) continue;
            const key = termKey(machineId, session.id);
            if (snapshot.revision < (traceRevisions[key] ?? -1)) continue;
            traces[key] = snapshot.trace;
            traceRevisions[key] = snapshot.revision;
          }
          return {
            sessions: [
            ...s.sessions.filter(sess => sess.machineId !== machineId),
            ...event.sessions.map(sess => ({ ...sess, machineId })),
            ],
            displayNames: { ...s.displayNames, [machineId]: event.names ?? s.displayNames[machineId] ?? {} },
            terminalData: Object.fromEntries(Object.entries(s.terminalData).filter(([key]) => !belongsToMissingSession(key))),
            terminalGeneration: Object.fromEntries(Object.entries(s.terminalGeneration).filter(([key]) => !belongsToMissingSession(key))),
            traces, traceRevisions,
            active: s.active?.machineId === machineId && !ids.has(s.active.sessionId) ? null : s.active,
          };
        });
        patchStatus(machineId, {
          traceReady: event.sessions.every(session => Boolean(event.traces?.[session.id])),
          error: event.traces ? null : 'Desktop trace recovery unavailable; update AgentPlex.',
        });
        if (!get().status[machineId]?.ready) {
          patchStatus(machineId, { ready: true });
          const active = get().active;
          if (active?.machineId === machineId) get().requestBuffer(machineId, active.sessionId);
        }
        break;

      case 'machine:capabilities':
        set(s => ({ capabilities: { ...s.capabilities, [machineId]: { home: event.home, clis: event.clis } } }));
        break;

      case 'command:result':
        if (event.error) patchStatus(machineId, { error: event.error });
        break;

      case 'session:info':
        set(s => ({
          sessions: s.sessions.map(session => session.machineId === machineId && session.id === event.id
            ? { ...session, ...event, machineId } : session),
        }));
        break;

      case 'session:created':
        set(s => ({
          sessions: [
            ...s.sessions.filter(sess => !(sess.machineId === machineId && sess.id === event.id)),
            {
              id: event.id,
              title: event.title,
              status: event.status,
              pid: event.pid,
              cwd: event.cwd,
              cli: event.cli,
              resumeSessionId: event.resumeSessionId,
              machineId,
            },
          ],
        }));
        break;

      case 'session:status':
        set(s => ({
          sessions: s.sessions.map(sess =>
            sess.machineId === machineId && sess.id === event.id
              ? { ...sess, status: event.status }
              : sess,
          ),
        }));
        break;

      case 'session:exit':
        set(s => ({
          sessions: s.sessions.map(sess =>
            sess.machineId === machineId && sess.id === event.id
              ? { ...sess, status: 'killed' as const }
              : sess,
          ),
        }));
        break;

      case 'session:data':
        set(s => {
          const k = termKey(machineId, event.id);
          const buffer = (s.terminalData[k] ?? '') + event.data;
          return {
            terminalData: { ...s.terminalData, [k]: buffer.slice(-TERMINAL_BUFFER_LIMIT) },
            terminalGeneration: buffer.length > TERMINAL_BUFFER_LIMIT
              ? { ...s.terminalGeneration, [k]: (s.terminalGeneration[k] ?? 0) + 1 }
              : s.terminalGeneration,
          };
        });
        break;

      case 'session:buffer':
        set(s => {
          const key = termKey(machineId, event.id);
          return {
            terminalData: { ...s.terminalData, [key]: event.buffer.slice(-TERMINAL_BUFFER_LIMIT) },
            terminalGeneration: {
              ...s.terminalGeneration,
              [key]: (s.terminalGeneration[key] ?? 0) + 1,
            },
          };
        });
        break;

      case 'displayNames':
        set(s => ({ displayNames: { ...s.displayNames, [machineId]: event.names } }));
        break;

      default:
        break;
    }
  }

  function startClient(machine: PairedMachine): RelayClient {
    patchStatus(machine.machineId, { relayState: 'connecting', error: null });
    const client = new RelayClient(machine, {
      onError: (msg) => patchStatus(machine.machineId, { error: msg }),
      onStatus: (relayState, online) => {
        patchStatus(machine.machineId, { relayState, online, ready: false, traceReady: false });
        set(s => ({
          traces: Object.fromEntries(Object.entries(s.traces).filter(([key]) => !key.startsWith(`${machine.machineId}:`))),
          traceRevisions: Object.fromEntries(Object.entries(s.traceRevisions).filter(([key]) => !key.startsWith(`${machine.machineId}:`))),
        }));
      },
      onEvent: (event) => handleEvent(machine.machineId, event),
    });
    void client.start();
    return client;
  }

  return {
    machines: [],
    status: {},
    sessions: [],
    displayNames: {},
    capabilities: {},
    terminalData: {},
    terminalGeneration: {},
    traces: {},
    traceRevisions: {},
    active: null,
    clients: new Map(),

    initRelay: async () => {
      const { machines, clients } = get();
      // Tear down any existing clients first.
      clients.forEach(c => c.stop());
      const next = new Map<string, RelayClient>();
      for (const m of machines) {
        next.set(m.machineId, startClient(m));
      }
      set({ clients: next });
    },

    addMachine: async (m) => {
      const existing = get().machines.filter(x => x.machineId !== m.machineId);
      const machines = [...existing, m];
      await persistMachines(machines);

      // (Re)start the client for this machine.
      get().clients.get(m.machineId)?.stop();
      const clients = new Map(get().clients);
      clients.set(m.machineId, startClient(m));
      set({ machines, clients });
    },

    removeMachine: async (machineId) => {
      const client = get().clients.get(machineId);
      // Best-effort: ask the relay to revoke this device, then disconnect.
      try { await client?.revokeDevice(get().machines.find(m => m.machineId === machineId)?.deviceId ?? ''); } catch { /* ignore */ }
      client?.stop();

      const machines = get().machines.filter(m => m.machineId !== machineId);
      await persistMachines(machines);

      const clients = new Map(get().clients);
      clients.delete(machineId);

      set(s => {
        const status = { ...s.status }; delete status[machineId];
        const displayNames = { ...s.displayNames }; delete displayNames[machineId];
        const capabilities = { ...s.capabilities }; delete capabilities[machineId];
        const terminalData = Object.fromEntries(
          Object.entries(s.terminalData).filter(([k]) => !k.startsWith(`${machineId}:`)),
        );
        const terminalGeneration = Object.fromEntries(
          Object.entries(s.terminalGeneration).filter(([k]) => !k.startsWith(`${machineId}:`)),
        );
        const traces = Object.fromEntries(
          Object.entries(s.traces).filter(([k]) => !k.startsWith(`${machineId}:`)),
        );
        const traceRevisions = Object.fromEntries(
          Object.entries(s.traceRevisions).filter(([k]) => !k.startsWith(`${machineId}:`)),
        );
        return {
          machines,
          clients,
          status,
          displayNames,
          capabilities,
          terminalData,
          terminalGeneration,
          traces,
          traceRevisions,
          sessions: s.sessions.filter(sess => sess.machineId !== machineId),
          active: s.active?.machineId === machineId ? null : s.active,
        };
      });
    },

    setActiveSession: (machineId, sessionId) => {
      set({ active: { machineId, sessionId } });
      if (get().status[machineId]?.ready) get().requestBuffer(machineId, sessionId);
    },

    clearActiveSession: () => set({ active: null }),

    sendCommand: (machineId, cmd) => {
      const client = get().clients.get(machineId);
      if (!client || !get().status[machineId]?.ready) {
        patchStatus(machineId, { error: 'Machine is not ready; command was not sent' });
        return;
      }
      void client.send(cmd).catch(error => patchStatus(machineId, { error: error.message }));
    },

    executeCommand: async (machineId, cmd) => {
      const client = get().clients.get(machineId);
      if (!client || !get().status[machineId]?.ready) throw new Error('Machine is not ready');
      patchStatus(machineId, { error: null });
      return client.request(cmd);
    },

    requestBuffer: (machineId, sessionId) => {
      get().sendCommand(machineId, { type: 'session:getBuffer', id: sessionId });
    },
  };
});

// Bootstrap: load persisted machines on app start and connect to all of them.
export async function bootstrap() {
  const machines = await loadMachines();
  if (machines.length) {
    useStore.setState({
      machines,
      status: Object.fromEntries(machines.map(m => [m.machineId, { ...DISCONNECTED }])),
    });
    await useStore.getState().initRelay();
  }
}
