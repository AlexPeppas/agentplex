# Dynamic Shell Detection & Selection

## Problem

When users create a new shell session and select "PowerShell", AgentPlex always launches Windows PowerShell (`powershell.exe` / v5.1) instead of PowerShell 7 (`pwsh.exe`). Shell paths are hardcoded throughout `session-manager.ts` with no way to configure or select between installed shells. Restored sessions and CLI tool sessions also hardcode `powershell.exe`.

## Solution

Auto-detect installed shell executables at startup, present them as separate labeled menu items with exact version strings, and allow users to set a default shell persisted in `~/.agentplex/settings.json`.

## Architecture

### 1. Shell Detection (`src/main/shell-detector.ts`)

New module that runs once at app startup.

**Detection targets (Windows):**

| Shell | Executable | Detection method |
|-------|-----------|-----------------|
| PowerShell 7 (Store) | `pwsh.exe` | `where.exe pwsh.exe` or check `%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe` |
| PowerShell 7 (MSI) | `pwsh.exe` | Check `C:\Program Files\PowerShell\7\pwsh.exe` |
| Windows PowerShell | `powershell.exe` | Always present on Windows |
| Git Bash | `bash.exe` | Check `C:\Program Files\Git\bin\bash.exe` |

**Detection targets (non-Windows):**

Only PowerShell 7 is auto-detected on non-Windows. Bash remains hardcoded (matching existing behavior per requirements).

| Shell | Executable | Detection method |
|-------|-----------|-----------------|
| PowerShell 7 | `pwsh` | `which pwsh` |

Bash uses the existing hardcoded path (`bash` on Unix).

**Version detection:** Run version commands in parallel via `Promise.all` at startup:
- `pwsh --version` → e.g. "PowerShell 7.5.1"
- `powershell -Command "$PSVersionTable.PSVersion.ToString()"` → e.g. "5.1.26100"

Both commands return quickly (<500ms each). Running in parallel keeps total cost under 500ms.

**Deduplication:** If both Store and MSI installs of PowerShell 7 are found, only one `pwsh` entry appears — using whichever path `where.exe` / PATH resolves first.

**Data structure:**

```typescript
interface DetectedShell {
  id: string;      // e.g. 'pwsh', 'powershell', 'gitbash'
  label: string;   // e.g. 'PowerShell 7.5.1', 'Windows PowerShell 5.1.26100', 'Bash'
  path: string;    // full path to executable
  type: 'powershell' | 'bash';  // behavioral category — determines isRawShell logic
}
```

The `type` field is a behavioral discriminator. The session manager uses it to decide whether a session is a raw shell (no CLI command auto-started) vs a CLI tool session.

**Caching:** Results are cached in memory for the app's lifetime. No re-detection needed unless the app restarts.

### 2. Dynamic Shell Menu

The static `SHELL_TOOLS` array in `ipc-channels.ts` is no longer used for shell rendering. Instead:

- A new IPC channel `SHELL_LIST` allows the renderer to fetch `DetectedShell[]` from the main process at startup.
- `Toolbar.tsx` renders the Shell section from this dynamic list.
- Each button displays the version-accurate label (e.g. "PowerShell 7.5.1").

**Flow:**

```
App starts
  → detectShells() runs in main process
  → results cached in memory

Renderer mounts
  → calls window.agentPlex.getShells() via IPC
  → receives DetectedShell[]
  → renders shell buttons dynamically
```

### 3. Settings Manager (`src/main/settings-manager.ts`)

New module managing `~/.agentplex/settings.json` (separate from existing `state.json`).

**File format:**

```json
{
  "defaultShell": "pwsh"
}
```

- `defaultShell` stores the `id` of a detected shell.
- If unset or the referenced shell isn't installed, falls back to: first available PowerShell on Windows, `bash` on Unix.

**API:**

```typescript
function loadSettings(): AppSettings;
function saveSettings(settings: AppSettings): void;
function getDefaultShellId(): string;
function setDefaultShellId(id: string): void;
```

