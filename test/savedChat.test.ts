import { describe, expect, it } from 'vitest';
import { chatToSave, readSavedChat } from '../src/chat/savedChat';
import type { ChatMessage } from '../src/shared/protocol';

const turn = (q: string, a: string): ChatMessage[] => [
  { role: 'user', content: q },
  { role: 'assistant', content: a },
];

describe('saved chats', () => {
  it('saves a chat whole when it fits', () => {
    const chat = { messages: turn('hi', 'hello'), compacted: { upTo: 0, summary: 's' } };
    expect(chatToSave(chat)).toEqual(chat);
  });

  it('drops the oldest turns of a chat too big to save, moving the compacted beginning with them', () => {
    const messages = [...turn('a'.repeat(600), 'A'), ...turn('b'.repeat(600), 'B'), ...turn('c', 'C')];
    const saved = chatToSave({ messages, compacted: { upTo: 4, summary: 's' } }, 500);
    expect(saved.messages).toEqual(turn('c', 'C'));
    expect(saved.compacted).toEqual({ upTo: 0, summary: 's' });
  });

  it('reads back only what looks like a chat', () => {
    expect(readSavedChat(undefined)).toBeUndefined();
    expect(readSavedChat({ messages: 'x' })).toBeUndefined();
    expect(
      readSavedChat({
        messages: [{ role: 'user', content: 'hi' }, { role: 'system', content: 'x' }, { role: 'assistant' }, null],
        compacted: { upTo: 5, summary: 's' }, // past the messages kept: dropped
      }),
    ).toEqual({ messages: [{ role: 'user', content: 'hi' }] });
  });
});
