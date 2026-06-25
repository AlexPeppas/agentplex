import { create } from 'zustand';
import { openDB } from 'idb';
import type {
  SessionInfo,
  PairedMachine,
  MachineStatus,
  MachineCommand,
  MachineEvent,
  SessionTrace,
  TaskStatus,
} from './relay/types';
import { EMPTY_TRACE } from './relay/types';
import { RelayClient } from './relay/client';

const PAIRED_DB = 'agentplex-state';
const PAIRED_STORE = 'paired';
const MACHINES_KEY = 'machines';
const LEGACY_KEY = 'machine'; // single-machine layout from the original prototype

/** Composite key for terminal buffers — session ids are only unique per machine. */
export function termKey(machineId: string, sessionId: string): string {
  return `${machineId}:${sessionId}`;
}

const DISCONNECTED: MachineStatus = { relayState: 'disconnected', online: false, error: null };

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

  // Terminal buffers keyed by termKey(machineId, sessionId).
  terminalData: Record<string, string>;

  // Live trace state (plan/tasks/subagents) keyed by termKey(machineId, sessionId).
  traces: Record<string, SessionTrace>;

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
    // Mutate the trace for one session via a copy-on-write updater.
    const updateTrace = (sessionId: string, fn: (t: SessionTrace) => SessionTrace) => {
      set(s => {
        const k = termKey(machineId, sessionId);
        const current = s.traces[k] ?? EMPTY_TRACE;
        return { traces: { ...s.traces, [k]: fn(current) } };
      });
    };

    switch (event.type) {
      case 'session:list':
        set(s => ({
          sessions: [
            ...s.sessions.filter(sess => sess.machineId !== machineId),
            ...event.sessions.map(sess => ({ ...sess, machineId })),
          ],
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
              claudeSessionUuid: event.claudeSessionUuid,
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
          return { terminalData: { ...s.terminalData, [k]: (s.terminalData[k] ?? '') + event.data } };
        });
        break;

      case 'session:buffer':
        set(s => ({
          terminalData: { ...s.terminalData, [termKey(machineId, event.id)]: event.buffer },
        }));
        break;

      case 'displayNames':
        set(s => ({ displayNames: { ...s.displayNames, [machineId]: event.names } }));
        break;

      // ── Live trace events (mirror of the desktop graph) ──
      case 'subagent:spawn':
        updateTrace(event.sessionId, t => (
          t.subagents.some(sa => sa.subagentId === event.subagentId)
            ? t
            : { ...t, subagents: [...t.subagents, { subagentId: event.subagentId, description: event.description, status: 'active' }] }
        ));
        break;

      case 'subagent:complete':
        updateTrace(event.sessionId, t => ({
          ...t,
          subagents: t.subagents.map(sa =>
            sa.subagentId === event.subagentId ? { ...sa, status: 'completed' as const } : sa,
          ),
        }));
        // Fade the completed subagent out shortly after, matching the desktop.
        setTimeout(() => {
          set(s => {
            const k = termKey(machineId, event.sessionId);
            const trace = s.traces[k];
            if (!trace) return {};
            return { traces: { ...s.traces, [k]: { ...trace, subagents: trace.subagents.filter(sa => sa.subagentId !== event.subagentId) } } };
          });
        }, 4000);
        break;

      case 'plan:enter':
        updateTrace(event.sessionId, t => ({
          ...t,
          mode: 'plan',
          plans: [
            ...t.plans.map(p => (p.status === 'active' ? { ...p, status: 'completed' as const } : p)),
            { title: event.planTitle, status: 'active' as const },
          ],
        }));
        break;

      case 'plan:exit':
        updateTrace(event.sessionId, t => ({
          ...t,
          mode: 'normal',
          plans: t.plans.map(p => (p.status === 'active' ? { ...p, status: 'completed' as const } : p)),
        }));
        break;

      case 'task:create':
        updateTrace(event.sessionId, t => (
          t.tasks.some(task => task.taskNumber === event.taskNumber)
            ? t
            : { ...t, tasks: [...t.tasks, { taskNumber: event.taskNumber, description: event.description, status: 'pending' as const }] }
        ));
        break;

      case 'task:update':
        updateTrace(event.sessionId, t => ({
          ...t,
          tasks: t.tasks.map(task =>
            task.taskNumber === event.taskNumber
              ? { ...task, status: (event.status as TaskStatus) }
              : task,
          ),
        }));
        break;

      case 'task:list':
        updateTrace(event.sessionId, t => ({
          ...t,
          tasks: event.tasks.map(task => ({
            taskNumber: task.taskNumber,
            description: task.description,
            status: (task.status as TaskStatus),
          })),
        }));
        break;

      default:
        break;
    }
  }

  function startClient(machine: PairedMachine): RelayClient {
    patchStatus(machine.machineId, { relayState: 'connecting', error: null });
    const client = new RelayClient(machine, {
      onError: (msg) => patchStatus(machine.machineId, { error: msg }),
      onStatus: (relayState, online) => patchStatus(machine.machineId, { relayState, online, error: null }),
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
    terminalData: {},
    traces: {},
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
        const terminalData = Object.fromEntries(
          Object.entries(s.terminalData).filter(([k]) => !k.startsWith(`${machineId}:`)),
        );
        const traces = Object.fromEntries(
          Object.entries(s.traces).filter(([k]) => !k.startsWith(`${machineId}:`)),
        );
        return {
          machines,
          clients,
          status,
          displayNames,
          terminalData,
          traces,
          sessions: s.sessions.filter(sess => sess.machineId !== machineId),
          active: s.active?.machineId === machineId ? null : s.active,
        };
      });
    },

    setActiveSession: (machineId, sessionId) => {
      set({ active: { machineId, sessionId } });
      const { terminalData, clients } = get();
      if (!terminalData[termKey(machineId, sessionId)]) {
        clients.get(machineId)?.send({ type: 'session:getBuffer', id: sessionId });
      }
    },

    clearActiveSession: () => set({ active: null }),

    sendCommand: (machineId, cmd) => {
      get().clients.get(machineId)?.send(cmd);
    },

    requestBuffer: (machineId, sessionId) => {
      get().clients.get(machineId)?.send({ type: 'session:getBuffer', id: sessionId });
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
