import { memo, useState, useRef, useCallback, type CSSProperties } from 'react';
import { NodeResizer, type NodeProps, type OnResizeEnd } from '@xyflow/react';
import { useAppStore, type GroupNodeData } from '../store';

export const GroupNode = memo(function GroupNode({ data, id, selected }: NodeProps) {
  const nodeData = data as GroupNodeData;
  const color = nodeData.color || '#7aa2f7';
  const groupStyle: CSSProperties & { '--group-color': string } = { '--group-color': color };
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
      className="graph-group w-full h-full rounded-full pointer-events-auto"
      style={groupStyle}
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
        className="graph-group__label absolute left-1/2 -translate-x-1/2 -top-3 flex items-center gap-2 px-2.5 py-1 rounded-full cursor-text whitespace-nowrap"
        onDoubleClick={handleDoubleClick}
      >
        {editing ? (
          <input
            ref={inputRef}
            className="bg-transparent border-none text-fg text-[10px] font-medium tracking-wide outline-none"
            style={{ width: `${Math.max(editValue.length, 4)}ch` }}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            onMouseDown={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="text-[10px] font-medium tracking-wide">{nodeData.label}</span>
        )}
      </div>
    </div>
  );
});
