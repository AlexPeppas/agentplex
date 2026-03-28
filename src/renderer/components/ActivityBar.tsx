import { useCallback, useEffect, useRef, useState } from 'react';
import { FolderOpen, Search, Pencil, Eraser, Square, Type, Undo2, Redo2, Trash2, Palette, Sun, Moon } from 'lucide-react';
import { useAppStore, type PanelId } from '../store';

const PANELS: { id: PanelId; icon: typeof FolderOpen }[] = [
  { id: 'explorer', icon: FolderOpen },
  { id: 'search', icon: Search },
];

const PRESET_COLORS = [
  '#ece4d8', '#d18a7a', '#e8c070', '#a8c878', '#70b8e0',
  '#c490e0', '#e07070', '#f0a060', '#9a8a70', '#3e3830',
];

function getInitialTheme(): 'dark' | 'light' {
  const saved = localStorage.getItem('agentplex-theme');
  if (saved === 'dark' || saved === 'light') return saved;
  return 'dark';
}

export function ActivityBar() {
  const activePanelId = useAppStore((s) => s.activePanelId);
  const togglePanel = useAppStore((s) => s.togglePanel);
  const drawingMode = useAppStore((s) => s.drawingMode);
  const toggleDrawingMode = useAppStore((s) => s.toggleDrawingMode);
  const drawTool = useAppStore((s) => s.drawTool);
  const setDrawTool = useAppStore((s) => s.setDrawTool);
  const drawColor = useAppStore((s) => s.drawColor);
  const setDrawColor = useAppStore((s) => s.setDrawColor);
  const canUndo = useAppStore((s) => s._drawCanUndo);
  const canRedo = useAppStore((s) => s._drawCanRedo);
  const hasElements = useAppStore((s) => s._drawHasElements);
  const [theme, setTheme] = useState<'dark' | 'light'>(getInitialTheme);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const colorPickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('agentplex-theme', theme);
    window.agentPlex.setTheme(theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
  }, []);

  // Close color picker on outside click
  useEffect(() => {
    if (!showColorPicker) return;
    const handler = (e: MouseEvent) => {
      if (colorPickerRef.current && !colorPickerRef.current.contains(e.target as Node)) {
        setShowColorPicker(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showColorPicker]);

  const btnBase = 'w-9 h-9 flex items-center justify-center rounded-md cursor-pointer transition-colors duration-[120ms]';
  const btnInactive = 'text-fg-muted hover:bg-elevated hover:text-fg';
  const btnDisabled = 'text-fg-muted opacity-30 pointer-events-none';

  return (
    <div className="flex-none w-12 flex flex-col items-center pt-2 pb-2 gap-1 bg-inset border-r border-border">
      {/* Side panels */}
      {PANELS.map(({ id, icon: Icon }) => {
        const isActive = activePanelId === id;
        return (
          <button
            key={id}
            onClick={() => togglePanel(id)}
            className={`relative ${btnBase}
              ${isActive ? 'bg-elevated text-fg' : btnInactive}`}
            title={id.charAt(0).toUpperCase() + id.slice(1)}
          >
            {isActive && (
              <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 bg-accent rounded-r-sm" />
            )}
            <Icon size={20} />
          </button>
        );
      })}

      {/* Drawing mode toggle — expands into a horizontal toolbar when active */}
      <div className="relative">
        <button
          onClick={toggleDrawingMode}
          className={`relative ${btnBase}
            ${drawingMode ? 'bg-accent-subtle text-accent' : btnInactive}`}
          title={drawingMode ? 'Exit drawing mode (Esc)' : 'Draw on canvas'}
        >
          {drawingMode && (
            <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 bg-accent rounded-r-sm" />
          )}
          <Pencil size={20} />
        </button>

        {/* Expanded horizontal toolbar */}
        {drawingMode && (
          <div className="absolute left-[calc(100%+6px)] top-1/2 -translate-y-1/2 flex items-center gap-0.5 px-1.5 py-1 bg-elevated/95 backdrop-blur border border-border-strong rounded-lg shadow-[0_4px_16px_var(--shadow-heavy)] z-50 whitespace-nowrap">
            {/* Pen */}
            <button
              onClick={() => setDrawTool('pen')}
              className={`w-7 h-7 flex items-center justify-center rounded transition-colors ${
                drawTool === 'pen' ? 'bg-accent-subtle text-accent' : 'text-fg-muted hover:bg-surface hover:text-fg'
              }`}
              title="Pen"
            >
              <Pencil size={14} />
            </button>

            {/* Eraser */}
            <button
              onClick={() => setDrawTool('eraser')}
              className={`w-7 h-7 flex items-center justify-center rounded transition-colors ${
                drawTool === 'eraser' ? 'bg-accent-subtle text-accent' : 'text-fg-muted hover:bg-surface hover:text-fg'
              }`}
              title="Eraser"
            >
              <Eraser size={14} />
            </button>

            {/* Rectangle */}
            <button
              onClick={() => setDrawTool('rect')}
              className={`w-7 h-7 flex items-center justify-center rounded transition-colors ${
                drawTool === 'rect' ? 'bg-accent-subtle text-accent' : 'text-fg-muted hover:bg-surface hover:text-fg'
              }`}
              title="Rectangle"
            >
              <Square size={14} />
            </button>

            {/* Text */}
            <button
              onClick={() => setDrawTool('text')}
              className={`w-7 h-7 flex items-center justify-center rounded transition-colors ${
                drawTool === 'text' ? 'bg-accent-subtle text-accent' : 'text-fg-muted hover:bg-surface hover:text-fg'
              }`}
              title="Text"
            >
              <Type size={14} />
            </button>

            <div className="w-px h-4 bg-border mx-0.5" />

            {/* Color */}
            <div className="relative" ref={colorPickerRef}>
              <button
                onClick={() => setShowColorPicker((v) => !v)}
                className="w-7 h-7 flex items-center justify-center rounded text-fg-muted hover:bg-surface hover:text-fg transition-colors"
                title="Color"
              >
                <div className="relative">
                  <Palette size={14} />
                  <span
                    className="absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full border border-border"
                    style={{ backgroundColor: drawColor }}
                  />
                </div>
              </button>
              {showColorPicker && (
                <div className="absolute top-full left-0 mt-1.5 p-2 bg-elevated border border-border-strong rounded-lg shadow-[0_4px_16px_var(--shadow-heavy)] z-[60]">
                  <div className="grid grid-cols-5 gap-1.5 mb-2">
                    {PRESET_COLORS.map((c) => (
                      <button
                        key={c}
                        onClick={() => { setDrawColor(c); setShowColorPicker(false); }}
                        className={`w-5 h-5 rounded-full border-2 transition-transform hover:scale-110 ${
                          drawColor === c ? 'border-accent scale-110' : 'border-transparent'
                        }`}
                        style={{ backgroundColor: c }}
                      />
                    ))}
                  </div>
                  <input
                    type="color"
                    value={drawColor}
                    onChange={(e) => setDrawColor(e.target.value)}
                    className="w-full h-5 rounded cursor-pointer border-none bg-transparent"
                  />
                </div>
              )}
            </div>

            <div className="w-px h-4 bg-border mx-0.5" />

            {/* Undo */}
            <button
              onClick={() => useAppStore.getState()._drawUndo?.()}
              className={`w-7 h-7 flex items-center justify-center rounded transition-colors ${canUndo ? 'text-fg-muted hover:bg-surface hover:text-fg' : btnDisabled}`}
              title="Undo (Ctrl+Z)"
            >
              <Undo2 size={14} />
            </button>

            {/* Redo */}
            <button
              onClick={() => useAppStore.getState()._drawRedo?.()}
              className={`w-7 h-7 flex items-center justify-center rounded transition-colors ${canRedo ? 'text-fg-muted hover:bg-surface hover:text-fg' : btnDisabled}`}
              title="Redo (Ctrl+Y)"
            >
              <Redo2 size={14} />
            </button>

            <div className="w-px h-4 bg-border mx-0.5" />

            {/* Clear */}
            <button
              onClick={() => useAppStore.getState()._drawClear?.()}
              className={`w-7 h-7 flex items-center justify-center rounded transition-colors ${hasElements ? 'text-fg-muted hover:bg-surface hover:text-fg' : btnDisabled}`}
              title="Clear all"
            >
              <Trash2 size={14} />
            </button>
          </div>
        )}
      </div>

      <div className="mt-auto">
        <button
          onClick={toggleTheme}
          className={`${btnBase} ${btnInactive}`}
          title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
        >
          {theme === 'dark' ? <Sun size={20} /> : <Moon size={20} />}
        </button>
      </div>
    </div>
  );
}
