import { create } from 'zustand';
import {
  type Node,
  type Edge,
  type OnNodesChange,
  type OnEdgesChange,
  applyNodeChanges,
  applyEdgeChanges,
} from '@xyflow/react';
import { SessionStatus, type SessionInfo } from '../shared/ipc-channels';
import type { SubAgentNodeData } from './components/SubAgentNode';

// Grid layout constants
const GRID_COLS = 3;
const GRID_SPACING_X = 280;
const GRID_SPACING_Y = 120;
const GRID_OFFSET_X = 60;
const GRID_OFFSET_Y = 60;

export interface PlanEntry {
  title: string;
  status: 'active' | 'completed';
}

export interface TaskEntry {
  taskNumber: number;
  description: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export type SessionNodeData = {
  label: string;
  sessionId: string;
  status: SessionStatus;
  mode: 'normal' | 'plan';
  plans: PlanEntry[];
  tasks: TaskEntry[];
  [key: string]: unknown;
};

export type GroupNodeData = {
  label: string;
  [key: string]: unknown;
};

interface SubagentEntry {
  subagentId: string;
  sessionId: string;
  description: string;
  status: 'active' | 'completed' | 'faded';
  spawnedAt: number;
}

export interface AppState {
  nodes: Node[];
  edges: Edge[];
  sessions: Record<string, SessionInfo>;
  subagents: Record<string, SubagentEntry>;
  selectedSessionId: string | null;
  sessionBuffers: Record<string, string>;
  displayNames: Record<string, string>;
  nodeCounter: number;

  // Actions
  addSession: (info: SessionInfo) => void;
  removeSession: (id: string) => void;
  updateStatus: (id: string, status: SessionStatus) => void;
  selectSession: (id: string | null) => void;
  appendBuffer: (id: string, data: string) => void;

  // Sub-agent actions
  spawnSubagent: (sessionId: string, subagentId: string, description: string) => void;
  completeSubagent: (sessionId: string, subagentId: string) => void;
  cleanupStaleSubagents: () => void;

  // Plan & task actions
  enterPlan: (sessionId: string, planTitle: string) => void;
  exitPlan: (sessionId: string) => void;
  createTask: (sessionId: string, taskNumber: number, description: string) => void;
  updateTask: (sessionId: string, taskNumber: number, status: 'pending' | 'in_progress' | 'completed') => void;
  reconcileTasks: (sessionId: string, tasks: TaskEntry[]) => void;

  // React Flow
  onNodesChange: OnNodesChange;
  onEdgesChange: OnEdgesChange;

  // Send dialog
  sendDialogSourceId: string | null;
  openSendDialog: (sourceSessionId: string) => void;
  closeSendDialog: () => void;

