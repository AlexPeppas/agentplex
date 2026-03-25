# Dynamic Shell Detection & Selection — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-detect installed PowerShell variants at startup, show them as labeled menu items, and let users set a default shell via settings.

**Architecture:** New `shell-detector.ts` scans for shells and queries versions at startup. New `settings-manager.ts` manages `~/.agentplex/settings.json`. Dynamic shell list is served to the renderer via IPC, replacing the static `SHELL_TOOLS` array. Toolbar renders detected shells with right-click "Set as default" context menu.

**Tech Stack:** Electron 33, TypeScript, React, Zustand, node-pty, xterm.js

**Spec:** `docs/superpowers/specs/2026-03-25-dynamic-shell-detection-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/main/shell-detector.ts` | Create | Detect installed shells, query versions, cache results |
| `src/main/settings-manager.ts` | Create | Read/write `~/.agentplex/settings.json` |
| `src/shared/ipc-channels.ts` | Modify | Add `DetectedShell` type, new IPC channels, remove `SHELL_TOOLS` |
| `src/main/main.ts` | Modify | Call `detectShells()` at startup |
| `src/main/ipc-handlers.ts` | Modify | Add shell list + default shell IPC handlers, update validation |
| `src/preload/preload.ts` | Modify | Expose `getShells`, `getDefaultShell`, `setDefaultShell` |
| `src/renderer/types.ts` | Modify | Add new API methods to `AgentPlexAPI` |
| `src/main/session-manager.ts` | Modify | Use detected shell paths + default shell |
| `src/renderer/components/Toolbar.tsx` | Modify | Dynamic shell menu, default indicator, right-click context menu |

---

## Chunk 1: Shared Types & IPC Channels

### Task 1: Add DetectedShell type and new IPC channels

**Files:**
- Modify: `src/shared/ipc-channels.ts`

- [ ] **Step 1: Add DetectedShell interface**

Add after the existing type/interface exports at the top of the file:

```typescript
export interface DetectedShell {
  id: string;
  label: string;
  path: string;
  type: 'powershell' | 'bash';
}
```

- [ ] **Step 2: Add new IPC channel constants**

Add these entries to the `IPC` const object:

```typescript
  SHELL_LIST: 'shell:list',
  SETTINGS_GET_DEFAULT_SHELL: 'settings:getDefaultShell',
  SETTINGS_SET_DEFAULT_SHELL: 'settings:setDefaultShell',
```

- [ ] **Step 3: Remove SHELL_TOOLS and update CliTool**

Remove the `SHELL_TOOLS` export entirely (lines 9-12):

```typescript
// DELETE this:
export const SHELL_TOOLS: { id: CliTool; label: string; command: string }[] = [
  { id: 'powershell', label: 'PowerShell', command: '' },
  { id: 'bash', label: 'Bash', command: '' },
];
```

Update the `CliTool` type to accept dynamic shell IDs:

```typescript
export type CliTool = 'claude' | 'codex' | 'copilot' | 'claude-resume' | (string & {});
```

The `(string & {})` pattern preserves autocomplete for known values while accepting any string.

- [ ] **Step 4: Verify the file compiles**

Run: `npx tsc --noEmit`

Note: This will show errors in files that still import `SHELL_TOOLS` — that's expected and will be fixed in later tasks.

- [ ] **Step 5: Commit**

```bash
git add src/shared/ipc-channels.ts
git commit -m "feat: add DetectedShell type, new IPC channels, remove SHELL_TOOLS"
```

---

## Chunk 2: Shell Detector

### Task 2: Create shell-detector.ts

**Files:**
- Create: `src/main/shell-detector.ts`

- [ ] **Step 1: Create the shell detector module**

