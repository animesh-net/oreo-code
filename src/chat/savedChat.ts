import type { ChatMessage } from '../shared/protocol';

/** A chat as kept across reloads: its messages and the summary of a compacted beginning. */
export interface SavedChat {
  messages: ChatMessage[];
  compacted?: { upTo: number; summary: string };
}

/** The most a saved chat takes in VS Code's storage; the oldest messages go first. */
export const MAX_SAVED_CHARS = 1_000_000;

/**
 * The chat to save: whole, or without its oldest messages (two at a time, a question and
 * its answer) until it fits in MAX_SAVED_CHARS. A compacted beginning moves with it.
 */
export function chatToSave(chat: SavedChat, max = MAX_SAVED_CHARS): SavedChat {
  let { messages, compacted } = chat;
  while (messages.length > 2 && JSON.stringify({ messages, compacted }).length > max) {
    messages = messages.slice(2);
    if (compacted) compacted = { ...compacted, upTo: Math.max(0, compacted.upTo - 2) };
  }
  return compacted ? { messages, compacted } : { messages };
}

/** A saved chat read back, or undefined if it isn't one: storage is only trusted so far. */
export function readSavedChat(value: unknown): SavedChat | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { messages, compacted } = value as { messages?: unknown; compacted?: unknown };
  if (!Array.isArray(messages)) return undefined;
  const kept = messages.filter(
    (m): m is ChatMessage =>
      !!m &&
      typeof m === 'object' &&
      ((m as ChatMessage).role === 'user' || (m as ChatMessage).role === 'assistant') &&
      typeof (m as ChatMessage).content === 'string',
  );
  const c = compacted as { upTo?: unknown; summary?: unknown } | undefined;
  const validSummary =
    !!c && typeof c.upTo === 'number' && c.upTo >= 0 && c.upTo <= kept.length && typeof c.summary === 'string';
  return validSummary
    ? { messages: kept, compacted: { upTo: c.upTo as number, summary: c.summary as string } }
    : { messages: kept };
}