  // Grouping
  createGroup: (nodeIdA: string, nodeIdB: string) => void;
  addToGroup: (groupId: string, nodeId: string) => void;
  removeFromGroup: (nodeId: string) => void;
  renameGroup: (groupId: string, name: string) => void;
  renameSession: (sessionId: string, name: string) => void;
}

let groupCounter = 0;

const SUBAGENT_SPACING_X = 140;

export const useAppStore = create<AppState>((set, get) => ({
  nodes: [],
  edges: [],
  sessions: {},
  subagents: {},
  selectedSessionId: null,
  sessionBuffers: {},
  displayNames: {},
  nodeCounter: 0,
  sendDialogSourceId: null,

  addSession: (info: SessionInfo) => {
    const { nodes, nodeCounter } = get();
    const col = nodeCounter % GRID_COLS;
    const row = Math.floor(nodeCounter / GRID_COLS);

    const newNode: Node = {
      id: info.id,
      type: 'sessionNode',
      position: {
        x: GRID_OFFSET_X + col * GRID_SPACING_X,
        y: GRID_OFFSET_Y + row * GRID_SPACING_Y,
      },
      data: {
        label: info.title,
        sessionId: info.id,
        status: info.status,
        mode: 'normal',
        plans: [],
        tasks: [],
      } satisfies SessionNodeData,
    };

    set({
      nodes: [...nodes, newNode],
      sessions: { ...get().sessions, [info.id]: info },
      sessionBuffers: { ...get().sessionBuffers, [info.id]: '' },
      nodeCounter: nodeCounter + 1,
    });
  },

  removeSession: (id: string) => {
    set((state) => {
      const { [id]: _sess, ...restSessions } = state.sessions;
      const { [id]: _buf, ...restBuffers } = state.sessionBuffers;
      const { [id]: _dn, ...restDisplayNames } = state.displayNames;

      // Find sub-agent IDs belonging to this session
      const subagentIds = new Set(
        Object.values(state.subagents)
          .filter((s) => s.sessionId === id)
          .map((s) => s.subagentId)
      );

      // Remove sub-agent entries
      const restSubagents = Object.fromEntries(
        Object.entries(state.subagents).filter(([, s]) => s.sessionId !== id)
      );

      // Remove edges connected to this session or its sub-agents
      const edges = state.edges.filter(
        (e) => e.source !== id && !subagentIds.has(e.target)
      );

      // Remove the node and its sub-agent nodes; if it was in a group, handle group cleanup
      const node = state.nodes.find((n) => n.id === id);
      let nodes = state.nodes.filter(
        (n) => n.id !== id && !subagentIds.has(n.id)
      );

      // If it was in a group, check if group should dissolve
      if (node?.parentId) {
        const remainingChildren = nodes.filter((n) => n.parentId === node.parentId);
        if (remainingChildren.length <= 1) {
          const parentNode = nodes.find((n) => n.id === node.parentId);
          nodes = nodes
            .filter((n) => n.id !== node.parentId)
            .map((n) => {
              if (n.parentId === node.parentId) {
                const { parentId, extent, ...rest } = n;
                return {
                  ...rest,
                  position: {
                    x: (parentNode?.position.x || 0) + n.position.x,
                    y: (parentNode?.position.y || 0) + n.position.y,
                  },
                };
              }
              return n;
            });
        }
      }

      return {
        nodes,
        edges,
        sessions: restSessions,
        sessionBuffers: restBuffers,
        displayNames: restDisplayNames,
        subagents: restSubagents,
        selectedSessionId: state.selectedSessionId === id ? null : state.selectedSessionId,
      };
    });
  },

  updateStatus: (id: string, status: SessionStatus) => {
    set((state) => ({
      sessions: {
        ...state.sessions,
        [id]: state.sessions[id] ? { ...state.sessions[id], status } : state.sessions[id],
      },
      nodes: state.nodes.map((n) =>
        n.id === id && n.type === 'sessionNode'
          ? { ...n, data: { ...n.data, status } }
          : n
      ),
    }));
  },

  selectSession: (id: string | null) => {
    set({ selectedSessionId: id });
  },

  appendBuffer: (id: string, data: string) => {
    set((state) => {
      let buf = (state.sessionBuffers[id] || '') + data;
      // Cap at ~512KB to prevent unbounded memory growth
      if (buf.length > 512 * 1024) {
        buf = buf.slice(-512 * 1024);
      }
      return {
        sessionBuffers: {
          ...state.sessionBuffers,
          [id]: buf,
        },
      };
    });
  },

  spawnSubagent: (sessionId: string, subagentId: string, description: string) => {
    const { nodes, edges, subagents } = get();
    // Idempotency guard — ignore duplicate spawns
    if (subagents[subagentId]) return;
    const parentNode = nodes.find((n) => n.id === sessionId);
    if (!parentNode) return;

    // Count existing sub-agents for this session to fan out horizontally
    const siblingCount = Object.values(subagents).filter(
      (s) => s.sessionId === sessionId
    ).length;
    const offsetX = (siblingCount - 0) * SUBAGENT_SPACING_X;

    const newNode: Node = {
      id: subagentId,
      type: 'subagentNode',
      position: {
        x: parentNode.position.x + offsetX,
        y: parentNode.position.y + 90,
      },
      data: {
        label: description,
        status: 'active',
      } satisfies SubAgentNodeData,
    };

    const newEdge: Edge = {
      id: `edge-${sessionId}-${subagentId}`,
      source: sessionId,
      target: subagentId,
      type: 'smoothstep',
      animated: true,
      style: { stroke: '#7dcfff', strokeWidth: 2 },
    };

    set({
      nodes: [...nodes, newNode],
      edges: [...edges, newEdge],
      subagents: {
        ...subagents,
        [subagentId]: { subagentId, sessionId, description, status: 'active', spawnedAt: Date.now() },
      },
    });
  },

  completeSubagent: (_sessionId: string, subagentId: string) => {
    const { nodes, edges, subagents } = get();
    if (!subagents[subagentId]) return;

    set({
      nodes: nodes.map((n) =>
        n.id === subagentId
          ? { ...n, data: { ...n.data, status: 'completed' } }
          : n
      ),
      edges: edges.map((e) =>
        e.target === subagentId
          ? { ...e, animated: false, style: { stroke: '#9ece6a', strokeWidth: 2 } }
          : e
      ),
      subagents: {
        ...subagents,
        [subagentId]: { ...subagents[subagentId], status: 'completed' },
      },
    });

    // Fade after 10 seconds
    setTimeout(() => {
      const current = get();
      if (!current.subagents[subagentId]) return;

      set({
        nodes: current.nodes.map((n) =>
          n.id === subagentId
            ? { ...n, data: { ...n.data, status: 'faded' } }
            : n
        ),
        edges: current.edges.map((e) =>
          e.target === subagentId
            ? { ...e, style: { stroke: '#565f89', strokeWidth: 1 } }
            : e
        ),
        subagents: {
          ...current.subagents,
          [subagentId]: { ...current.subagents[subagentId], status: 'faded' },
        },
      });

      // Remove faded node entirely after another 10 seconds (20s total)
      setTimeout(() => {
        const later = get();
        if (!later.subagents[subagentId]) return;
        const { [subagentId]: _removed, ...restSubagents } = later.subagents;
        set({
          nodes: later.nodes.filter((n) => n.id !== subagentId),
          edges: later.edges.filter((e) => e.target !== subagentId),
          subagents: restSubagents,
        });
      }, 10_000);
    }, 10_000);
  },

  cleanupStaleSubagents: () => {
    const STALE_MS = 3 * 60 * 1000; // 3 minutes
    const now = Date.now();
    const { subagents } = get();
    for (const entry of Object.values(subagents)) {
      if (entry.status === 'active' && now - entry.spawnedAt > STALE_MS) {
        // Trigger the normal complete → fade → remove chain
        get().completeSubagent(entry.sessionId, entry.subagentId);
      }
    }
  },

  enterPlan: (sessionId: string, planTitle: string) => {
    set((state) => ({
      nodes: state.nodes.map((n) => {
        if (n.id !== sessionId || n.type !== 'sessionNode') return n;
        const data = n.data as SessionNodeData;
        const plans = [...data.plans, { title: planTitle, status: 'active' as const }].slice(-3);
        return { ...n, data: { ...data, mode: 'plan' as const, plans } };
      }),
    }));
  },

  exitPlan: (sessionId: string) => {
    set((state) => ({
      nodes: state.nodes.map((n) => {
        if (n.id !== sessionId || n.type !== 'sessionNode') return n;
        const data = n.data as SessionNodeData;
        const plans = data.plans.map((p) =>
          p.status === 'active' ? { ...p, status: 'completed' as const } : p
        );
        return { ...n, data: { ...data, mode: 'normal' as const, plans, tasks: [] } };
      }),
    }));
  },

  createTask: (sessionId: string, taskNumber: number, description: string) => {
    set((state) => ({
      nodes: state.nodes.map((n) => {
        if (n.id !== sessionId || n.type !== 'sessionNode') return n;
        const tasks = (n.data as SessionNodeData).tasks;
        if (tasks.some((t: TaskEntry) => t.taskNumber === taskNumber)) return n;
        return { ...n, data: { ...n.data, tasks: [...tasks, { taskNumber, description, status: 'pending' as const }] } };
      }),
    }));
  },

  updateTask: (sessionId: string, taskNumber: number, status: 'pending' | 'in_progress' | 'completed') => {
    set((state) => ({
      nodes: state.nodes.map((n) => {
        if (n.id !== sessionId || n.type !== 'sessionNode') return n;
        const tasks = (n.data as SessionNodeData).tasks;
        return {
          ...n,
          data: {
            ...n.data,
            tasks: tasks.map((t: TaskEntry) => t.taskNumber === taskNumber ? { ...t, status } : t),
          },
        };
      }),
    }));
  },

  reconcileTasks: (sessionId: string, tasks: TaskEntry[]) => {
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === sessionId && n.type === 'sessionNode'
          ? { ...n, data: { ...n.data, tasks } }
          : n
      ),
    }));
  },

  openSendDialog: (sourceSessionId: string) => {
    set({ sendDialogSourceId: sourceSessionId });
  },

  closeSendDialog: () => {
    set({ sendDialogSourceId: null });
  },

  onNodesChange: (changes) => {
    set({ nodes: applyNodeChanges(changes, get().nodes) });
  },

  onEdgesChange: (changes) => {
    set({ edges: applyEdgeChanges(changes, get().edges) });
  },

  createGroup: (nodeIdA: string, nodeIdB: string) => {
    groupCounter++;
    const groupId = `group-${groupCounter}`;
    const { nodes } = get();

    const nodeA = nodes.find((n) => n.id === nodeIdA);
    const nodeB = nodes.find((n) => n.id === nodeIdB);
    if (!nodeA || !nodeB) return;

    const minX = Math.min(nodeA.position.x, nodeB.position.x) - 20;
    const minY = Math.min(nodeA.position.y, nodeB.position.y) - 40;

    const groupNode: Node = {
      id: groupId,
      type: 'groupNode',
      position: { x: minX, y: minY },
      data: { label: 'New Group' } satisfies GroupNodeData,
      style: { width: GRID_SPACING_X + 200, height: GRID_SPACING_Y + 100 },
    };

    const updatedNodes = nodes.map((n) => {
      if (n.id === nodeIdA || n.id === nodeIdB) {
        return {
          ...n,
          parentId: groupId,
          extent: 'parent' as const,
          position: {
            x: n.position.x - minX,
            y: n.position.y - minY,
          },
        };
      }
      return n;
    });

    // Group node must come before its children
    set({ nodes: [groupNode, ...updatedNodes] });
  },

  addToGroup: (groupId: string, nodeId: string) => {
    const { nodes } = get();
    const groupNode = nodes.find((n) => n.id === groupId);
    if (!groupNode) return;

    set({
      nodes: nodes.map((n) => {
        if (n.id === nodeId) {
          return {
            ...n,
            parentId: groupId,
            extent: 'parent' as const,
            position: {
              x: n.position.x - groupNode.position.x,
              y: n.position.y - groupNode.position.y,
            },
          };
        }
        return n;
      }),
    });
  },

  removeFromGroup: (nodeId: string) => {
    const { nodes } = get();
    const node = nodes.find((n) => n.id === nodeId);
    if (!node || !node.parentId) return;

    const parentNode = nodes.find((n) => n.id === node.parentId);
    const absoluteX = (parentNode?.position.x || 0) + node.position.x;
    const absoluteY = (parentNode?.position.y || 0) + node.position.y;

    // Check if group would be empty or have only 1 child
    const remainingChildren = nodes.filter(
      (n) => n.parentId === node.parentId && n.id !== nodeId
    );

    let updatedNodes = nodes.map((n) => {
      if (n.id === nodeId) {
        const { parentId, extent, ...rest } = n;
        void parentId;
        void extent;
        return { ...rest, position: { x: absoluteX, y: absoluteY } };
      }
      return n;
    });

    // Remove group if only 1 child remains — unparent that child too
    if (remainingChildren.length === 1) {
      const lastChild = remainingChildren[0];
      const lastChildAbsX = (parentNode?.position.x || 0) + lastChild.position.x;
      const lastChildAbsY = (parentNode?.position.y || 0) + lastChild.position.y;

      updatedNodes = updatedNodes
        .filter((n) => n.id !== node.parentId)
        .map((n) => {
          if (n.id === lastChild.id) {
            const { parentId, extent, ...rest } = n;
            void parentId;
            void extent;
            return { ...rest, position: { x: lastChildAbsX, y: lastChildAbsY } };
          }
          return n;
        });
    }

    set({ nodes: updatedNodes });
  },

  renameGroup: (groupId: string, name: string) => {
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === groupId ? { ...n, data: { ...n.data, label: name } } : n
      ),
    }));
  },

  renameSession: (sessionId: string, name: string) => {
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === sessionId && n.type === 'sessionNode'
          ? { ...n, data: { ...n.data, label: name } }
          : n
      ),
      displayNames: { ...state.displayNames, [sessionId]: name },
    }));
  },
}));