### 4. Session Manager Changes (`src/main/session-manager.ts`)

**`create()` method:**
- Receives the shell `id` (e.g. `'pwsh'`, `'powershell'`, `'gitbash'`).
- Looks up the shell path from the cached detected shells.
- For CLI tools (Claude, Codex, Copilot), uses the default shell from settings.
- Removes all hardcoded shell path logic.
- The `isRawShell` check (`cli === 'powershell' || cli === 'bash'`) is replaced by looking up the `DetectedShell.type` field from the cache. Any shell with a detected entry is considered a raw shell (no CLI command auto-started). CLI tools (claude, codex, copilot, claude-resume) are not in the detected shells cache, so they continue to auto-start their commands.

**`createWithUuid()` method (restored sessions):**
- Looks up the default shell ID from `settings-manager.getDefaultShellId()`.
- Resolves it against the detected shells cache to get the executable path.
- If the default shell is not found in detected shells (e.g. uninstalled), falls back to first available PowerShell on Windows, `bash` on Unix.
- Replaces the hardcoded `powershell.exe` on line 180.

**Migration note:** Existing `state.json` files store `"cli": "powershell"` for old sessions. Since `createWithUuid` only restores sessions with a `claudeSessionUuid` (non-null), and raw shell sessions have `claudeSessionUuid: null`, old shell sessions are never restored. No migration is needed.

### 5. Default Shell UI

The Shell section of the toolbar menu gains:

- A **star/checkmark icon** next to the current default shell.
- A **right-click context menu** on each shell button with a "Set as default" option.

**Interaction:**
- Left-click → launches a session with that shell.
- Right-click → shows context menu with "Set as default".
- Setting a new default calls `SETTINGS_SET_DEFAULT_SHELL` IPC channel, updates `settings.json`, and re-renders the menu indicator.

**Visual:**

```
── Shell ──────────────────────────────────────────
[★ PowerShell 7.5.1] [Windows PowerShell 5.1] [Bash]
```

### 6. IPC Changes

**New channels:**

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `SHELL_LIST` | renderer → main | Get detected shells |
| `SETTINGS_GET_DEFAULT_SHELL` | renderer → main | Get current default shell ID |
| `SETTINGS_SET_DEFAULT_SHELL` | renderer → main | Set default shell ID |

**New preload API:**

```typescript
getShells(): Promise<DetectedShell[]>
getDefaultShell(): Promise<string>
setDefaultShell(id: string): Promise<void>
```

## Files to Create

- `src/main/shell-detector.ts` — shell detection and version querying
- `src/main/settings-manager.ts` — `~/.agentplex/settings.json` read/write

## Files to Modify

- `src/shared/ipc-channels.ts` — new IPC channel constants, `DetectedShell` type. Remove `SHELL_TOOLS` array (no longer needed). `CliTool` union keeps existing values for CLI tools (`'claude' | 'codex' | 'copilot' | 'claude-resume'`) and adds a `| string` escape hatch for dynamic shell IDs. The IPC handler validation (`VALID_CLI_IDS`) is updated to also accept any shell ID present in the detected shells cache
- `src/main/session-manager.ts` — replace hardcoded shell paths with detected shell lookups + default shell
- `src/main/ipc-handlers.ts` — new IPC handlers for shell list and default shell
- `src/preload/preload.ts` — expose `getShells`, `getDefaultShell`, `setDefaultShell`
- `src/renderer/components/Toolbar.tsx` — dynamic shell menu, default indicator, right-click context menu

## Edge Cases

- **pwsh installed after app starts:** Not detected until next app restart. Acceptable tradeoff — shell installations are rare events.
- **Default shell uninstalled:** Falls back to first available PowerShell, then bash.
- **settings.json doesn't exist:** Created on first "Set as default" action. Until then, uses fallback logic.
- **settings.json malformed:** `loadSettings()` catches parse errors and returns defaults.
- **Version command hangs:** Set a timeout (2 seconds) on version detection. Fall back to generic label (e.g. "PowerShell 7") if version command times out.
