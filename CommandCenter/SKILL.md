# CommandCenter Skill

Central command skill for repository automation in Claude CLI and GitHub Copilot CLI.

## Command namespace

All commands use the `plex` prefix:

- `/plex-release`
- `/plex-pr-comments-address`

## Directory contract

Canonical discovery files live in:

- `.claude/commands/` (Claude CLI slash commands)
- `.github/prompts/` (GitHub Copilot prompt commands)

`CommandCenter/` is the design/source area for command definitions.

## Available command specs

- `plex-release.md` — release workflow command
- `plex-pr-comments-address.md` — PR review triage/resolution workflow
