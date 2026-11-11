---
description: Security-focused review of recent changes — secrets, webview XSS and CSP, token handling, untrusted model output and tool calls
argument-hint: Optional commit ref or branch (default: HEAD vs HEAD~1)
allowed-tools: ["Bash", "Read"]
---

# Security Review

Perform a security-focused review of recent changes in this VS Code extension.

Target: $ARGUMENTS (use `HEAD` vs `HEAD~1` if not specified, or `main...HEAD` for a branch)

## Steps

1. **Get the diff** and read `CLAUDE.md`.

2. **Secrets**
   - Tokens are read and written only through `src/auth/` (SecretStorage); never in settings, logs, error messages or the webview state
   - The GitHub token is never sent to Ollama; model calls carry no credentials
   - No real token, even expired, in code, tests or fixtures (`git diff --staged` for `ghp_`, `github_pat_`)

3. **Webview**
   - Model output and server messages are rendered as text, never as HTML (`dangerouslySetInnerHTML`, `innerHTML`)
   - CSP keeps `default-src 'none'`, nonce-only scripts, no remote origins and no `unsafe-eval` / `unsafe-inline` scripts
   - `localResourceRoots` stays limited to `dist/`
   - Messages from the webview are validated before use (model ids against the list, text trimmed and length-checked)

4. **Network**
   - `oreo.ollamaUrl` is validated (`normalizeOllamaUrl`); no requests to other hosts
   - No retries that could loop on 429

5. **Agent and tools** (once present)
   - Write tools need an approval card showing the exact change; branch and PR rules are enforced in code, not the prompt
   - Tool results and repo content are treated as untrusted input to the model
   - Child processes (`github-mcp-server`) get only the environment variables they need

6. **Present findings** as ❌ Critical, ⚠️ Medium, ℹ️ Low, each with `file:line`, the risk and the fix.
