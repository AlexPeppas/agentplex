import { useCallback, useEffect, useMemo } from 'react';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  useNodesState,
  type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useStore } from '../store';
import { SessionNodeComp, type SessionNodeData } from './SessionNode';
import { MachineGroupNode, type MachineGroupData } from './MachineGroupNode';
import type { MachineStatus } from '../relay/types';

const NODE_W = 210;
const NODE_H = 72;
const COL_GAP = 22;
const ROW_GAP = 18;
const COLS = 2;
const PAD = 14;
const HEADER = 36;
const GROUP_GAP = 40;
const START_X = 60;
const START_Y = 40;
const GROUP_W = PAD * 2 + COLS * NODE_W + (COLS - 1) * COL_GAP;

const DISCONNECTED: MachineStatus = { relayState: 'disconnected', online: false, error: null };

const nodeTypes = { session: SessionNodeComp, machineGroup: MachineGroupNode };

interface Props {
  onSelectSession: (machineId: string, sessionId: string) => void;
}

export default function GraphCanvas({ onSelectSession }: Props) {
  const machines = useStore(s => s.machines);
  const sessions = useStore(s => s.sessions);
  const displayNames = useStore(s => s.displayNames);
  const status = useStore(s => s.status);
  const sendCommand = useStore(s => s.sendCommand);

  const alive = useMemo(() => sessions.filter(s => s.status !== 'killed'), [sessions]);

  const buildNodes = useCallback((): Node[] => {
    const nodes: Node[] = [];
    let y = START_Y;

    for (const machine of machines) {
      const mid = machine.machineId;
      const mSessions = alive.filter(s => s.machineId === mid);
      const rows = Math.max(1, Math.ceil(mSessions.length / COLS));
      const groupH = HEADER + PAD * 2 + rows * NODE_H + (rows - 1) * ROW_GAP;

      // Machine container (parent) node.
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
        position: { x: START_X, y },
        data: groupData,
        style: { width: GROUP_W, height: groupH },
        draggable: true,
        selectable: false,
      });

      // Session child nodes, positioned relative to the group.
      mSessions.forEach((session, i) => {
        const col = i % COLS;
        const row = Math.floor(i / COLS);
        const data: SessionNodeData = {
          session,
          displayName: displayNames[mid]?.[session.id] ?? session.title,
          onClick: () => onSelectSession(mid, session.id),
        };
        nodes.push({
          id: `${mid}:${session.id}`,
          type: 'session',
          parentId: `group:${mid}`,
          extent: 'parent',
          position: {
            x: PAD + col * (NODE_W + COL_GAP),
            y: HEADER + PAD + row * (NODE_H + ROW_GAP),
          },
          data,
          draggable: true,
          selectable: false,
        });
      });

      y += groupH + GROUP_GAP;
    }

    return nodes;
  }, [machines, alive, displayNames, status, sendCommand, onSelectSession]);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(buildNodes());

  // Rebuild when data changes, preserving user-dragged positions by node id.
  useEffect(() => {
    setNodes(prev => {
      const prevMap = new Map(prev.map(n => [n.id, n]));
      return buildNodes().map(n => {
        const old = prevMap.get(n.id);
        // Preserve dragged session positions; group layout is always recomputed.
        if (old && n.type === 'session') return { ...n, position: old.position };
        return n;
      });
    });
  }, [buildNodes, setNodes]);

  return (
    <div className="w-full h-full">
      <ReactFlow
        nodes={nodes}
        edges={[]}
        onNodesChange={onNodesChange}
        nodeTypes={nodeTypes}
        minZoom={0.3}
        maxZoom={2}
        defaultViewport={{ x: 0, y: 0, zoom: 1 }}
        fitViewOptions={{ padding: 0.2 }}
        proOptions={{ hideAttribution: true }}
        style={{ background: '#1a1814' }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} color="#2a2520" />
      </ReactFlow>
    </div>
  );
}
