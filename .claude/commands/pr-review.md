---
description: Review current branch changes against main as a thorough PR reviewer — checks correctness, CLAUDE.md compliance, and breaking changes
argument-hint: Optional base branch to diff against (default: main)
allowed-tools: ["Bash", "Read"]
---

# PR Review

Perform a thorough pull request review of this branch's changes.

Base branch: $ARGUMENTS (use `main` if not specified)

## Steps

1. **Identify what changed**

   ```bash
   git log main..HEAD --oneline
   git diff main...HEAD --stat
   ```

2. **Read the full diff**

   ```bash
   git diff main...HEAD
   ```

3. **Load the project rules** — read `CLAUDE.md` to understand what must and must not change.

4. **Review each changed file for:**
   - **Correctness** — does the code do what the commit message claims?
   - **Completeness** — missing edge cases, error paths, cancelled or aborted streams?
   - **Consistency** — does it follow the existing patterns in the file it modifies?
   - **Breaking changes** — could it break the webview protocol (`src/shared/protocol.ts`), stored secrets, settings or packaging?
   - **CLAUDE.md rules** — specifically:
     - Secrets only through `src/auth/` (SecretStorage), never logged or put in settings
     - Webview renders model output as plain text; CSP unchanged or stricter
     - No model ids in code; models only from `GET /api/models`, switched with the dropdown
     - `src/chat/` and `src/ollama/` free of `vscode` imports
     - README updated for user-facing changes
     - No `Co-Authored-By` AI attribution in commit messages

5. **Present findings** using this format:

---

## PR Review — `<branch>` → `main`

### Summary

_One paragraph overview of what this PR does and overall quality._

### ✅ Looks Good

- _List things done well_

### ⚠️ Concerns (should fix before merge)

- `file:line` — _description of concern_

### ❌ Must Fix (blocks merge)

- `file:line` — _description of blocking issue_

### CLAUDE.md Compliance

- [ ] Secrets only in SecretStorage
- [ ] Webview stays plain text with a strict CSP
- [ ] No model ids or model editing
- [ ] Testable core has no `vscode` imports
- [ ] README updated where needed
- [ ] No AI attribution in commits

---
