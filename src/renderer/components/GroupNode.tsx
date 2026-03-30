import { memo, useState, useRef, useCallback } from 'react';
import type { NodeProps } from '@xyflow/react';
import { useAppStore, type GroupNodeData } from '../store';

export const GroupNode = memo(function GroupNode({ data, id }: NodeProps) {
  const nodeData = data as GroupNodeData;
  const renameGroup = useAppStore((s) => s.renameGroup);
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

  return (
    <div className="w-full h-full bg-accent-subtle border-2 border-dashed border-accent-border rounded-2xl pointer-events-auto">
      <div className="py-1.5 px-3 cursor-text" onDoubleClick={handleDoubleClick}>
        {editing ? (
          <input
            ref={inputRef}
            className="bg-transparent border-none border-b border-b-accent text-accent text-xs font-semibold uppercase tracking-wide outline-none w-full"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
          />
        ) : (
          <span className="text-xs font-semibold text-accent uppercase tracking-wide">{nodeData.label}</span>
        )}
      </div>
    </div>
  );
});