```typescript
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { DetectedShell } from '../shared/ipc-channels';

let cachedShells: DetectedShell[] | null = null;

const VERSION_TIMEOUT_MS = 2000;

function execAsync(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = execFile(cmd, args, { timeout: VERSION_TIMEOUT_MS }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

async function getVersion(exe: string, args: string[]): Promise<string | null> {
  try {
    return await execAsync(exe, args);
  } catch {
    return null;
  }
}

function parsePwshVersion(output: string): string {
  // "PowerShell 7.5.1" → "7.5.1"
  const match = output.match(/(\d+\.\d+\.\d+)/);
  return match ? match[1] : '';
}

async function detectWindows(): Promise<DetectedShell[]> {
  const shells: DetectedShell[] = [];

  // Detect pwsh.exe (PowerShell 7+)
  let pwshPath: string | null = null;
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'pwsh.exe'),
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  ];
  for (const candidate of candidates) {
    if (fileExists(candidate)) {
      pwshPath = candidate;
      break;
    }
  }
  // Fallback: check PATH via where.exe
  if (!pwshPath) {
    try {
      const wherePath = (await execAsync('where.exe', ['pwsh.exe'])).split('\n')[0].trim();
      if (wherePath && fileExists(wherePath)) {
        pwshPath = wherePath;
      }
    } catch { /* not found */ }
  }

  // Detect powershell.exe (always present on Windows)
  const powershellPath = 'powershell.exe';

  // Detect Git Bash
  const gitBashPath = 'C:\\Program Files\\Git\\bin\\bash.exe';

  // Query versions in parallel
  const [pwshVersionRaw, psVersionRaw] = await Promise.all([
    pwshPath ? getVersion(pwshPath, ['--version']) : Promise.resolve(null),
    getVersion(powershellPath, ['-Command', '$PSVersionTable.PSVersion.ToString()']),
  ]);

  if (pwshPath) {
    const ver = pwshVersionRaw ? parsePwshVersion(pwshVersionRaw) : '';
    shells.push({
      id: 'pwsh',
      label: ver ? `PowerShell ${ver}` : 'PowerShell 7',
      path: pwshPath,
      type: 'powershell',
    });
  }

  if (psVersionRaw) {
    shells.push({
      id: 'powershell',
      label: psVersionRaw ? `Windows PowerShell ${psVersionRaw}` : 'Windows PowerShell',
      path: powershellPath,
      type: 'powershell',
    });
  } else {
    // powershell.exe should always exist on Windows, add it anyway
    shells.push({
      id: 'powershell',
      label: 'Windows PowerShell',
      path: powershellPath,
      type: 'powershell',
    });
  }

  if (fileExists(gitBashPath)) {
    shells.push({
      id: 'gitbash',
      label: 'Bash',
      path: gitBashPath,
      type: 'bash',
    });
  }

  return shells;
}

async function detectUnix(): Promise<DetectedShell[]> {
  const shells: DetectedShell[] = [];

  // Detect pwsh (PowerShell 7 on macOS/Linux)
  try {
    const pwshPath = (await execAsync('which', ['pwsh'])).trim();
    if (pwshPath) {
      const versionRaw = await getVersion(pwshPath, ['--version']);
      const ver = versionRaw ? parsePwshVersion(versionRaw) : '';
      shells.push({
        id: 'pwsh',
        label: ver ? `PowerShell ${ver}` : 'PowerShell 7',
        path: pwshPath,
        type: 'powershell',
      });
    }
  } catch { /* not found */ }

  // Bash uses hardcoded path per requirements
  shells.push({
    id: 'bash',
    label: 'Bash',
    path: 'bash',
    type: 'bash',
  });

  return shells;
}

export async function detectShells(): Promise<DetectedShell[]> {
  if (cachedShells) return cachedShells;

  const shells = process.platform === 'win32'
    ? await detectWindows()
    : await detectUnix();

  cachedShells = shells;
  return shells;
}

export function getCachedShells(): DetectedShell[] {
  return cachedShells || [];
}

export function getShellById(id: string): DetectedShell | undefined {
  return (cachedShells || []).find((s) => s.id === id);
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add src/main/shell-detector.ts
git commit -m "feat: add shell-detector module for auto-detecting installed shells"
```

