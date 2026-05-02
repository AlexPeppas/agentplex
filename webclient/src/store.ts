import { create } from 'zustand';
import { openDB } from 'idb';
import type { SessionInfo, PairedMachine } from './relay/types';
import { RelayClient } from './relay/client';

const PAIRED_DB = 'agentplex-state';
const PAIRED_STORE = 'paired';
const PAIRED_KEY = 'machine';

async function loadPersistedMachine(): Promise<PairedMachine | null> {
  try {
    const db = await openDB(PAIRED_DB, 1, {
      upgrade(db) { db.createObjectStore(PAIRED_STORE); },
    });
    return (await db.get(PAIRED_STORE, PAIRED_KEY)) as PairedMachine | null;
  } catch { return null; }
}

async function persistMachine(m: PairedMachine | null) {
  const db = await openDB(PAIRED_DB, 1, {
    upgrade(db) { db.createObjectStore(PAIRED_STORE); },
  });
  if (m) await db.put(PAIRED_STORE, m, PAIRED_KEY);
  else await db.delete(PAIRED_STORE, PAIRED_KEY);
}

interface AppState {
  // Pairing
  machine: PairedMachine | null;
  relayState: 'disconnected' | 'connecting' | 'connected';
  machineOnline: boolean;
  relayError: string | null;

  // Sessions
  sessions: SessionInfo[];
  displayNames: Record<string, string>;
  activeSessionId: string | null;

  // Terminal buffers (sessionId → accumulated data string)
  terminalData: Record<string, string>;

  // Relay client singleton
  client: RelayClient | null;

  // Actions
  setPairedMachine: (m: PairedMachine) => Promise<void>;
  unpair: () => Promise<void>;
  initRelay: () => Promise<void>;
  setActiveSession: (id: string | null) => void;
  sendCommand: (cmd: import('./relay/types').MachineCommand) => void;
  requestBuffer: (sessionId: string) => void;
}

export const useStore = create<AppState>((set, get) => ({
  machine: null,
  relayState: 'disconnected',
  machineOnline: false,
  relayError: null,
  sessions: [],
  displayNames: {},
  activeSessionId: null,
  terminalData: {},
  client: null,

  setPairedMachine: async (m) => {
    await persistMachine(m);
    set({ machine: m });
    await get().initRelay();
  },

  unpair: async () => {
    get().client?.stop();
    await persistMachine(null);
    const { clearAllKeys } = await import('./crypto/keys');
    await clearAllKeys();
    set({
      machine: null,
      client: null,
      relayState: 'disconnected',
      machineOnline: false,
      relayError: null,
      sessions: [],
      displayNames: {},
      activeSessionId: null,
      terminalData: {},
    });
  },

  initRelay: async () => {
    const { machine } = get();
    if (!machine) return;

    // Tear down existing client if any
    get().client?.stop();

    const client = new RelayClient(machine, {
      onError: (msg) => set({ relayError: msg }),
      onEvent: (event) => {
        const state = get();
        switch (event.type) {
          case 'session:list':
            set({ sessions: event.sessions });
            break;

          case 'session:created':
            set(s => ({
              sessions: [...s.sessions, {
                id: event.id,
                title: event.title,
                status: event.status,
                pid: event.pid,
                cwd: event.cwd,
                cli: event.cli,
                claudeSessionUuid: event.claudeSessionUuid,
              }],
            }));
            break;

          case 'session:status':
            set(s => ({
              sessions: s.sessions.map(sess =>
                sess.id === event.id ? { ...sess, status: event.status } : sess
              ),
            }));
            break;

          case 'session:exit':
            set(s => ({
              sessions: s.sessions.map(sess =>
                sess.id === event.id ? { ...sess, status: 'killed' } : sess
              ),
            }));
            break;

          case 'session:data':
            set(s => ({
              terminalData: {
                ...s.terminalData,
                [event.id]: (s.terminalData[event.id] ?? '') + event.data,
              },
            }));
            break;

          case 'session:buffer':
            // Full buffer replay when we first open a terminal
            set(s => ({ terminalData: { ...s.terminalData, [event.id]: event.buffer } }));
            break;

          case 'displayNames':
            set({ displayNames: event.names });
            break;

          default:
            break;
        }
        void state; // suppress unused warning
      },

      onStatus: (relayState, machineOnline) => {
        set({ relayState, machineOnline, relayError: null });
      },
    });

    set({ client });
    await client.start();
  },

  setActiveSession: (id) => {
    set({ activeSessionId: id });
    if (id) {
      // Request buffer if we don't have it yet
      const { terminalData, client } = get();
      if (!terminalData[id]) {
        client?.send({ type: 'session:getBuffer', id });
      }
    }
  },

  sendCommand: (cmd) => {
    get().client?.send(cmd);
  },

  requestBuffer: (sessionId) => {
    get().client?.send({ type: 'session:getBuffer', id: sessionId });
  },
}));

// Bootstrap: load persisted machine on app start
export async function bootstrap() {
  const machine = await loadPersistedMachine();
  if (machine) {
    useStore.setState({ machine });
    await useStore.getState().initRelay();
  }
}
