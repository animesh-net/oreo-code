# CLAUDE.md — Developer & AI Agent Guide

oreo-code is the VS Code extension for oreo-ai. It runs on the Mac; the oreo-ai server on the Pi is only a model gateway, token issuer and usage cap. Only Claude is used as an AI assistant on this repo.

## 1. File map

| Task | File(s) |
| --- | --- |
| Add or change a command, view or setting | `package.json` (`contributes`) **and** `README.md` (Commands / Settings tables) |
| Change chat behaviour (turns, stop, errors, model choice) | `src/chat/chatController.ts` and `test/chatController.test.ts` |
| Change how the gateway is called | `src/gateway/client.ts` and `test/gateway.test.ts` |
| Change error wording | `src/gateway/errors.ts` |
| Change messages between extension and webview | `src/shared/protocol.ts` (both sides compile against it) |
| Change the chat UI | `webview-ui/main.tsx`, `webview-ui/styles.css` |
| Change the webview's security policy | `src/views/chatViewProvider.ts` |
| Change build or packaging | `esbuild.mjs`, `.vscodeignore`, `package.json` scripts |

## 2. Non-negotiable rules

1. **No secrets in code or settings.** The oreo-ai API token (and later the GitHub PAT) live only in VS Code SecretStorage via `src/auth/`. Never log them, never put them in `settings.json`, never send the GitHub PAT to oreo-ai.
2. **Model output is untrusted.** The webview renders it as plain text. Keep the CSP in `chatViewProvider.ts` strict: no inline scripts, no remote content, no `unsafe-eval`. If Markdown rendering is added, raw HTML stays off and links are limited to http/https.
3. **No model ids in code, and no model editing.** The four models are fixed in oreo-ai's config and come from `GET /api/models`. The extension only offers a dropdown to switch; don't add settings or UI to add, edit or rename models. Agent mode will use only models with `supportsTools: true`.
4. **`src/chat/` and `src/gateway/` stay free of `vscode` imports** so they can be unit tested. Put VS Code wiring in `src/extension.ts`, `src/views/` and `src/auth/`.
5. **README.md is updated in the same commit as any user-facing change** (commands, settings, install, behaviour).
6. **No AI authorship in commits.** Commits are authored as Animesh Singh <singhanimesh007@hotmail.com>. No `Co-Authored-By:` or other trailer naming an AI agent. Don't change persistent git config; pass identity per commit if needed (`git -c user.name=... -c user.email=... commit`). CI rejects AI trailers.
7. **Never push to `main`**, including force-pushes. Every change lands through a PR against `main`.
8. **No AI attribution in PRs or GitHub posts** — no "Generated with Claude Code" lines or links in titles, descriptions or comments.

## 3. Checks

Run before every commit:

```powershell
npm run check   # tsc (extension + webview), vitest, esbuild
```

`npm run package` must also succeed when `package.json`, `.vscodeignore` or `esbuild.mjs` change.

## 4. Commit messages

One line, present tense, capitalised, under 72 characters, no body. Say what changed specifically (`Add Stop button to chat view`, not `Update UI`).

## 5. Branch naming

`feature/<name_feature>` or `fix/<name_fix>`, lowercase and underscore-separated (for example `feature/github_mcp_host`).

## 6. Pull requests

- Always against `main`, never stacked on another branch.
- Once a branch has no more pending commits, push it and open the PR straight away.
- Title follows the commit message rules.
- Description:

```markdown
## What changed

- One bullet per logical change

## Why

One or two sentences.

## How to test

1. ...

## Checklist

- [ ] `npm run check` passes
- [ ] `npm run package` succeeds (if packaging changed)
- [ ] README updated for user-facing changes
- [ ] No secrets committed
- [ ] No AI attribution in commits or this description
```
