"""Remove lines a pull request description must not have, with the section rule above them.

Usage: clean_pr_body.py < body > cleaned
Exits 0 when the body was already clean and 1 when something was removed.
Run by .github/workflows/pr-description.yml; the same rules as oreo-ai and oreo-cloud.
"""

import re
import sys

# Any co-author or agent trailer, an agent's session link, or "generated/requested by" an agent.
AGENTS = r"claude|anthropic|copilot|openai|chatgpt|gpt|gemini|codex|cursor|\bai\b|llm|agent"
FORBIDDEN_LINE = re.compile(
    r"^\W*(co-authored-by|co-committed-by|claude-session|generated-by|requested-by|assisted-by)\s*:"
    r"|claude\.ai/code"
    r"|(generated|requested|created|written|authored)\s+(by|with|using)\b.*(" + AGENTS + ")",
    re.IGNORECASE,
)
RULES = {"---", "***", "___"}


def clean(body: str) -> str:
    kept: list[str] = []
    for line in body.replace("\r\n", "\n").split("\n"):
        if not FORBIDDEN_LINE.search(line):
            kept.append(line)
            continue
        # Drop the section around it: blank lines and one horizontal rule just above.
        while kept and not kept[-1].strip():
            kept.pop()
        if kept and kept[-1].strip() in RULES:
            kept.pop()
    while kept and not kept[-1].strip():
        kept.pop()
    return "\n".join(kept) + "\n" if kept else ""


def main() -> int:
    body = sys.stdin.read()
    cleaned = clean(body)
    sys.stdout.write(cleaned)
    return 0 if cleaned.strip() == body.strip() else 1


if __name__ == "__main__":
    raise SystemExit(main())
