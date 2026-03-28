import { useCallback, useEffect, useRef } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  useReactFlow,
  type Node,
  type OnNodeDrag,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { SessionNode } from './SessionNode';
import { GroupNode } from './GroupNode';
import { SubAgentNode } from './SubAgentNode';
import { DrawingOverlay } from './DrawingOverlay';
import { useAppStore } from '../store';

const nodeTypes = {
  sessionNode: SessionNode,
  groupNode: GroupNode,
  subagentNode: SubAgentNode,
};

export function GraphCanvas() {
  const nodes = useAppStore((s) => s.nodes);
  const edges = useAppStore((s) => s.edges);
  const onNodesChange = useAppStore((s) => s.onNodesChange);
  const onEdgesChange = useAppStore((s) => s.onEdgesChange);
  const selectSession = useAppStore((s) => s.selectSession);
  const createGroup = useAppStore((s) => s.createGroup);
  const addToGroup = useAppStore((s) => s.addToGroup);
  const removeFromGroup = useAppStore((s) => s.removeFromGroup);
  const selectedSessionId = useAppStore((s) => s.selectedSessionId);
  const shouldFocusNode = useAppStore((s) => s.shouldFocusNode);
  const drawingMode = useAppStore((s) => s.drawingMode);
  const { fitView } = useReactFlow();
  const dragStartParent = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!shouldFocusNode) return;
    const timer = setTimeout(() => {
      try {
        if (selectedSessionId) {
          fitView({ nodes: [{ id: selectedSessionId }], duration: 200, maxZoom: 1.5 });
        } else {
          const currentNodes = useAppStore.getState().nodes;
          if (currentNodes.length > 0) {
            fitView({ duration: 200 });
          }
        }
      } catch {
        // fitView can fail during unmount or empty graph
      }
    }, 100);
    return () => clearTimeout(timer);
  }, [selectedSessionId, shouldFocusNode, fitView]);

  const onNodeDragStart: OnNodeDrag = useCallback((_event, node) => {
    dragStartParent.current = node.parentId;
  }, []);

  const onNodeDragStop: OnNodeDrag = useCallback(
    (_event, draggedNode) => {
      // Only handle session nodes
      if (draggedNode.type !== 'sessionNode') return;

      const allNodes = useAppStore.getState().nodes;

      // Check if dragged out of a group
      if (dragStartParent.current && !isInsideParent(draggedNode, allNodes)) {
        removeFromGroup(draggedNode.id);
        return;
      }

      // Don't create groups if node is already in a group
      if (draggedNode.parentId) return;

      // Find nodes that the dragged node overlaps
      const draggedRect = getNodeRect(draggedNode);

      for (const targetNode of allNodes) {
        if (targetNode.id === draggedNode.id) continue;

        // Check overlap with a group node → add to group
        if (targetNode.type === 'groupNode') {
          const targetRect = getNodeRect(targetNode);
          if (rectsIntersect(draggedRect, targetRect)) {
            addToGroup(targetNode.id, draggedNode.id);
            return;
          }
        }

        // Check overlap with another ungrouped session node → create new group
        if (
          targetNode.type === 'sessionNode' &&
          !targetNode.parentId
        ) {
          const targetRect = getNodeRect(targetNode);
          if (rectsIntersect(draggedRect, targetRect)) {
            createGroup(draggedNode.id, targetNode.id);
            return;
          }
        }
      }
    },
    [createGroup, addToGroup, removeFromGroup]
  );

  const onPaneClick = useCallback(() => {
    selectSession(null);
  }, [selectSession]);

  return (
    <div className="graph-canvas w-full h-full relative">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStart={onNodeDragStart}
        onNodeDragStop={onNodeDragStop}
        onPaneClick={onPaneClick}
        nodeTypes={nodeTypes}
        fitView
        panOnDrag={!drawingMode}
        zoomOnScroll={!drawingMode}
        zoomOnPinch={!drawingMode}
        zoomOnDoubleClick={!drawingMode}
        nodesDraggable={!drawingMode}
        nodesConnectable={!drawingMode}
        elementsSelectable={!drawingMode}
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls />
      </ReactFlow>
      <DrawingOverlay />
    </div>
  );
}

// Helper functions for hit testing

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const NODE_WIDTH = 180;
const NODE_HEIGHT = 50;

function getNodeRect(node: Node): Rect {
  const width =
    typeof node.style?.width === 'number'
      ? node.style.width
      : NODE_WIDTH;
  const height =
    typeof node.style?.height === 'number'
      ? node.style.height
      : NODE_HEIGHT;
  return {
    x: node.position.x,
    y: node.position.y,
    width,
    height,
  };
}

function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

function isInsideParent(node: Node, allNodes: Node[]): boolean {
  if (!node.parentId) return false;
  const parent = allNodes.find((n) => n.id === node.parentId);
  if (!parent) return false;
  const parentRect = getNodeRect(parent);
  return (
    node.position.x >= 0 &&
    node.position.y >= 0 &&
    node.position.x + NODE_WIDTH <= parentRect.width &&
    node.position.y + NODE_HEIGHT <= parentRect.height
  );
}
