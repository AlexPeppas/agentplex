---
description: Review a PR, fix actionable comments, and resolve addressed review threads.
---

Run `/plex-pr-comments-address` for this repository.

Input:
- `pr` (optional PR number)

Behavior:
1. Determine PR number (`pr` input, else infer from current branch).
2. Fetch PR review comments/threads and unresolved feedback.
3. Apply fixes for actionable items.
4. Resolve addressed threads when possible; otherwise reply with explicit resolution notes.
5. Return a concise summary of fixed items, resolved threads, and remaining blockers.
