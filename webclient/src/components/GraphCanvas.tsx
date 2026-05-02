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

const NODE_W = 210;
const NODE_H = 72;
const COL_GAP = 30;
const ROW_GAP = 24;
const COLS = 3;
const START_X = 80;
const START_Y = 60;

const nodeTypes = { session: SessionNodeComp };

interface Props {
  onSelectSession: (id: string) => void;
}

export default function GraphCanvas({ onSelectSession }: Props) {
  const sessions = useStore(s => s.sessions);
  const displayNames = useStore(s => s.displayNames);

  const alive = useMemo(() =>
    sessions.filter(s => s.status !== 'killed'),
    [sessions]
  );

  const buildNodes = useCallback((): Node<SessionNodeData>[] => {
    return alive.map((session, i) => {
      const col = i % COLS;
      const row = Math.floor(i / COLS);
      return {
        id: session.id,
        type: 'session',
        position: {
          x: START_X + col * (NODE_W + COL_GAP),
          y: START_Y + row * (NODE_H + ROW_GAP),
        },
        data: {
          session,
          displayName: displayNames[session.id] ?? session.title,
          onClick: () => onSelectSession(session.id),
        },
        draggable: true,
        selectable: false,
      };
    });
  }, [alive, displayNames, onSelectSession]);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node<SessionNodeData>>(buildNodes());

  // Sync nodes when sessions change, preserving user-dragged positions
  useEffect(() => {
    setNodes(prev => {
      const prevMap = new Map(prev.map(n => [n.id, n]));
      return buildNodes().map(n => ({
        ...n,
        // Keep existing position if user already dragged the node
        position: prevMap.get(n.id)?.position ?? n.position,
        data: n.data, // always update data (status, name changes)
      }));
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
        <Background
          variant={BackgroundVariant.Dots}
          gap={24}
          size={1.2}
          color="#2a2520"
        />
      </ReactFlow>
    </div>
  );
}