---

## Chunk 3: Settings Manager

### Task 3: Create settings-manager.ts

**Files:**
- Create: `src/main/settings-manager.ts`

- [ ] **Step 1: Create the settings manager module**

```typescript
import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';

const SETTINGS_PATH = path.join(homedir(), '.agentplex', 'settings.json');

interface AppSettings {
  defaultShell?: string;
}

let cached: AppSettings | null = null;

export function loadSettings(): AppSettings {
  if (cached) return cached;
  try {
    cached = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
    return cached!;
  } catch {
    cached = {};
    return cached;
  }
}

function saveSettings(settings: AppSettings): void {
  cached = settings;
  try {
    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  } catch (err: any) {
    console.error('[settings] Failed to save:', err.message);
  }
}

export function getDefaultShellId(): string | undefined {
  return loadSettings().defaultShell;
}

export function setDefaultShellId(id: string): void {
  const settings = loadSettings();
  settings.defaultShell = id;
  saveSettings(settings);
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add src/main/settings-manager.ts
git commit -m "feat: add settings-manager for ~/.agentplex/settings.json"
```

---

## Chunk 4: Wire Up Main Process

### Task 4: Call detectShells at startup

**Files:**
- Modify: `src/main/main.ts`

- [ ] **Step 1: Import and call detectShells**

Add import at the top of `main.ts`:

```typescript
import { detectShells } from './shell-detector';
```

In the `app.whenReady().then(...)` block (line 97), call `detectShells()` before `registerIpcHandlers()`:

```typescript
app.whenReady().then(async () => {
  // ... CSP code stays the same ...

  // Fire detection early — don't await, so window creation isn't blocked.
  // Detection completes well before the user opens the shell menu.
  detectShells();
  registerIpcHandlers();
  sessionManager.start();
  createWindow();

  // ... rest stays the same ...
});
```

Note: The `.then()` callback becomes `async`. We fire `detectShells()` early but don't block window creation — the renderer won't request the shell list until the user opens the menu, by which time detection is long finished. If you prefer guaranteed ordering, `await` it before `registerIpcHandlers()`.

- [ ] **Step 2: Commit**

```bash
git add src/main/main.ts
git commit -m "feat: call detectShells at app startup"
```

### Task 5: Add IPC handlers for shell list and default shell

**Files:**
- Modify: `src/main/ipc-handlers.ts`

- [ ] **Step 1: Update imports and validation**

Replace the imports at the top:

```typescript
import { ipcMain, dialog, BrowserWindow } from 'electron';
import { IPC, CLI_TOOLS, RESUME_TOOL, type CliTool } from '../shared/ipc-channels';
import { sessionManager } from './session-manager';
import { getCachedShells } from './shell-detector';
import { getDefaultShellId, setDefaultShellId } from './settings-manager';
```

Replace `VALID_CLI_IDS` (lines 5-9):

```typescript
const VALID_CLI_IDS = new Set<string>([
  ...CLI_TOOLS.map((t) => t.id),
  RESUME_TOOL.id,
]);

function isValidCli(id: string): boolean {
  return VALID_CLI_IDS.has(id) || getCachedShells().some((s) => s.id === id);
}
```

Update the `SESSION_CREATE` handler to use `isValidCli`:

```typescript
ipcMain.handle(IPC.SESSION_CREATE, (_event, { cwd, cli }: { cwd?: string; cli?: string } = {}) => {
  const safeCli: CliTool = (cli && isValidCli(cli) ? cli : 'claude') as CliTool;
  return sessionManager.create(cwd, safeCli);
});
```

- [ ] **Step 2: Add new IPC handlers**

Add these inside `registerIpcHandlers()`, after the existing handlers:

