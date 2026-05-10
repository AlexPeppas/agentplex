---
mode: "agent"
description: "Ship an AgentPlex release with standard naming and EXE asset."
---

Run the AgentPlex release workflow for this repository.

Inputs:
- version (required, semver like 1.6.1)
- branch (optional, default master)

Required behavior:
1. Fast-forward the chosen branch from origin.
2. Bump version in release-tracked files.
3. Commit version bump.
4. Build release artifacts with `pnpm make`.
5. Create/push tag `v<version>`.
6. Create or update release with:
   - Title: `AgentPlex v<version>`
   - Asset: `AgentPlex.exe`
7. Verify release title and assets before completion.
