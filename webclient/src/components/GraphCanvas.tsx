import { useCallback, useEffect, useMemo } from 'react';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  useNodesState,
  type Node,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useStore, termKey } from '../store';
import { SessionNodeComp, type SessionNodeData } from './SessionNode';
import { SubAgentNodeComp, type SubAgentNodeData } from './SubAgentNode';
import { MachineGroupNode, type MachineGroupData } from './MachineGroupNode';
import { EMPTY_TRACE, type MachineStatus, type SessionTrace } from '../relay/types';

const NODE_W = 230;
const PAD = 16;
const HEADER = 36;
const ROW_GAP = 22;
const GROUP_GAP = 44;
const START_X = 60;
const START_Y = 40;

// Subagent lane sits to the right of the session column.
const SUB_W = 180;
const SUB_H = 34;
const SUB_GAP = 10;
const LANE_GAP = 40;
const GROUP_W = PAD * 2 + NODE_W + LANE_GAP + SUB_W;

const DISCONNECTED: MachineStatus = { relayState: 'disconnected', online: false, error: null };

const nodeTypes = {
  session: SessionNodeComp,
  subagent: SubAgentNodeComp,
  machineGroup: MachineGroupNode,
};

/** Estimate a session node's rendered height from its trace so siblings stack
 *  without overlapping (session nodes grow with plan/task rows). */
function estSessionHeight(trace: SessionTrace): number {
  let h = 62; // title + cwd footer
  if (trace.mode === 'plan') h += 26;
  h += trace.plans.length * 17;
  const completed = trace.tasks.filter(t => t.status === 'completed');
  const keep = new Set(completed.slice(-2).map(t => t.taskNumber));
  const visible = trace.tasks.filter(t => t.status !== 'completed' || keep.has(t.taskNumber));
  h += Math.min(visible.length, 4) * 17;
  if (visible.length > 4) h += 14;
  return h;
}

interface Props {
  onSelectSession: (machineId: string, sessionId: string) => void;
}

export default function GraphCanvas({ onSelectSession }: Props) {
  const machines = useStore(s => s.machines);
  const sessions = useStore(s => s.sessions);
  const displayNames = useStore(s => s.displayNames);
  const status = useStore(s => s.status);
  const traces = useStore(s => s.traces);
  const active = useStore(s => s.active);
  const sendCommand = useStore(s => s.sendCommand);

  const alive = useMemo(() => sessions.filter(s => s.status !== 'killed'), [sessions]);

  const build = useCallback((): { nodes: Node[]; edges: Edge[] } => {
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    let groupY = START_Y;

    for (const machine of machines) {
      const mid = machine.machineId;
      const mSessions = alive.filter(s => s.machineId === mid);

      let cursor = HEADER + PAD;
      const childNodes: Node[] = [];

      for (const session of mSessions) {
        const trace = traces[termKey(mid, session.id)] ?? EMPTY_TRACE;
        const subs = trace.subagents;
        const sessionH = estSessionHeight(trace);
        const sessionNodeId = `${mid}:${session.id}`;

        const data: SessionNodeData = {
          session,
          displayName: displayNames[mid]?.[session.id] ?? session.title,
          trace,
          selected: active?.machineId === mid && active?.sessionId === session.id,
          onClick: () => onSelectSession(mid, session.id),
        };
        childNodes.push({
          id: sessionNodeId,
          type: 'session',
          parentId: `group:${mid}`,
          extent: 'parent',
          position: { x: PAD, y: cursor },
          data,
          draggable: true,
          selectable: false,
        });

        subs.forEach((sa, j) => {
          const subId = `${mid}:${session.id}:sub:${sa.subagentId}`;
          const subData: SubAgentNodeData = { label: sa.description || 'sub-agent', status: sa.status };
          childNodes.push({
            id: subId,
            type: 'subagent',
            parentId: `group:${mid}`,
            extent: 'parent',
            position: { x: PAD + NODE_W + LANE_GAP, y: cursor + j * (SUB_H + SUB_GAP) },
            data: subData,
            draggable: true,
            selectable: false,
          });
          edges.push({
            id: `edge-${subId}`,
            source: sessionNodeId,
            target: subId,
            style: { stroke: 'var(--accent)', strokeWidth: 1.5, opacity: sa.status === 'active' ? 1 : 0.4 },
            animated: sa.status === 'active',
          });
        });

        const subsH = subs.length * (SUB_H + SUB_GAP);
        cursor += Math.max(sessionH, subsH) + ROW_GAP;
      }

      const groupH = Math.max(cursor + PAD, HEADER + PAD * 2 + 56);

      const groupData: MachineGroupData = {
        label: machine.name,
        machineId: mid,
        status: status[mid] ?? DISCONNECTED,
        sessionCount: mSessions.length,
        onAddSession: () => sendCommand(mid, { type: 'session:create', cli: 'claude' }),
      };
      nodes.push({
        id: `group:${mid}`,
        type: 'machineGroup',
        position: { x: START_X, y: groupY },
        data: groupData,
        style: { width: GROUP_W, height: groupH },
        draggable: true,
        selectable: false,
      });
      nodes.push(...childNodes);

      groupY += groupH + GROUP_GAP;
    }

    return { nodes, edges };
  }, [machines, alive, displayNames, status, traces, active, sendCommand, onSelectSession]);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(build().nodes);
  const edges = useMemo(() => build().edges, [build]);

  useEffect(() => {
    setNodes(prev => {
      const prevMap = new Map(prev.map(n => [n.id, n]));
      return build().nodes.map(n => {
        const old = prevMap.get(n.id);
        if (old && n.type === 'session') return { ...n, position: old.position };
        return n;
      });
    });
  }, [build, setNodes]);

  return (
    <div className="graph-canvas w-full h-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        nodeTypes={nodeTypes}
        minZoom={0.3}
        maxZoom={2}
        defaultViewport={{ x: 0, y: 0, zoom: 1 }}
        fitViewOptions={{ padding: 0.2 }}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} color="var(--border)" />
      </ReactFlow>
    </div>
  );
}
