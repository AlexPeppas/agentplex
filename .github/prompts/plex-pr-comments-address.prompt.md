---
mode: "agent"
description: "Review a PR, implement fixes from comments, and resolve addressed threads."
---

Execute the PR review resolution workflow.

Input:
- `pr` (optional PR number)

Required behavior:
1. Resolve PR number (input or infer from current branch).
2. Fetch review comments and unresolved review threads.
3. Implement code fixes for actionable comments.
4. Resolve addressed threads (or post follow-up if resolution permissions are unavailable).
5. Return concise summary: fixed items, resolved threads, remaining blockers.
