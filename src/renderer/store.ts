import { create } from 'zustand';
import {
  type Node,
  type Edge,
  type OnNodesChange,
  type OnEdgesChange,
  applyNodeChanges,
  applyEdgeChanges,
} from '@xyflow/react';
import { SessionStatus, type SessionInfo, type CliTool, type PersistedGroups } from '../shared/ipc-channels';
import type { SubAgentNodeData } from './components/SubAgentNode';
import { getSplitPaneEnabled } from './components/panels/SettingsPanel';

function getAccentColor(): string {
  return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#d18a7a';
}

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
  completedAt?: number;
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
  color: string;
  /** Set once the user manually resizes the bubble; disables auto-fit. */
  manualSize?: number;
  [key: string]: unknown;
};

interface SubagentEntry {
  subagentId: string;
  sessionId: string;
  description: string;
  status: 'active' | 'completed' | 'faded';
  spawnedAt: number;
}

export type PanelId = 'explorer' | 'search' | 'templates' | 'settings';

export interface AppState {
  nodes: Node[];
  edges: Edge[];
  sessions: Record<string, SessionInfo>;
  subagents: Record<string, SubagentEntry>;
  /** @deprecated Use activePaneId instead. Kept for backward compat — returns activePaneId. */
  selectedSessionId: string | null;
  /** Ordered list of open terminal pane session IDs (max ~3) */
  openPanes: string[];
  /** Which pane is currently active/focused */
  activePaneId: string | null;
  /** When true, GraphCanvas should focus/zoom the selected node */
  shouldFocusNode: boolean;
  sessionBuffers: Record<string, string>;
  displayNames: Record<string, string>;
  nodeCounter: number;

  // Actions
  addSession: (info: SessionInfo) => void;
  removeSession: (id: string) => void;
  deleteSession: (id: string) => Promise<void>;
  updateStatus: (id: string, status: SessionStatus) => void;
  updateSessionInfo: (id: string, partial: Partial<SessionInfo>) => void;
  selectSession: (id: string | null, focus?: boolean) => void;
  openPane: (sessionId: string) => void;
  closePane: (sessionId: string) => void;
  appendBuffer: (id: string, data: string) => void;

  // Sub-agent actions
  spawnSubagent: (sessionId: string, subagentId: string, description: string) => void;
  completeSubagent: (sessionId: string, subagentId: string) => void;
  dismissSubagent: (subagentId: string) => void;

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

  /** Bumped on viewport pan/zoom — nodes watch this to dismiss menus */
  viewportMoveCount: number;
  bumpViewportMove: () => void;

  // Grouping
  createGroup: (nodeIdA: string, nodeIdB: string) => void;
  createGroupWithMembers: (memberIds: string[], opts?: { label?: string; color?: string }) => void;
  addToGroup: (groupId: string, nodeId: string, opts?: { reposition?: boolean }) => void;
  removeFromGroup: (nodeId: string) => void;
  recomputeGroup: (groupId: string) => void;
  resizeGroup: (groupId: string, size: number, opts?: { recenter?: boolean }) => void;
  renameGroup: (groupId: string, name: string) => void;
  restoreGroups: (persisted: PersistedGroups) => void;
  renameSession: (sessionId: string, name: string) => void;

  // Message flash
  flashMessageEdge: (sourceId: string, targetId: string) => void;

  // Terminal panel tab
  terminalTab: 'session' | 'git';
  setTerminalTab: (tab: 'session' | 'git') => void;

  // Project launcher
  launcherOpen: boolean;
  launcherMode: 'new' | 'resume';
  launcherCli: CliTool;
  openLauncher: (mode: 'new' | 'resume', cli?: CliTool) => void;
  closeLauncher: () => void;

  // Side panel
  activePanelId: PanelId | null;
  sidePanelWidth: number;
  togglePanel: (panelId: PanelId) => void;
  setSidePanelWidth: (width: number) => void;

  // Terminal fullscreen
  terminalFullscreen: boolean;
  toggleTerminalFullscreen: () => void;

  // Drawing overlay
  drawingMode: boolean;
  drawTool: 'pen' | 'eraser' | 'rect' | 'text';
  drawColor: string;
  toggleDrawingMode: () => void;
  setDrawTool: (tool: 'pen' | 'eraser' | 'rect' | 'text') => void;
  setDrawColor: (color: string) => void;

