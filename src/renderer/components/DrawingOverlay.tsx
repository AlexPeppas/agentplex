import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store';
import type { DrawingElement, DrawingData } from '../../shared/ipc-channels';

const ERASER_WIDTH = 20;
const PEN_WIDTH = 2;
const SHAPE_STROKE = 2;
const TEXT_FONT_SIZE = 16;

let idCounter = 0;
function nextId(): string {
  return `el_${Date.now()}_${idCounter++}`;
}

export function DrawingOverlay() {
  const drawingMode = useAppStore((s) => s.drawingMode);
  const drawTool = useAppStore((s) => s.drawTool);
  const drawColor = useAppStore((s) => s.drawColor);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [elements, setElements] = useState<DrawingElement[]>([]);
  const [undoStack, setUndoStack] = useState<DrawingElement[][]>([]);
  const [redoStack, setRedoStack] = useState<DrawingElement[][]>([]);
  const drawingRef = useRef(false);
  const currentElementRef = useRef<DrawingElement | null>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadedRef = useRef(false);

  // Text editing state
  const [textInput, setTextInput] = useState<{ x: number; y: number; color: string } | null>(null);
  const [textValue, setTextValue] = useState('');
  const textRef = useRef<HTMLInputElement>(null);

  // Expose imperative handles to the store
  useEffect(() => {
    useAppStore.setState({
      _drawUndo: () => {
        setUndoStack((prev) => {
          if (prev.length === 0) return prev;
          const last = prev[prev.length - 1];
          setRedoStack((r) => [...r, elements]);
          setElements(last);
          return prev.slice(0, -1);
        });
      },
      _drawRedo: () => {
        setRedoStack((prev) => {
          if (prev.length === 0) return prev;
          const last = prev[prev.length - 1];
          setUndoStack((u) => [...u, elements]);
          setElements(last);
          return prev.slice(0, -1);
        });
      },
      _drawClear: () => {
        if (elements.length === 0) return;
        setUndoStack((prev) => [...prev, elements]);
        setRedoStack([]);
        setElements([]);
      },
      _drawCanUndo: undoStack.length > 0,
      _drawCanRedo: redoStack.length > 0,
      _drawHasElements: elements.length > 0,
    });
  }, [elements, undoStack, redoStack]);

  // ── Load ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    window.agentPlex.canvasLoad().then((data: DrawingData) => {
      if (data.elements.length > 0) setElements(data.elements);
      loadedRef.current = true;
    });
  }, []);

  // ── Save (debounced) ─────────────────────────────────────────────────────
  const scheduleSave = useCallback((els: DrawingElement[]) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      window.agentPlex.canvasSave({ elements: els, version: 1 });
    }, 500);
  }, []);

  useEffect(() => {
    if (loadedRef.current) scheduleSave(elements);
  }, [elements, scheduleSave]);

  // ── Render ───────────────────────────────────────────────────────────────
  const render = useCallback((els: DrawingElement[], inProgress?: DrawingElement | null) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const allEls = inProgress ? [...els, inProgress] : els;

    for (const el of allEls) {
      ctx.save();

      if (el.type === 'stroke' || el.type === 'eraser') {
        if (!el.points || el.points.length === 0) { ctx.restore(); continue; }
        if (el.type === 'eraser') {
          ctx.globalCompositeOperation = 'destination-out';
        } else {
          ctx.strokeStyle = el.color;
        }
        ctx.lineWidth = el.strokeWidth;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(el.points[0][0], el.points[0][1]);
        for (let i = 1; i < el.points.length; i++) {
          ctx.lineTo(el.points[i][0], el.points[i][1]);
        }
        ctx.stroke();
      } else if (el.type === 'rect') {
        ctx.strokeStyle = el.color;
        ctx.lineWidth = el.strokeWidth;
        ctx.strokeRect(el.x!, el.y!, el.w!, el.h!);
      } else if (el.type === 'text') {
        if (el.text) {
          ctx.fillStyle = el.color;
          ctx.font = `${el.fontSize || TEXT_FONT_SIZE}px MesloLGS Nerd Font Mono, Menlo, Monaco, Consolas, monospace`;
          ctx.textBaseline = 'top';
          ctx.fillText(el.text, el.x!, el.y!);
        }
      }

      ctx.restore();
    }
  }, []);

  useEffect(() => { render(elements); }, [elements, render]);

  // ── Resize ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        const dpr = window.devicePixelRatio || 1;
        canvas.width = width * dpr;
        canvas.height = height * dpr;
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        const ctx = canvas.getContext('2d');
        if (ctx) ctx.scale(dpr, dpr);
        render(elements);
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [render, elements]);

  // ── Coordinates ──────────────────────────────────────────────────────────
  const getPos = useCallback((e: React.PointerEvent): [number, number] => {
    const canvas = canvasRef.current;
    if (!canvas) return [0, 0];
    const rect = canvas.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  }, []);

  // ── Commit text input ────────────────────────────────────────────────────
  const commitText = useCallback(() => {
    if (!textInput) return;
    const val = textValue.trim();
    if (val) {
      setUndoStack((prev) => [...prev.slice(-50), elements]);
      setRedoStack([]);
      const el: DrawingElement = {
        id: nextId(), type: 'text',
        x: textInput.x, y: textInput.y,
        text: val, fontSize: TEXT_FONT_SIZE,
        color: textInput.color, strokeWidth: 0,
      };
      setElements((prev) => [...prev, el]);
    }
    setTextInput(null);
    setTextValue('');
  }, [textInput, textValue, elements]);

  // ── Pointer handlers ─────────────────────────────────────────────────────
  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    // If text input is open, commit it first
    if (textInput) {
      commitText();
      return;
    }

    const [x, y] = getPos(e);

    if (drawTool === 'text') {
      setTextInput({ x, y, color: drawColor });
      setTextValue('');
      return;
    }

    drawingRef.current = true;
    (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);

    setUndoStack((prev) => [...prev.slice(-50), elements]);
    setRedoStack([]);

    if (drawTool === 'pen') {
      currentElementRef.current = {
        id: nextId(), type: 'stroke', points: [[x, y]],
        color: drawColor, strokeWidth: PEN_WIDTH,
      };
    } else if (drawTool === 'eraser') {
      currentElementRef.current = {
        id: nextId(), type: 'eraser', points: [[x, y]],
        color: '#000', strokeWidth: ERASER_WIDTH,
      };
    } else if (drawTool === 'rect') {
      dragStartRef.current = { x, y };
      currentElementRef.current = {
        id: nextId(), type: 'rect', x, y, w: 0, h: 0,
        color: drawColor, strokeWidth: SHAPE_STROKE,
      };
    }
  }, [drawTool, drawColor, getPos, elements, textInput, commitText]);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current || !currentElementRef.current) return;
    const [x, y] = getPos(e);
    const el = currentElementRef.current;

    if (el.type === 'stroke' || el.type === 'eraser') {
      el.points!.push([x, y]);
    } else if (el.type === 'rect') {
      const start = dragStartRef.current!;
      el.x = Math.min(start.x, x);
      el.y = Math.min(start.y, y);
      el.w = Math.abs(x - start.x);
      el.h = Math.abs(y - start.y);
    }

    render(elements, currentElementRef.current);
  }, [elements, getPos, render]);

  const handlePointerUp = useCallback(() => {
    if (!drawingRef.current || !currentElementRef.current) return;
    drawingRef.current = false;
    const el = currentElementRef.current;
    currentElementRef.current = null;
    dragStartRef.current = null;

    if (el.type === 'stroke' || el.type === 'eraser') {
      if (!el.points || el.points.length < 2) return;
    } else if (el.type === 'rect') {
      if (!el.w || !el.h || (el.w < 3 && el.h < 3)) return;
    }

    setElements((prev) => [...prev, el]);
  }, []);

  // Focus the text input when it appears
  useEffect(() => {
    if (textInput) {
      requestAnimationFrame(() => textRef.current?.focus());
    }
  }, [textInput]);

  // ── Keyboard: Ctrl+Z, Ctrl+Y, Esc ───────────────────────────────────────
  useEffect(() => {
    if (!drawingMode) return;
    const handler = (e: KeyboardEvent) => {
      // Don't intercept when typing in the text input
      if (textInput && (e.target as HTMLElement)?.tagName === 'INPUT') return;

      if (e.key === 'Escape') {
        e.preventDefault();
        if (textInput) {
          commitText();
        } else {
          useAppStore.getState().toggleDrawingMode();
        }
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      if (e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        useAppStore.getState()._drawUndo?.();
      } else if (e.key === 'y' || (e.key === 'z' && e.shiftKey)) {
        e.preventDefault();
        useAppStore.getState()._drawRedo?.();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [drawingMode, textInput, commitText]);

  const cursor = drawingMode
    ? drawTool === 'eraser' ? 'cell'
    : drawTool === 'text' ? 'text'
    : 'crosshair'
    : 'default';

  return (
    <div
      ref={containerRef}
      className="absolute inset-0"
      style={{ pointerEvents: drawingMode ? 'auto' : 'none', zIndex: 10 }}
    >
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full touch-none"
        style={{ pointerEvents: drawingMode ? 'auto' : 'none', cursor }}
        onPointerDown={drawingMode ? handlePointerDown : undefined}
        onPointerMove={drawingMode ? handlePointerMove : undefined}
        onPointerUp={drawingMode ? handlePointerUp : undefined}
        onPointerLeave={drawingMode ? handlePointerUp : undefined}
      />

      {/* Inline text input */}
      {textInput && (
        <input
          ref={textRef}
          className="absolute bg-transparent border-none outline-none text-fg caret-accent"
          style={{
            left: textInput.x,
            top: textInput.y,
            color: textInput.color,
            fontSize: TEXT_FONT_SIZE,
            fontFamily: 'MesloLGS Nerd Font Mono, Menlo, Monaco, Consolas, monospace',
            minWidth: 40,
            zIndex: 20,
            pointerEvents: 'auto',
          }}
          value={textValue}
          onChange={(e) => setTextValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commitText();
            }
            e.stopPropagation();
          }}
          onBlur={commitText}
        />
      )}
    </div>
  );
}
