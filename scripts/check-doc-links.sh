#!/usr/bin/env bash
# Checks markdown docs for broken local file references (images and links).
# Runs on staged .md files; falls back to all .md files if none are staged.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
ERRORS=0

# Collect staged markdown files; if none, check all markdown files.
staged=()
while IFS= read -r line; do [[ -n "$line" ]] && staged+=("$line"); done < <(git diff --cached --name-only --diff-filter=ACM | grep '\.md$' || true)
if [[ ${#staged[@]} -eq 0 ]]; then
  while IFS= read -r line; do [[ -n "$line" ]] && staged+=("$line"); done < <(find "$REPO_ROOT" -name '*.md' -not -path '*/.git/*' -not -path '*/node_modules/*')
fi

for mdfile in "${staged[@]}"; do
  abs_md="$mdfile"
  [[ "$mdfile" = /* ]] || abs_md="$REPO_ROOT/$mdfile"
  [[ -f "$abs_md" ]] || continue

  doc_dir="$(dirname "$abs_md")"
  rel_md="${abs_md#"$REPO_ROOT/"}"

  # Match markdown image and link syntax: ![alt](path) and [text](path)
  # Extracts only the URL/path part inside the parentheses.
  while IFS= read -r ref; do
    # Skip URLs
    [[ "$ref" =~ ^https?:// ]] && continue
    # Skip pure anchors
    [[ "$ref" =~ ^# ]] && continue
    [[ -z "$ref" ]] && continue

    # Strip query strings and fragments for file existence check
    clean_ref="${ref%%\?*}"
    clean_ref="${clean_ref%%#*}"
    [[ -z "$clean_ref" ]] && continue

    target="$doc_dir/$clean_ref"
    if [[ ! -e "$target" ]]; then
      echo "BROKEN: $rel_md → $clean_ref"
      ERRORS=$((ERRORS + 1))
    fi
  done < <(grep -oP '!?\[[^\]]*\]\(\K[^)]+(?=\))' "$abs_md" || true)
done

if [[ $ERRORS -gt 0 ]]; then
  echo ""
  echo "Found $ERRORS broken reference(s) in documentation."
  echo "Fix the paths or add the missing files before committing."
  exit 1
fi

echo "Documentation links OK."
