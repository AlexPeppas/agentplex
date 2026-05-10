# /plex-pr-comments-address

## Purpose

Review a pull request, fetch review comments, apply fixes, and resolve addressed threads.

## Inputs

- `pr` (optional): PR number

If `pr` is not provided, discover it from current branch (`gh pr view`) and fall back to searching open PRs for the head branch.

## Command behavior

1. Resolve target PR number.
2. Fetch review threads/comments and outstanding change requests.
3. Create a fix checklist from unresolved actionable comments.
4. Apply code changes for each actionable item.
5. Mark addressed items as resolved (where permissions/API allow), otherwise post clear follow-up comments with fixes.
6. Summarize what was fixed, what was resolved, and anything still blocked.

## Success criteria

- PR comments and review threads were fetched.
- Actionable comments were addressed in code.
- Addressed threads were resolved or acknowledged with explicit follow-ups.
