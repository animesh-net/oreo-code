---
description: Code quality review of recent changes — readability, structure, TypeScript types, error handling and duplication
argument-hint: Optional commit ref or branch (default: HEAD vs HEAD~1)
allowed-tools: ["Bash", "Read"]
---

# Code Review

Review recent changes for code quality in this VS Code extension (TypeScript, Preact webview, esbuild).

Target: $ARGUMENTS (use `HEAD` vs `HEAD~1` if not specified, or `main...HEAD` for a branch)

## Steps

1. **Get the diff** — `git diff HEAD~1 HEAD` or `git diff main...HEAD`, and read `CLAUDE.md`.

2. **Check each changed file for:**

   **General**
   - Names say what things are; functions do one thing
   - No dead code, commented-out code or leftover `console.log`
   - Comments explain _why_, not _what_
   - No duplication that a small shared helper would remove

   **TypeScript**
   - No `any`, no non-null `!` without a reason, no casts that hide a real type error
   - Unions are narrowed exhaustively (`switch` on `type` covers every message kind)
   - Async errors are caught where the user should see them; promises are not left floating without `void`

   **Extension specifics**
   - Disposables (commands, listeners, status bar items) are added to `context.subscriptions`
   - Webview messages go through the typed `ToWebview` / `FromWebview` unions
   - Long-running calls take an `AbortSignal` and stop on Stop or New chat
   - User-facing error text comes from `src/gateway/errors.ts`

3. **Present findings** as ✅ Good, ⚠️ Should improve (`file:line` — why), ❌ Must fix (`file:line` — why).