```typescript
  ipcMain.handle(IPC.SHELL_LIST, () => {
    return getCachedShells();
  });

  ipcMain.handle(IPC.SETTINGS_GET_DEFAULT_SHELL, () => {
    return getDefaultShellId() || null;
  });

  ipcMain.handle(IPC.SETTINGS_SET_DEFAULT_SHELL, (_event, { id }: { id: string }) => {
    if (typeof id !== 'string') return;
    // Validate against detected shells
    if (!getCachedShells().some((s) => s.id === id)) return;
    setDefaultShellId(id);
  });
```

- [ ] **Step 3: Commit**

```bash
git add src/main/ipc-handlers.ts
git commit -m "feat: add IPC handlers for shell list and default shell settings"
```

### Task 6: Expose new APIs in preload and types

**Files:**
- Modify: `src/preload/preload.ts`
- Modify: `src/renderer/types.ts`

- [ ] **Step 1: Add to preload.ts**

Add the `DetectedShell` import:

```typescript
import { IPC, type CliTool, type DetectedShell, SessionInfo, SessionStatus, SubagentInfo, PlanInfo, TaskInfo, TaskUpdateInfo, TaskListInfo } from '../shared/ipc-channels';
```

Add these methods to the `api` object (before the closing `};`):

```typescript
  getShells: (): Promise<DetectedShell[]> => {
    return ipcRenderer.invoke(IPC.SHELL_LIST);
  },

  getDefaultShell: (): Promise<string | null> => {
    return ipcRenderer.invoke(IPC.SETTINGS_GET_DEFAULT_SHELL);
  },

  setDefaultShell: (id: string): Promise<void> => {
    return ipcRenderer.invoke(IPC.SETTINGS_SET_DEFAULT_SHELL, { id });
  },
```

- [ ] **Step 2: Update types.ts**

Add the `DetectedShell` import:

```typescript
import type { CliTool, DetectedShell, SessionInfo, SessionStatus, SubagentInfo, PlanInfo, TaskInfo, TaskUpdateInfo, TaskListInfo } from '../shared/ipc-channels';
```

Add to the `AgentPlexAPI` interface:

