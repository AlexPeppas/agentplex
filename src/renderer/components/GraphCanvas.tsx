import { useCallback, useEffect } from 'react';
import {
  ReactFlow,
  Background,
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
  const createGroupWithMembers = useAppStore((s) => s.createGroupWithMembers);
  const addToGroup = useAppStore((s) => s.addToGroup);
  const removeFromGroup = useAppStore((s) => s.removeFromGroup);
  const recomputeGroup = useAppStore((s) => s.recomputeGroup);
  const activePaneId = useAppStore((s) => s.activePaneId);
  const shouldFocusNode = useAppStore((s) => s.shouldFocusNode);
  const drawingMode = useAppStore((s) => s.drawingMode);
  const { fitView } = useReactFlow();

  useEffect(() => {
    if (!shouldFocusNode) return;
    const timer = setTimeout(() => {
      try {
        if (activePaneId) {
          fitView({ nodes: [{ id: activePaneId }], duration: 200, maxZoom: 1.5 });
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
  }, [activePaneId, shouldFocusNode, fitView]);

  const onNodeDragStop: OnNodeDrag = useCallback(
    (_event, draggedNode) => {
      // Dragging a whole group node moves its members automatically (React Flow
      // parent/child) — nothing to reconcile.
      if (draggedNode.type !== 'sessionNode') return;

      // Use the final dragged node from the callback, not the (possibly stale) store copy.
      const storeNodes = useAppStore.getState().nodes;
      const allNodes = storeNodes.map((n) => (n.id === draggedNode.id ? draggedNode : n));

      // Already in a group → either it was dragged out of the circle (remove) or
      // moved within it (refit the circle).
      if (draggedNode.parentId) {
        const group = allNodes.find((n) => n.id === draggedNode.parentId);
        if (!group) return;
        const circle = getGroupCircle(group);
        const center = childAbsoluteCenter(draggedNode, group);
        if (distance(center, circle) > circle.r) {
          removeFromGroup(draggedNode.id);
        } else {
          recomputeGroup(draggedNode.parentId);
        }
        return;
      }

      // Ungrouped node: dropped onto a group circle → join; onto another ungrouped
      // session node → form a new group.
      const draggedCenter = topLevelCenter(draggedNode);
      const draggedRect = getNodeRect(draggedNode);

      for (const targetNode of allNodes) {
        if (targetNode.id === draggedNode.id) continue;

        if (targetNode.type === 'groupNode') {
          const circle = getGroupCircle(targetNode);
          if (distance(draggedCenter, circle) <= circle.r) {
            addToGroup(targetNode.id, draggedNode.id, { reposition: false });
            return;
          }
        }

        if (targetNode.type === 'sessionNode' && !targetNode.parentId) {
          if (rectsIntersect(draggedRect, getNodeRect(targetNode))) {
            createGroupWithMembers([targetNode.id, draggedNode.id]);
            return;
          }
        }
      }
    },
    [createGroupWithMembers, addToGroup, removeFromGroup, recomputeGroup]
  );

  const bumpViewportMove = useAppStore((s) => s.bumpViewportMove);

  const onPaneClick = useCallback(() => {
    selectSession(null);
  }, [selectSession]);

  const onMove = useCallback(() => {
    bumpViewportMove();
  }, [bumpViewportMove]);

  return (
    <div className="graph-canvas w-full h-full relative">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={onNodeDragStop}
        onPaneClick={onPaneClick}
        onMove={onMove}
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

interface Circle {
  x: number;
  y: number;
  r: number;
}

const NODE_WIDTH = 180;
const NODE_HEIGHT = 56;

function getNodeSize(node: Node): { width: number; height: number } {
  const anyNode = node as Node & { measured?: { width?: number; height?: number }; width?: number; height?: number };
  const styleW = typeof node.style?.width === 'number' ? node.style.width : undefined;
  const styleH = typeof node.style?.height === 'number' ? node.style.height : undefined;
  return {
    width: anyNode.measured?.width ?? anyNode.width ?? styleW ?? NODE_WIDTH,
    height: anyNode.measured?.height ?? anyNode.height ?? styleH ?? NODE_HEIGHT,
  };
}

function getNodeRect(node: Node): Rect {
  const { width, height } = getNodeSize(node);
  return { x: node.position.x, y: node.position.y, width, height };
}

/** Bounding circle of a group node (its box is a square rendered rounded-full). */
function getGroupCircle(group: Node): Circle {
  const { width } = getNodeSize(group);
  const r = width / 2;
  return { x: group.position.x + r, y: group.position.y + r, r };
}

/** Absolute centre of a child node given its parent group. */
function childAbsoluteCenter(child: Node, parent: Node): { x: number; y: number } {
  const { width, height } = getNodeSize(child);
  return {
    x: parent.position.x + child.position.x + width / 2,
    y: parent.position.y + child.position.y + height / 2,
  };
}

/** Absolute centre of a top-level node. */
function topLevelCenter(node: Node): { x: number; y: number } {
  const { width, height } = getNodeSize(node);
  return { x: node.position.x + width / 2, y: node.position.y + height / 2 };
}

function distance(p: { x: number; y: number }, c: Circle): number {
  return Math.hypot(p.x - c.x, p.y - c.y);
}

function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}
