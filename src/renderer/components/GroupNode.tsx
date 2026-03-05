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
    <div className="group-node">
      <div className="group-node__header" onDoubleClick={handleDoubleClick}>
        {editing ? (
          <input
            ref={inputRef}
            className="group-node__input"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
          />
        ) : (
          <span className="group-node__label">{nodeData.label}</span>
        )}
      </div>
    </div>
  );
});
