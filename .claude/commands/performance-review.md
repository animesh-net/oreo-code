---
description: Performance review of recent changes — activation cost, bundle size, webview re-renders, streaming and leaks
argument-hint: Optional commit ref or branch (default: HEAD vs HEAD~1)
allowed-tools: ["Bash", "Read"]
---

# Performance Review

Review recent changes for performance issues in this VS Code extension.

Target: $ARGUMENTS (use `HEAD` vs `HEAD~1` if not specified, or `main...HEAD` for a branch)

## Steps

1. **Get the diff** and read `CLAUDE.md`.

2. **Check for:**
   - **Activation** — nothing slow or networked runs synchronously in `activate()`; no new `activationEvents` that start the extension earlier than needed
   - **Bundle size** — new dependencies are worth their weight in `dist/extension.js` / `dist/webview.js` (`npm run package` prints the size)
   - **Streaming** — deltas are appended, not re-sending the whole conversation per token; the webview doesn't re-render the full list on every delta
   - **Leaks** — event listeners, timers, child processes and AbortControllers are disposed or cleared
   - **Requests** — no polling where an event would do; model list and usage are not re-fetched per message
   - **Large inputs** — file contents and tool results are capped before they go to the model or the webview

3. **Present findings** as 🔴 High, 🟡 Medium, 🟢 Low impact, each with `file:line` and a suggested fix.
