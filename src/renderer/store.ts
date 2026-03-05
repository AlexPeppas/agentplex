import { create } from 'zustand';
import {
  type Node,
  type OnNodesChange,
  applyNodeChanges,
} from '@xyflow/react';
import { SessionStatus, type SessionInfo } from '../shared/ipc-channels';

// Grid layout constants
const GRID_COLS = 3;
const GRID_SPACING_X = 280;
const GRID_SPACING_Y = 120;
const GRID_OFFSET_X = 60;
const GRID_OFFSET_Y = 60;

export type SessionNodeData = {
  label: string;
  sessionId: string;
  status: SessionStatus;
  [key: string]: unknown;
};

export type GroupNodeData = {
  label: string;
  [key: string]: unknown;
};

export interface AppState {
  nodes: Node[];
  sessions: Record<string, SessionInfo>;
  selectedSessionId: string | null;
  sessionBuffers: Record<string, string>;
  nodeCounter: number;

  // Actions
  addSession: (info: SessionInfo) => void;
  removeSession: (id: string) => void;
  updateStatus: (id: string, status: SessionStatus) => void;
  selectSession: (id: string | null) => void;
  appendBuffer: (id: string, data: string) => void;

  // React Flow
  onNodesChange: OnNodesChange;

  // Grouping
  createGroup: (nodeIdA: string, nodeIdB: string) => void;
  addToGroup: (groupId: string, nodeId: string) => void;
  removeFromGroup: (nodeId: string) => void;
  renameGroup: (groupId: string, name: string) => void;
}

let groupCounter = 0;

export const useAppStore = create<AppState>((set, get) => ({
  nodes: [],
  sessions: {},
  selectedSessionId: null,
  sessionBuffers: {},
  nodeCounter: 0,

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
      // Remove the node; if it was in a group, handle group cleanup
      const node = state.nodes.find((n) => n.id === id);
      let nodes = state.nodes.filter((n) => n.id !== id);

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
        sessions: restSessions,
        sessionBuffers: restBuffers,
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
    set((state) => ({
      sessionBuffers: {
        ...state.sessionBuffers,
        [id]: (state.sessionBuffers[id] || '') + data,
      },
    }));
  },

  onNodesChange: (changes) => {
    set({ nodes: applyNodeChanges(changes, get().nodes) });
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
}));