```typescript
  getShells: () => Promise<DetectedShell[]>;
  getDefaultShell: () => Promise<string | null>;
  setDefaultShell: (id: string) => Promise<void>;
```

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add src/preload/preload.ts src/renderer/types.ts
git commit -m "feat: expose shell detection and default shell APIs to renderer"
```

---

## Chunk 5: Session Manager Changes

### Task 7: Update session-manager to use detected shells

**Files:**
- Modify: `src/main/session-manager.ts`

- [ ] **Step 1: Add imports**

Add these imports at the top of `session-manager.ts`:

```typescript
import { getShellById, getCachedShells } from './shell-detector';
import { getDefaultShellId } from './settings-manager';
```

- [ ] **Step 2: Add helper to resolve shell path**

Add this helper function after the existing `getSafeEnv()` function:

```typescript
/** Resolve the executable path for a shell, with fallback logic. */
function resolveShellPath(shellId?: string): string {
  // Try the requested shell ID first
  if (shellId) {
    const detected = getShellById(shellId);
    if (detected) return detected.path;
  }

  // Try the default shell from settings
  const defaultId = getDefaultShellId();
  if (defaultId) {
    const detected = getShellById(defaultId);
    if (detected) return detected.path;
  }

  // Fallback: first available PowerShell on Windows, bash on Unix
  if (process.platform === 'win32') {
    const shells = getCachedShells();
    const ps = shells.find((s) => s.type === 'powershell');
    return ps ? ps.path : 'powershell.exe';
  }
  return 'bash';
}
```

- [ ] **Step 3: Update the create() method**

Remove the `SHELL_TOOLS` import from line 7. The import line becomes:

```typescript
import { SessionStatus, SessionInfo, IPC, CLI_TOOLS, RESUME_TOOL, type CliTool } from '../shared/ipc-channels';
```

Replace the shell resolution block in `create()` (lines 308-316):

Old code:
```typescript
    const isRawShell = cli === 'powershell' || cli === 'bash';
    const allTools = [...CLI_TOOLS, RESUME_TOOL, ...SHELL_TOOLS];
    const toolDef = allTools.find((t) => t.id === cli) || CLI_TOOLS[0];
    const title = `Session ${sessionCounter} — ${dirName}`;

    const shell = cli === 'bash'
      ? (process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash')
      : cli === 'powershell' ? 'powershell.exe'
      : process.platform === 'win32' ? 'powershell.exe' : 'bash';
```

New code:
```typescript
    const detectedShell = getShellById(cli);
    const isRawShell = !!detectedShell;
    const allTools = [...CLI_TOOLS, RESUME_TOOL];
    const toolDef = allTools.find((t) => t.id === cli) || CLI_TOOLS[0];
    const title = `Session ${sessionCounter} — ${dirName}`;

    const shell = detectedShell
      ? detectedShell.path
      : resolveShellPath();
```

Note: Use `detectedShell` directly in the ternary (not `isRawShell`) so TypeScript narrows the type and knows `.path` is safe.

- [ ] **Step 4: Update the createWithUuid() method**

Replace the hardcoded shell line in `createWithUuid()` (line 180):

Old code:
```typescript
    const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash';
```

New code:
```typescript
    const shell = resolveShellPath();
```

- [ ] **Step 5: Verify it compiles**

Run: `npx tsc --noEmit`

- [ ] **Step 6: Commit**

```bash
git add src/main/session-manager.ts
git commit -m "feat: use detected shell paths and default shell in session manager"
```

---

## Chunk 6: Dynamic Toolbar UI

### Task 8: Update Toolbar to show detected shells with default indicator and context menu

**Files:**
- Modify: `src/renderer/components/Toolbar.tsx`

- [ ] **Step 1: Replace SHELL_TOOLS import and add state for detected shells**

Replace the imports at the top:

```typescript
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store';
import { CLI_TOOLS, RESUME_TOOL, type CliTool, type DetectedShell } from '../../shared/ipc-channels';
import logoSvg from '../../../assets/logo.svg';
```

Inside the `Toolbar` component, add state for detected shells and default shell. Place these after the existing `useState` calls:

```typescript
  const [shells, setShells] = useState<DetectedShell[]>([]);
  const [defaultShellId, setDefaultShellId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; shellId: string } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
```

- [ ] **Step 2: Fetch shells and default on mount**

Add this `useEffect` after the existing theme effect:

```typescript
  useEffect(() => {
    window.agentPlex.getShells().then(setShells);
    window.agentPlex.getDefaultShell().then(setDefaultShellId);
  }, []);
```

- [ ] **Step 3: Add context menu handlers**

Add these handlers after the existing `handleResume`:

```typescript
  const handleShellContextMenu = useCallback((e: React.MouseEvent, shellId: string) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, shellId });
  }, []);

  const handleSetDefault = useCallback(async (shellId: string) => {
    await window.agentPlex.setDefaultShell(shellId);
    setDefaultShellId(shellId);
    setContextMenu(null);
  }, []);