  // Imperative handles set by DrawingOverlay (not part of public API)
  _drawUndo?: () => void;
  _drawRedo?: () => void;
  _drawClear?: () => void;
  _drawCanUndo: boolean;
  _drawCanRedo: boolean;
  _drawHasElements: boolean;
}

let groupCounter = 0;
let groupColorCounter = 0;
const TASK_CLEAR_DELAY_MS = 5000;
const taskClearTimers = new Map<string, ReturnType<typeof setTimeout>>();

// ── Grouping geometry ──────────────────────────────────────────────────────────
/** Fallback node dimensions when React Flow hasn't measured a node yet. */
const DEFAULT_NODE_WIDTH = 180;
const DEFAULT_NODE_HEIGHT = 56;
/** Slack between the outermost member and the group circle edge. */
const GROUP_PADDING = 44;
/** Smallest a group circle can shrink to (radius), so single nodes look intentional. */
const GROUP_MIN_RADIUS = 110;
/** Smallest diameter a user can manually shrink a bubble to. */
const GROUP_MIN_MANUAL_SIZE = 120;
/** Gap used when the context menu adds a far-away node adjacent to a group. */
const GROUP_ADJACENT_GAP = 40;

/** Chrome-like palette; new groups cycle through it. */
const GROUP_COLORS = ['#7aa2f7', '#e06c75', '#e5c07b', '#98c379', '#56b6c2', '#c678dd', '#d18a7a', '#e08aa8'];

function nextGroupColor(): string {
  const color = GROUP_COLORS[groupColorCounter % GROUP_COLORS.length];
  groupColorCounter++;
  return color;
}

/** Prefer React Flow's measured size; fall back to explicit width/height or defaults. */
function getNodeSize(node: Node): { width: number; height: number } {
  const anyNode = node as Node & { measured?: { width?: number; height?: number }; width?: number; height?: number };
  const styleW = typeof node.style?.width === 'number' ? node.style.width : undefined;
  const styleH = typeof node.style?.height === 'number' ? node.style.height : undefined;
  return {
    width: anyNode.measured?.width ?? anyNode.width ?? styleW ?? DEFAULT_NODE_WIDTH,
    height: anyNode.measured?.height ?? anyNode.height ?? styleH ?? DEFAULT_NODE_HEIGHT,
  };
}

/** Numeric width of a group node (its width === height, kept circular). */
function groupSize(group: Node): number {
  return getNodeSize(group).width;
}

/** True when the user has manually resized this group; auto-fit is then disabled. */
function isManualGroup(group: Node): boolean {
  return typeof (group.data as GroupNodeData).manualSize === 'number';
}

/**
 * Resize/reposition a group's bounding circle to enclose all its members, keeping
 * the members visually fixed (their absolute positions are preserved while their
 * parent-relative positions are recomputed against the new group origin).
 *
 * No-op for manually-resized groups: the user's chosen size/position is preserved.
 */
function computeGroupGeometry(nodes: Node[], groupId: string): Node[] {
  const group = nodes.find((n) => n.id === groupId);
  if (!group) return nodes;
  if (isManualGroup(group)) return nodes;
  const members = nodes.filter((n) => n.parentId === groupId);
  if (members.length === 0) return nodes;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const memberAbs = members.map((m) => {
    const { width, height } = getNodeSize(m);
    const x = group.position.x + m.position.x;
    const y = group.position.y + m.position.y;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + width);
    maxY = Math.max(maxY, y + height);
    return { id: m.id, x, y, width, height };
  });

  const center = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  let radius = GROUP_MIN_RADIUS;
  for (const m of memberAbs) {
    const corners = [
      [m.x, m.y],
      [m.x + m.width, m.y],
      [m.x, m.y + m.height],
      [m.x + m.width, m.y + m.height],
    ];
    for (const [cx, cy] of corners) {
      radius = Math.max(radius, Math.hypot(cx - center.x, cy - center.y));
    }
  }
  radius += GROUP_PADDING;

  const newPos = { x: center.x - radius, y: center.y - radius };
  const size = radius * 2;

  return nodes.map((n) => {
    if (n.id === groupId) {
      return { ...n, position: newPos, width: size, height: size };
    }
    if (n.parentId === groupId) {
      const abs = memberAbs.find((a) => a.id === n.id);
      if (abs) return { ...n, position: { x: abs.x - newPos.x, y: abs.y - newPos.y } };
    }
    return n;
  });
}

