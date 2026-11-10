---
description: Test coverage review of recent changes — missing unit tests, weak assertions, and untested error paths
argument-hint: Optional commit ref or branch (default: HEAD vs HEAD~1)
allowed-tools: ["Bash", "Read"]
---

# Test Review

Review whether recent changes are properly tested.

Target: $ARGUMENTS (use `HEAD` vs `HEAD~1` if not specified, or `main...HEAD` for a branch)

## Steps

1. **Get the diff** and read `CLAUDE.md`.

2. **Run the tests**

   ```bash
   npm test
   ```

3. **For each changed source file, check:**
   - Logic in `src/chat/`, `src/gateway/` (and later `src/agent/`, `src/mcp/`) has Vitest tests in `test/`
   - Error paths are tested: 401, 429, 503, network failure, aborted streams, malformed server responses
   - Assertions check behaviour (state, posted messages, request bodies), not just that nothing threw
   - Fakes stand in for the gateway and MCP servers; no test calls the real oreo-ai or GitHub
   - New webview protocol messages are covered from the controller side

4. **Present findings**: what is covered, what is missing (`file` — the case that needs a test), and any flaky patterns (timers, real network, order dependence).