```

Add a `useEffect` to close the context menu on outside click:

```typescript
  useEffect(() => {
    if (!contextMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [contextMenu]);
```

- [ ] **Step 4: Update the Shell section in JSX**

Replace the Shell section in the menu (lines 114-128):

Old code:
```tsx
            <div className="toolbar__menu-divider" />
            <div className="toolbar__menu-section">
              <span className="toolbar__menu-label">Shell</span>
              <div className="toolbar__menu-row">
                {SHELL_TOOLS.map((tool) => (
                  <button
                    key={tool.id}
                    className="toolbar__menu-pill"
                    onClick={() => handlePick(tool.id)}
                  >
                    {tool.label}
                  </button>
                ))}
              </div>
            </div>
```

New code:
```tsx
            {shells.length > 0 && (
              <>
                <div className="toolbar__menu-divider" />
                <div className="toolbar__menu-section">
                  <span className="toolbar__menu-label">Shell</span>
                  <div className="toolbar__menu-row">
                    {shells.map((shell) => (
                      <button
                        key={shell.id}
                        className="toolbar__menu-pill"
                        onClick={() => handlePick(shell.id as CliTool)}
                        onContextMenu={(e) => handleShellContextMenu(e, shell.id)}
                        title={`Left-click to launch, right-click to set as default`}
                      >
                        {shell.id === defaultShellId && (
                          <span className="toolbar__default-indicator">{'\u2605'} </span>
                        )}
                        {shell.label}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}
```

- [ ] **Step 5: Add the context menu portal**

Add this right before the closing `</div>` of the toolbar (before `</div>` at the very end of the return):

```tsx
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="toolbar__context-menu"
          style={{ position: 'fixed', left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            className="toolbar__context-menu-item"
            onClick={() => handleSetDefault(contextMenu.shellId)}
          >
            Set as default
          </button>
        </div>
      )}
```

- [ ] **Step 6: Verify it compiles**

Run: `npx tsc --noEmit`

- [ ] **Step 7: Commit**

```bash
git add src/renderer/components/Toolbar.tsx
git commit -m "feat: dynamic shell menu with default indicator and right-click context menu"
```

### Task 9: Add CSS for context menu and default indicator

**Files:**
- Modify: `styles/index.css` (project root, not `src/renderer/`)

- [ ] **Step 1: Add context menu and indicator styles**

Add these styles after the existing `.toolbar__menu-divider` rule (around line 241 in `styles/index.css`):

```css
.toolbar__default-indicator {
  color: #f0c040;
}

.toolbar__context-menu {
  z-index: 1000;
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  padding: 4px 0;
  box-shadow: 0 8px 24px var(--shadow-heavy);
}

.toolbar__context-menu-item {
  display: block;
  width: 100%;
  padding: 8px 12px;
  background: none;
  border: none;
  border-radius: 6px;
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  text-align: left;
  white-space: nowrap;
  transition: background 0.12s;
}

.toolbar__context-menu-item:hover {
  background: var(--border);
}
```

- [ ] **Step 2: Commit**

```bash
git add styles/index.css
git commit -m "style: add context menu and default shell indicator styles"
```

---

## Chunk 7: Manual Testing & Final Verification

### Task 10: End-to-end manual testing

- [ ] **Step 1: Start the app**

Run: `npm start`

- [ ] **Step 2: Verify shell detection**

Click "+ New Session". Under the "Shell" section, verify:
- If PowerShell 7 is installed: you should see "PowerShell X.Y.Z" (with version) AND "Windows PowerShell X.Y.Z" as separate entries
- If only Windows PowerShell: you should see "Windows PowerShell X.Y.Z"
- Bash entry should still appear if Git Bash is installed

- [ ] **Step 3: Test launching each shell**

Click each shell entry, pick a directory, and verify the correct shell opens:
- "PowerShell X.Y.Z" should open `pwsh.exe` (check with `$PSVersionTable`)
- "Windows PowerShell X.Y.Z" should open `powershell.exe`
- "Bash" should open Git Bash

- [ ] **Step 4: Test setting default**

Right-click on a shell entry → "Set as default". Verify:
- Star indicator moves to the selected shell
- Close and reopen the menu — star should persist

- [ ] **Step 5: Test default shell is used for CLI tools**

Create a new "Claude" session. Verify the underlying shell is the one you set as default (check by typing `$PSVersionTable` in the terminal if it's a PowerShell variant).

- [ ] **Step 6: Test fallback behavior**

Edit `~/.agentplex/settings.json` to set `"defaultShell": "nonexistent"`. Restart the app and create a new session — it should fall back to the first available PowerShell.

- [ ] **Step 7: Final commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix: address issues found during manual testing"
```
