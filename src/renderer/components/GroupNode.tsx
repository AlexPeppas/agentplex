import { memo, useState, useRef, useCallback } from 'react';
import { NodeResizer, type NodeProps, type OnResizeEnd } from '@xyflow/react';
import { useAppStore, type GroupNodeData } from '../store';

/** Convert a #rrggbb hex colour to an rgba() string with the given alpha. */
function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const int = parseInt(m[1], 16);
  const r = (int >> 16) & 255;
  const g = (int >> 8) & 255;
  const b = int & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export const GroupNode = memo(function GroupNode({ data, id, selected }: NodeProps) {
  const nodeData = data as GroupNodeData;
  const color = nodeData.color || '#7aa2f7';
  const renameGroup = useAppStore((s) => s.renameGroup);
  const resizeGroup = useAppStore((s) => s.resizeGroup);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(nodeData.label);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setEditValue(nodeData.label);
    setEditing(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [nodeData.label]);

  const handleBlur = useCallback(() => {
    setEditing(false);
    if (editValue.trim()) {
      renameGroup(id, editValue.trim());
    }
  }, [editValue, id, renameGroup]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleBlur();
    } else if (e.key === 'Escape') {
      setEditing(false);
      setEditValue(nodeData.label);
    }
  }, [handleBlur, nodeData.label]);

  const handleResizeEnd = useCallback<OnResizeEnd>((_event, params) => {
    resizeGroup(id, params.width);
  }, [id, resizeGroup]);

  return (
    <div
      className="w-full h-full rounded-full pointer-events-auto"
      style={{ backgroundColor: hexToRgba(color, 0.08), border: `2px solid ${color}` }}
    >
      <NodeResizer
        color={color}
        isVisible={selected}
        keepAspectRatio
        minWidth={120}
        minHeight={120}
        onResizeEnd={handleResizeEnd}
      />
      {/* Label pill at the top of the circle */}
      <div
        className="absolute left-1/2 -translate-x-1/2 -top-3 px-2.5 py-0.5 rounded-full cursor-text whitespace-nowrap"
        style={{ backgroundColor: color }}
        onDoubleClick={handleDoubleClick}
      >
        {editing ? (
          <input
            ref={inputRef}
            className="bg-transparent border-none text-white text-[11px] font-semibold uppercase tracking-wide outline-none"
            style={{ width: `${Math.max(editValue.length, 4)}ch` }}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            onMouseDown={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="text-[11px] font-semibold text-white uppercase tracking-wide">{nodeData.label}</span>
        )}
      </div>
    </div>
  );
});