/** React Flow requires every parent to precede its children; groups never nest, so
 *  putting all group nodes first (stably) is sufficient. */
function sortGroupsFirst(nodes: Node[]): Node[] {
  const groups = nodes.filter((n) => n.type === 'groupNode');
  const rest = nodes.filter((n) => n.type !== 'groupNode');
  return [...groups, ...rest];
}

/** Serialize current groups into the persisted shape (membership keyed by both the
 *  live node id and the stable resume UUID). Deterministically ordered so callers can
 *  diff the JSON to skip redundant disk writes. */
export function serializeGroups(nodes: Node[], sessions: Record<string, SessionInfo>): PersistedGroups {
  const groups = nodes.filter((n) => n.type === 'groupNode');
  const out = groups.map((g) => {
    const members = nodes
      .filter((n) => n.parentId === g.id && n.type === 'sessionNode')
      .map((n) => ({ sessionId: n.id, resumeSessionId: sessions[n.id]?.resumeSessionId ?? null }))
      .sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    const data = g.data as GroupNodeData;
    return { label: data.label, color: data.color, manualSize: data.manualSize, members };
  });
  out.sort((a, b) => (a.label + a.color).localeCompare(b.label + b.color));
  return { groups: out.filter((g) => g.members.length > 0) };
}

/** Detach a node from its group: convert to absolute position, clear parentId, then
 *  dissolve the old group if empty or refit it otherwise. */
function detachFromGroup(nodes: Node[], nodeId: string): Node[] {
  const node = nodes.find((n) => n.id === nodeId);
  if (!node || !node.parentId) return nodes;
  const parentId = node.parentId;
  const parent = nodes.find((n) => n.id === parentId);
  const abs = {
    x: (parent?.position.x ?? 0) + node.position.x,
    y: (parent?.position.y ?? 0) + node.position.y,
  };

  let updated = nodes.map((n) => {
    if (n.id !== nodeId) return n;
    const { parentId: _p, extent: _e, ...rest } = n as Node & { extent?: unknown };
    void _p; void _e;
    return { ...rest, position: abs } as Node;
  });

  const remaining = updated.filter((n) => n.parentId === parentId);
  if (remaining.length === 0) {
    updated = updated.filter((n) => n.id !== parentId);
  } else {
    updated = computeGroupGeometry(updated, parentId);
  }
  return updated;
}

const SUBAGENT_SPACING_X = 140;

