# /plex-release

## Purpose

Create and publish a production release for AgentPlex with consistent naming and assets.

## Inputs

- `version` (required): semantic version, e.g. `1.6.1`
- `branch` (optional): branch to release from (default: `master`)

## Command behavior

1. Checkout release branch and fast-forward from origin.
2. Update app version in release-tracked files.
3. Commit version bump with release-safe message.
4. Build distributables (`pnpm make`).
5. Create/push git tag: `v<version>`.
6. Create/edit GitHub release:
   - Title: `AgentPlex v<version>`
   - Tag: `v<version>`
   - Attach `AgentPlex.exe` from build output.
7. Verify release includes expected asset and correct title.

## Success criteria

- Tag exists on origin (`v<version>`)
- GitHub release exists with title `AgentPlex v<version>`
- Release assets include `AgentPlex.exe`
