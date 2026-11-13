import type { WireMessage } from '../ollama/client';

/** Compact once the prompt reaches this share of the model's context window. */
export const COMPACT_AT = 0.95;
/** The newest messages kept word for word, as a share of the context window. */
const KEEP_RECENT = 0.25;
/** The most of the earlier conversation sent to be summarized, as a share of the window. */
const SUMMARY_INPUT = 0.5;
/** The longest summary kept, as a share of the window. */
const SUMMARY_MAX = 0.12;
/** Each earlier tool result or argument shown to the summarizer is cut to this. */
const CLIP_RESULT = 1_500;

export const SUMMARY_HEADING = 'Summary of the conversation so far (compacted to fit the context window):';

/** The message that stands in for the earlier conversation. */
export function summaryMessage(summary: string): WireMessage {
  return {
    role: 'user',
    content: `${SUMMARY_HEADING}\n${summary}\n\nFile contents shown earlier aren't here any more: read a file again before changing it.`,
  };
}

const SUMMARY_PROMPT = `You compact a conversation between a user and a coding assistant so it can go on in a smaller context window. Write a short summary that lets the assistant carry on without the original messages:
- what the user asked for, in their words where it matters
- what was found: files, functions, causes
- what was changed, file by file, and what was run with what result
- what still fails, with the exact error messages
- decisions made and what remains to do
Don't copy file contents or long output. Plain text or short bullets, no preamble.`;

/** The prompt's size as the context window sees it: messages plus tool-call arguments. */
export function wireSize(wire: readonly WireMessage[]): number {
  return wire.reduce(
    (n, m) =>
      n +
      m.content.length +
      (m.role === 'assistant' ? (m.tool_calls ?? []).reduce((k, t) => k + t.function.arguments.length, 0) : 0),
    0,
  );
}

/** Summarizes a short conversation; returns the summary's text. */
export type Summarize = (messages: WireMessage[]) => Promise<string>;

export interface Compacted {
  /** The current question's new index. */
  question: number;
  /** The summary that replaced the earlier messages, to reuse on later turns. */
  summary: string;
}

/**
 * Once the prompt reaches COMPACT_AT of `max`, replaces the earlier conversation with a
 * summary written by the model, in place: the system prompt, the current question and
 * the newest messages stay word for word. Earlier turns go before the question, the
 * older rounds of work on it after; both are summarized together and the summary sits
 * just before the question. Returns undefined, changing nothing, if the prompt isn't
 * that full, there's nothing earlier to summarize, or the summary comes back empty;
 * fitToContext still trims after either way.
 */
export async function compactWire(
  wire: WireMessage[],
  question: number,
  max: number,
  summarize: Summarize,
): Promise<Compacted | undefined> {
  if (wireSize(wire) < max * COMPACT_AT) return undefined;
  const tailStart = recentStart(wire, question, max * KEEP_RECENT);
  const earlier = [...wire.slice(1, question), ...wire.slice(question + 1, tailStart)];
  // Nothing new since the last summary: summarizing it again would only lose detail.
  if (!earlier.length || (earlier.length === 1 && earlier[0].content.startsWith(SUMMARY_HEADING))) return undefined;

  const transcript = keepStartAndEnd(earlier.map(describe).join('\n\n'), Math.floor(max * SUMMARY_INPUT));
  const summary = (
    await summarize([
      { role: 'system', content: SUMMARY_PROMPT },
      { role: 'user', content: `Summarize this conversation:\n\n${transcript}` },
    ])
  )
    .trim()
    .slice(0, Math.floor(max * SUMMARY_MAX));
  if (!summary) return undefined;

  const kept = [wire[question], ...wire.slice(tailStart)];
  wire.splice(1, wire.length - 1, summaryMessage(summary), ...kept);
  return { question: 2, summary };
}

/**
 * Where the newest messages kept word for word start: as many after the question as fit
 * in `budget`, never starting on a tool result, whose call must come before it.
 */
function recentStart(wire: readonly WireMessage[], question: number, budget: number): number {
  let start = wire.length;
  let used = 0;
  while (start - 1 > question) {
    used += wireSize([wire[start - 1]]);
    if (used > budget) break;
    start--;
  }
  while (start < wire.length && wire[start].role === 'tool') start++;
  return start;
}

/** One message as the summarizer reads it, long parts cut. */
function describe(m: WireMessage): string {
  const clip = (s: string) => (s.length > CLIP_RESULT ? `${s.slice(0, CLIP_RESULT)} … (cut)` : s);
  if (m.role === 'tool') return `Tool result:\n${clip(m.content)}`;
  if (m.role === 'assistant') {
    const calls = (m.tool_calls ?? []).map((t) => `Called ${t.function.name} ${clip(t.function.arguments)}`);
    return [`Assistant: ${clip(m.content)}`, ...calls].join('\n');
  }
  return `${m.role === 'user' ? 'User' : 'System'}: ${clip(m.content)}`;
}

/**
 * `text` within `max` characters: the start (what was asked) and the end (the newest
 * work) matter most, so the middle is cut.
 */
function keepStartAndEnd(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.25);
  return `${text.slice(0, head)}\n… (messages in between left out)\n${text.slice(text.length - (max - head))}`;
}
