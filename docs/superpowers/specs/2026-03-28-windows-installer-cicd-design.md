# AgentPlex Windows Installer & CI/CD Pipeline

## Overview

Replace electron-forge + Squirrel with electron-builder + NSIS to get a proper Windows installer wizard, add auto-update support via GitHub Releases, and create a GitHub Actions pipeline for building and publishing releases.

## Goals

- Proper Windows installer with wizard UI (welcome, directory picker, shortcuts, progress, finish)
- Install to `C:\Program Files\AgentPlex` by default (user can change)
- Desktop + Start Menu shortcuts
- Proper uninstaller registered in Apps & Features
- Auto-update: app checks GitHub Releases on startup, notifies user of updates
- GitHub Actions workflow with manual trigger to build + publish releases

## Non-Goals

- Code signing (no certificate yet; SmartScreen warning accepted for now)
- macOS or Linux installers
- Tag-based or automatic release triggers

---

## Architecture

### 1. Build System: Migrate from electron-forge to electron-builder

Replace electron-forge entirely with electron-builder. Keep the existing Vite configs for building main/preload/renderer code.

**Why**: electron-forge's NSIS maker is a thin wrapper that doesn't support auto-update publishing. electron-builder has native NSIS + auto-update + `latest.yml` generation built in.

**Dependencies removed:**
- `@electron-forge/cli`
- `@electron-forge/maker-squirrel`
- `@electron-forge/maker-zip`
- `@electron-forge/plugin-auto-unpack-natives`
- `@electron-forge/plugin-vite`

**Dependencies added:**
- `electron-builder` (packaging + installer)
- `electron-updater` (auto-update in app code)

**Config files:**
- Delete `forge.config.ts`
- Add `electron-builder.yml` with NSIS configuration

**`electron-builder.yml`:**
```yaml
appId: com.agentplex.app
productName: AgentPlex
directories:
  output: dist
  buildResources: assets
files:
  - .vite/**
  - package.json
  - node_modules/node-pty/**
asar: true
asarUnpack:
  - node_modules/node-pty/**
win:
  target: nsis
  icon: assets/logo.ico
nsis:
  oneClick: false
  perMachine: true
  allowToChangeInstallationDirectory: true
  createDesktopShortcut: true
  createStartMenuShortcut: true
  shortcutName: AgentPlex
  installerIcon: assets/logo.ico
  uninstallerIcon: assets/logo.ico
  installerSidebar: assets/installer-sidebar.bmp  # optional, 164x314 BMP
publish:
  provider: github
  owner: AlexPeppas
  repo: agentplex
```

**Package.json scripts:**
```json
{
  "start": "concurrently \"vite build --watch -c vite.main.config.mts\" \"vite build --watch -c vite.preload.config.mts\" \"vite -c vite.renderer.config.mts\" \"electron .\"",
  "build": "vite build -c vite.main.config.mts && vite build -c vite.preload.config.mts && vite build -c vite.renderer.config.mts",
  "dist": "pnpm build && electron-builder --win",
  "dist:publish": "pnpm build && electron-builder --win --publish always"
}
```

Note: The exact `start` script may need refinement — we need Vite to build main+preload first, then start the renderer dev server, then launch Electron. This can be done with `concurrently` or a small dev script. The existing Vite configs (`vite.main.config.mts`, `vite.preload.config.mts`, `vite.renderer.config.mts`) remain unchanged.

**node-pty handling:**
- The `forge.config.ts` hook that copies node-pty is replaced by electron-builder's `files` config which includes `node_modules/node-pty/**`
- `asarUnpack` ensures node-pty's native prebuilds are extracted from the asar archive

### 2. Auto-Update via electron-updater

**New file: `src/main/updater.ts`**
- Imports `autoUpdater` from `electron-updater`
- On app ready, calls `autoUpdater.checkForUpdatesAndNotify()`
- Non-intrusive: shows a system notification when an update is available
- User clicks notification to download and install; app restarts with new version
- Update source: GitHub Releases (reads `latest.yml` artifact published alongside installer)

**Changes to `src/main/main.ts`:**
- Import and initialize the updater after app is ready
- Only check for updates in production (skip in dev mode)

**No server required** — GitHub Releases hosts the update artifacts for free. electron-builder generates the `latest.yml` manifest automatically during `dist:publish`.

### 3. GitHub Actions Pipeline

**New file: `.github/workflows/release.yml`**

**Trigger:** `workflow_dispatch` with a `version` input parameter (e.g., `1.4.1`)

**Runner:** `windows-latest`

**Steps:**
1. Checkout code
2. Setup Node.js 20
3. Setup pnpm
4. `pnpm install`
5. Bump `version` in `package.json` to the input version
6. `pnpm dist:publish` — builds Vite, runs electron-builder, creates NSIS installer + `latest.yml`
7. electron-builder's `--publish always` with `GH_TOKEN` creates the GitHub Release and uploads all artifacts automatically

**Environment variables:**
- `GH_TOKEN`: GitHub token with `contents: write` permission (provided by `${{ secrets.GITHUB_TOKEN }}`)

**Permissions:** `contents: write` (to create releases and upload assets)

---

## Files Changed/Added

| File | Action | Description |
|------|--------|-------------|
| `forge.config.ts` | Deleted | No longer needed |
| `electron-builder.yml` | New | electron-builder config with NSIS options |
| `package.json` | Modified | Remove forge deps, add electron-builder + electron-updater, update scripts |
| `src/main/updater.ts` | New | Auto-update logic |
| `src/main/main.ts` | Modified | Initialize updater on app ready |
| `.github/workflows/release.yml` | New | Manual-trigger release pipeline |

## Installer User Experience

1. User downloads `AgentPlex Setup X.Y.Z.exe` from GitHub Releases
2. Runs installer, sees welcome screen
3. Picks install directory (default: `C:\Program Files\AgentPlex`)
4. Chooses shortcut options (desktop, start menu)
5. Progress bar during install
6. Finish screen with option to launch app
7. App appears in Apps & Features with proper uninstall entry
8. On subsequent launches, app silently checks for updates and notifies if available

## Dev Workflow Changes

| Before | After |
|--------|-------|
| `pnpm start` (forge) | `pnpm start` (Vite + Electron directly) |
| `pnpm package` (forge package) | `pnpm build` (Vite only) |
| `pnpm make` (forge make) | `pnpm dist` (Vite + electron-builder) |
| N/A | `pnpm dist:publish` (build + publish to GitHub Releases) |
