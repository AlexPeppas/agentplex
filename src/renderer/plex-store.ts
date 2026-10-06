import { create } from 'zustand';
import type { PlexState, PlexWorkspace } from '../shared/plex';

export const usePlexStore = create<{
  workspace: PlexWorkspace | null;
  selectedId: string | null;
  state: PlexState | null;
  open: boolean;
  error: string | null;
  workerView: { conversationId: string; agentId: string } | null;
  inspectWorker: (conversationId: string, agentId: string) => void;
  closeWorker: () => void;
  setWorkspace: (workspace: PlexWorkspace) => void;
  selectConversation: (id: string | null) => void;
  setOpen: (open: boolean) => void;
  setError: (error: string | null) => void;
}>((set) => ({
  workspace: null, selectedId: null, state: null, open: false, error: null, workerView: null,
  inspectWorker: (conversationId, agentId) => set(previous => {
    if (!previous.workspace?.states[conversationId]?.agents.some(agent => agent.id === agentId)) return previous;
    return { workerView: { conversationId, agentId } };
  }),
  closeWorker: () => set({ workerView: null }),
  setWorkspace: workspace => set(previous => {
    if (previous.workspace && workspace.revision < previous.workspace.revision) return previous;
    const selectedId = previous.selectedId && workspace.states[previous.selectedId] ? previous.selectedId : null;
    return { workspace, selectedId, state: selectedId ? workspace.states[selectedId] : null };
  }),
  selectConversation: selectedId => set(previous => ({
    selectedId, state: selectedId ? previous.workspace?.states[selectedId] ?? null : null, error: null,
  })),
  setOpen: open => set({ open }),
  setError: error => set({ error }),
}));