export const useAppStore = create<AppState>((set, get) => ({
  nodes: [],
  edges: [],
  sessions: {},
  subagents: {},
  selectedSessionId: null,
  openPanes: [],
  activePaneId: null,
  shouldFocusNode: false,
  sessionBuffers: {},
  displayNames: {},
  nodeCounter: 0,
  sendDialogSourceId: null,
  viewportMoveCount: 0,
  bumpViewportMove: () => set((s) => ({ viewportMoveCount: s.viewportMoveCount + 1 })),
  terminalTab: 'session' as const,
  setTerminalTab: (tab: 'session' | 'git') => set({ terminalTab: tab }),
  launcherOpen: false,
  launcherMode: 'new' as const,
  launcherCli: 'claude' as CliTool,

  openLauncher: (mode: 'new' | 'resume', cli: CliTool = 'claude') => {
    set({ launcherOpen: true, launcherMode: mode, launcherCli: cli });
  },

  closeLauncher: () => {
    set({ launcherOpen: false });
  },

  activePanelId: null,
  sidePanelWidth: 240,

  togglePanel: (panelId: PanelId) => {
    set((state) => ({
      activePanelId: state.activePanelId === panelId ? null : panelId,
    }));
  },

  setSidePanelWidth: (width: number) => {
    set({ sidePanelWidth: Math.max(160, Math.min(400, width)) });
  },

  terminalFullscreen: false,
  toggleTerminalFullscreen: () => set((s) => ({ terminalFullscreen: !s.terminalFullscreen })),

  drawingMode: false,
  drawTool: 'pen' as const,
  drawColor: '#d18a7a',
  _drawCanUndo: false,
  _drawCanRedo: false,
  _drawHasElements: false,
  toggleDrawingMode: () => {
    set((state) => ({ drawingMode: !state.drawingMode }));
  },
  setDrawTool: (tool: 'pen' | 'eraser' | 'rect' | 'text') => set({ drawTool: tool }),
  setDrawColor: (color: string) => set({ drawColor: color }),

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
    const timer = taskClearTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      taskClearTimers.delete(id);
    }
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

      // If it was in a group: dissolve the group if now empty, otherwise refit it.
      if (node?.parentId) {
        const parentId = node.parentId;
        const remainingChildren = nodes.filter((n) => n.parentId === parentId);
        if (remainingChildren.length === 0) {
          nodes = nodes.filter((n) => n.id !== parentId);
        } else {
          nodes = computeGroupGeometry(nodes, parentId);
        }
      }
      nodes = sortGroupsFirst(nodes);

      const newOpenPanes = state.openPanes.filter((pid) => pid !== id);
      let newActivePaneId = state.activePaneId;
      if (state.activePaneId === id) {
        newActivePaneId = newOpenPanes.length > 0 ? newOpenPanes[newOpenPanes.length - 1] : null;
      }

      return {
        nodes,
        edges,
        sessions: restSessions,
        sessionBuffers: restBuffers,
        displayNames: restDisplayNames,
        subagents: restSubagents,
        openPanes: newOpenPanes,
        activePaneId: newActivePaneId,
        selectedSessionId: newActivePaneId,
      };
    });
  },

  deleteSession: async (id: string) => {
    // Kill the session in the main process (PTY, watchers, etc.)
    await window.agentPlex.killSession(id);
    // Clean up UI state
    get().removeSession(id);
  },

  updateStatus: (id: string, status: SessionStatus) => {
    set((state) => {
      if (!state.sessions[id]) return state;
      return {
        sessions: {
          ...state.sessions,
          [id]: { ...state.sessions[id], status },
        },
        nodes: state.nodes.map((n) =>
          n.id === id && n.type === 'sessionNode'
            ? { ...n, data: { ...n.data, status } }
            : n
        ),
      };
    });
  },

  updateSessionInfo: (id: string, partial: Partial<SessionInfo>) => {
    set((state) => {
      if (!state.sessions[id]) return state;
      const merged = { ...state.sessions[id], ...partial };
      return {
        sessions: {
          ...state.sessions,
          [id]: merged,
        },
        nodes: state.nodes.map((n) =>
          n.id === id && n.type === 'sessionNode'
            ? { ...n, data: { ...n.data, cli: merged.cli, cwd: merged.cwd } }
            : n
        ),
      };
    });
  },

  selectSession: (id: string | null, focus = false) => {
    if (id === null) {
      // Close all panes
      set({ openPanes: [], activePaneId: null, selectedSessionId: null, shouldFocusNode: focus, terminalTab: 'session' });
    } else {
      // Open or activate pane
      get().openPane(id);
      set({ shouldFocusNode: focus, terminalTab: 'session' });
    }
  },

  openPane: (sessionId: string) => {
    const { openPanes } = get();
    if (openPanes.includes(sessionId)) {
      // Already open — just activate it
      set({ activePaneId: sessionId, selectedSessionId: sessionId });
    } else if (!getSplitPaneEnabled()) {
      // Split pane disabled — replace all panes with the new one
      set({ openPanes: [sessionId], activePaneId: sessionId, selectedSessionId: sessionId });
    } else {
      // Add new pane (cap at 3 — remove the oldest non-active pane if needed)
      let newPanes = [...openPanes, sessionId];
      if (newPanes.length > 3) {
        newPanes = [...newPanes.slice(1)];
      }
      set({ openPanes: newPanes, activePaneId: sessionId, selectedSessionId: sessionId });
    }
  },

  closePane: (sessionId: string) => {
    const { openPanes, activePaneId } = get();
    const newPanes = openPanes.filter((id) => id !== sessionId);
    let newActive = activePaneId;
    if (activePaneId === sessionId) {
      // Activate the last remaining pane, or null
      newActive = newPanes.length > 0 ? newPanes[newPanes.length - 1] : null;
    }
    const updates: Partial<AppState> = { openPanes: newPanes, activePaneId: newActive, selectedSessionId: newActive };
    if (newPanes.length === 0) updates.terminalFullscreen = false;
    set(updates);
  },

  appendBuffer: (id: string, data: string) => {
    set((state) => {
      let buf = (state.sessionBuffers[id] || '') + data;
      // Cap at ~2MB to bound memory growth while retaining enough recent output
      // for the in-memory "open sessions" search and transcript restore.
      if (buf.length > 2 * 1024 * 1024) {
        buf = buf.slice(-2 * 1024 * 1024);
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
      style: { stroke: getAccentColor(), strokeWidth: 2 },
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

    // Skip green — go straight to faded. CSS handles 3s opacity transition.
    set({
      nodes: nodes.map((n) =>
        n.id === subagentId
          ? { ...n, data: { ...n.data, status: 'faded' } }
          : n
      ),
      edges: edges.map((e) =>
        e.target === subagentId
          ? { ...e, animated: false, className: 'edge-fading' }
          : e
      ),
      subagents: {
        ...subagents,
        [subagentId]: { ...subagents[subagentId], status: 'faded' },
      },
    });

    // Remove after the 3s CSS fade completes
    setTimeout(() => {
      const current = get();
      if (!current.subagents[subagentId]) return;
      const { [subagentId]: _removed, ...restSubagents } = current.subagents;
      set({
        nodes: current.nodes.filter((n) => n.id !== subagentId),
        edges: current.edges.filter((e) => e.target !== subagentId),
        subagents: restSubagents,
      });
    }, 3_000);
  },

  dismissSubagent: (subagentId: string) => {
    const { nodes, edges, subagents } = get();
    if (!subagents[subagentId]) return;
    const { [subagentId]: _removed, ...restSubagents } = subagents;
    set({
      nodes: nodes.filter((n) => n.id !== subagentId),
      edges: edges.filter((e) => e.target !== subagentId),
      subagents: restSubagents,
    });
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
    const timer = taskClearTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      taskClearTimers.delete(sessionId);
    }
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
    const timer = taskClearTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      taskClearTimers.delete(sessionId);
    }
    set((state) => ({
      nodes: state.nodes.map((n) => {
        if (n.id !== sessionId || n.type !== 'sessionNode') return n;
        const tasks = (n.data as SessionNodeData).tasks;
        if (tasks.some((t: TaskEntry) => t.taskNumber === taskNumber)) return n;
        return { ...n, data: { ...n.data, tasks: [...tasks, { taskNumber, description, status: 'pending' as const, completedAt: undefined }] } };
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
            tasks: tasks.map((t: TaskEntry) => {
              if (t.taskNumber !== taskNumber) return t;
              const completedAt = status === 'completed'
                ? (t.status === 'completed' ? t.completedAt ?? Date.now() : Date.now())
                : undefined;
              return { ...t, status, completedAt };
            }),
          },
        };
      }),
    }));

    const currentNode = get().nodes.find((n) => n.id === sessionId && n.type === 'sessionNode');
    const currentTasks = (currentNode?.data as SessionNodeData | undefined)?.tasks ?? [];
    const allCompleted = currentTasks.length > 0 && currentTasks.every((t) => t.status === 'completed');
    const existingTimer = taskClearTimers.get(sessionId);
    if (existingTimer) clearTimeout(existingTimer);
    if (allCompleted) {
      const timer = setTimeout(() => {
        const latestNode = get().nodes.find((n) => n.id === sessionId && n.type === 'sessionNode');
        const latestTasks = (latestNode?.data as SessionNodeData | undefined)?.tasks ?? [];
        if (latestTasks.length > 0 && latestTasks.every((t) => t.status === 'completed')) {
          set((state) => ({
            nodes: state.nodes.map((n) =>
              n.id === sessionId && n.type === 'sessionNode'
                ? { ...n, data: { ...n.data, tasks: [] } }
                : n
            ),
          }));
        }
        taskClearTimers.delete(sessionId);
      }, TASK_CLEAR_DELAY_MS);
      taskClearTimers.set(sessionId, timer);
    } else {
      taskClearTimers.delete(sessionId);
    }
  },

  reconcileTasks: (sessionId: string, tasks: TaskEntry[]) => {
    set((state) => ({
      nodes: state.nodes.map((n) => {
        if (n.id !== sessionId || n.type !== 'sessionNode') return n;
        const prevTasks = (n.data as SessionNodeData).tasks;
        const prevByTask = new Map(prevTasks.map((t) => [t.taskNumber, t]));
        const mergedTasks: TaskEntry[] = tasks.map((t) => {
          const prev = prevByTask.get(t.taskNumber);
          if (t.status === 'completed') {
            return {
              ...t,
              completedAt: prev?.status === 'completed' ? (prev.completedAt ?? Date.now()) : Date.now(),
            };
          }
          return { ...t, completedAt: undefined };
        });
        return { ...n, data: { ...n.data, tasks: mergedTasks } };
      }),
    }));

    const currentNode = get().nodes.find((n) => n.id === sessionId && n.type === 'sessionNode');
    const currentTasks = (currentNode?.data as SessionNodeData | undefined)?.tasks ?? [];
    const allCompleted = currentTasks.length > 0 && currentTasks.every((t) => t.status === 'completed');
    const existingTimer = taskClearTimers.get(sessionId);
    if (existingTimer) clearTimeout(existingTimer);
    if (allCompleted) {
      const timer = setTimeout(() => {
        const latestNode = get().nodes.find((n) => n.id === sessionId && n.type === 'sessionNode');
        const latestTasks = (latestNode?.data as SessionNodeData | undefined)?.tasks ?? [];
        if (latestTasks.length > 0 && latestTasks.every((t) => t.status === 'completed')) {
          set((state) => ({
            nodes: state.nodes.map((n) =>
              n.id === sessionId && n.type === 'sessionNode'
                ? { ...n, data: { ...n.data, tasks: [] } }
                : n
            ),
          }));
        }
        taskClearTimers.delete(sessionId);
      }, TASK_CLEAR_DELAY_MS);
      taskClearTimers.set(sessionId, timer);
    } else {
      taskClearTimers.delete(sessionId);
    }
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
    get().createGroupWithMembers([nodeIdA, nodeIdB]);
  },

  createGroupWithMembers: (memberIds: string[], opts?: { label?: string; color?: string }) => {
    // Detach any members that are currently in another group (one group per node).
    let base = get().nodes;
    for (const id of memberIds) base = detachFromGroup(base, id);

    const present = memberIds.filter((id) => base.some((n) => n.id === id && n.type === 'sessionNode'));
    if (present.length === 0) return;

    groupCounter++;
    const groupId = `group-${groupCounter}`;
    const groupNode: Node = {
      id: groupId,
      type: 'groupNode',
      position: { x: 0, y: 0 },
      data: { label: opts?.label ?? 'New Group', color: opts?.color ?? nextGroupColor() } satisfies GroupNodeData,
      // Members are top-level after detach, so their absolute position equals their
      // position relative to a group at (0,0); computeGroupGeometry fixes the origin.
      width: GROUP_MIN_RADIUS * 2,
      height: GROUP_MIN_RADIUS * 2,
    };

    base = base.map((n) => (present.includes(n.id) ? { ...n, parentId: groupId } : n));
    base = [groupNode, ...base];
    base = computeGroupGeometry(base, groupId);
    set({ nodes: sortGroupsFirst(base) });
  },

  addToGroup: (groupId: string, nodeId: string, opts?: { reposition?: boolean }) => {
    let base = detachFromGroup(get().nodes, nodeId);
    const group = base.find((n) => n.id === groupId);
    const node = base.find((n) => n.id === nodeId);
    if (!group || !node) return;

    const size = groupSize(group);
    const nodeSz = getNodeSize(node);
    let abs: { x: number; y: number };
    if (opts?.reposition && isManualGroup(group)) {
      // Manual circle won't auto-grow, so drop the node inside, near the centre.
      abs = {
        x: group.position.x + size / 2 - nodeSz.width / 2,
        y: group.position.y + size / 2 - nodeSz.height / 2,
      };
    } else if (opts?.reposition) {
      // Menu adds snap the node next to the circle so a far-away node doesn't blow
      // the circle up across the canvas; the geometry refit then encloses it.
      abs = {
        x: group.position.x + size + GROUP_ADJACENT_GAP,
        y: group.position.y + size / 2 - nodeSz.height / 2,
      };
    } else {
      // Drag adds keep the drop point.
      abs = { x: node.position.x, y: node.position.y };
    }

    base = base.map((n) =>
      n.id === nodeId
        ? { ...n, parentId: groupId, position: { x: abs.x - group.position.x, y: abs.y - group.position.y } }
        : n
    );
    base = computeGroupGeometry(base, groupId);
    set({ nodes: sortGroupsFirst(base) });
  },

  removeFromGroup: (nodeId: string) => {
    set({ nodes: sortGroupsFirst(detachFromGroup(get().nodes, nodeId)) });
  },

  recomputeGroup: (groupId: string) => {
    set({ nodes: sortGroupsFirst(computeGroupGeometry(get().nodes, groupId)) });
  },

  resizeGroup: (groupId: string, size: number, opts?: { recenter?: boolean }) => {
    const clamped = Math.max(GROUP_MIN_MANUAL_SIZE, size);
    set((state) => ({
      nodes: state.nodes.map((n) => {
        if (n.id !== groupId) return n;
        const cur = getNodeSize(n);
        // recenter keeps the circle centred on its current centre (programmatic
        // resize); the NodeResizer path leaves position to React Flow.
        const position = opts?.recenter
          ? {
              x: n.position.x + cur.width / 2 - clamped / 2,
              y: n.position.y + cur.height / 2 - clamped / 2,
            }
          : n.position;
        return { ...n, position, width: clamped, height: clamped, data: { ...n.data, manualSize: clamped } };
      }),
    }));
  },

  renameGroup: (groupId: string, name: string) => {
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === groupId ? { ...n, data: { ...n.data, label: name } } : n
      ),
    }));
  },

  restoreGroups: (persisted: PersistedGroups) => {
    if (!persisted || !Array.isArray(persisted.groups)) return;
    const state = get();

    // Map a stable resume UUID → current node id, but only when it's unambiguous
    // (a UUID shared by two live sessions can't be matched reliably).
    const resumeCounts = new Map<string, number>();
    const resumeToId = new Map<string, string>();
    for (const [id, info] of Object.entries(state.sessions)) {
      const rid = info.resumeSessionId;
      if (!rid) continue;
      resumeCounts.set(rid, (resumeCounts.get(rid) ?? 0) + 1);
      resumeToId.set(rid, id);
    }
    const presentSessionIds = new Set(
      state.nodes.filter((n) => n.type === 'sessionNode' && !n.parentId).map((n) => n.id)
    );
    const claimed = new Set<string>();

    for (const group of persisted.groups) {
      const memberIds: string[] = [];
      for (const m of group.members) {
        // Prefer the original id (renderer reload keeps ids stable).
        let resolved: string | undefined;
        if (presentSessionIds.has(m.sessionId)) {
          resolved = m.sessionId;
        } else if (m.resumeSessionId && resumeCounts.get(m.resumeSessionId) === 1) {
          const candidate = resumeToId.get(m.resumeSessionId);
          if (candidate && presentSessionIds.has(candidate)) resolved = candidate;
        }
        if (resolved && !claimed.has(resolved)) {
          claimed.add(resolved);
          memberIds.push(resolved);
        }
      }
      if (memberIds.length === 0) continue;
      get().createGroupWithMembers(memberIds, { label: group.label, color: group.color });
      if (typeof group.manualSize === 'number') {
        // createGroupWithMembers prepends the new group, so it's nodes[0].
        const created = get().nodes[0];
        if (created && created.type === 'groupNode') {
          get().resizeGroup(created.id, group.manualSize, { recenter: true });
        }
      }
    }
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
    window.agentPlex.updateSessionState(sessionId, name);
  },

  flashMessageEdge: (sourceId: string, targetId: string) => {
    const edgeId = `msg-${sourceId}-${targetId}-${Date.now()}`;
    const { edges } = get();

    const newEdge: Edge = {
      id: edgeId,
      source: sourceId,
      target: targetId,
      type: 'smoothstep',
      animated: true,
      className: 'edge-message',
      markerEnd: { type: 'arrowclosed' as any, color: getAccentColor(), width: 16, height: 16 },
      style: { stroke: getAccentColor(), strokeWidth: 2 },
    };

    set({ edges: [...edges, newEdge] });

    // Fade out then remove
    setTimeout(() => {
      const current = get();
      set({
        edges: current.edges.map((e) =>
          e.id === edgeId ? { ...e, className: 'edge-message edge-message--fading' } : e
        ),
      });

      // Remove after CSS transition completes
      setTimeout(() => {
        const later = get();
        set({ edges: later.edges.filter((e) => e.id !== edgeId) });
      }, 1000);
    }, 1000);
  },
}));
