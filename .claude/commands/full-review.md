---
description: Run all five review skills in sequence (PR, code quality, security, performance, tests) and present a consolidated findings report
argument-hint: Optional commit ref or branch to review (default: HEAD vs HEAD~1)
allowed-tools: ["Bash", "Read"]
---

# Full Review

Run all five review disciplines in sequence and produce a single consolidated report.

Target: $ARGUMENTS (use `HEAD` vs `HEAD~1` if not specified, or `main...HEAD` for a full branch review)

## Steps

Work through each review below in order. Do not skip any. Collect all findings before presenting the final report.

1. **Get the diff once** (`git diff HEAD~1 HEAD` or `git diff main...HEAD`) and read `CLAUDE.md`.
2. **PR review** — follow `.claude/commands/pr-review.md`: correctness, completeness, breaking changes, CLAUDE.md rules.
3. **Code quality** — follow `.claude/commands/code-review.md`.
4. **Security** — follow `.claude/commands/security-review.md`.
5. **Performance** — follow `.claude/commands/performance-review.md`.
6. **Tests** — follow `.claude/commands/test-review.md`, including running `npm test`.
7. **Checks** — run `npx prettier --check .` and `npm run check`; report any failure.

## Report

## Full Review — `<target>`

### Summary

_One paragraph: what changed and whether it is ready to merge._

### ❌ Must fix

- `file:line` — _issue_ (_which review found it_)

### ⚠️ Should fix

- `file:line` — _issue_

### ✅ Good

- _Things done well_

### Checks

- [ ] Prettier
- [ ] `npm run check`
- [ ] CLAUDE.md rules
