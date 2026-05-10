---
description: Ship an AgentPlex release with correct title and Windows EXE asset.
---

Run the AgentPlex release workflow for this repository.

Inputs:
- version (required, semver like 1.6.1)
- branch (optional, default master)

Steps:
1. Checkout and fast-forward the release branch from origin.
2. Bump version in release-tracked files.
3. Commit the version bump.
4. Build distributables with `pnpm make`.
5. Tag `v<version>` and push tag + branch.
6. Create or update GitHub release:
   - Title: `AgentPlex v<version>`
   - Tag: `v<version>`
   - Upload `AgentPlex.exe` from build output.
7. Verify release name and asset list.

Do not skip verification of release assets.
