import { describe, expect, it } from 'vitest';
import { COMPACT_AT, compactWire, SUMMARY_HEADING, wireSize } from '../src/chat/compact';
import type { WireMessage } from '../src/ollama/client';

const MAX = 10_000;
const big = (n: number, c = 'x') => c.repeat(n);
const toolCall = (id: string, name: string, args: object) => ({
  id,
  type: 'function' as const,
  function: { name, arguments: JSON.stringify(args) },
});

/** An agent task: a system prompt, an earlier turn, the task, then rounds of tool calls. */
function agentWire(): WireMessage[] {
  const wire: WireMessage[] = [
    { role: 'system', content: 'You are the agent.' },
    { role: 'user', content: 'earlier question' },
    { role: 'assistant', content: 'earlier answer' },
    { role: 'user', content: 'fix the server' },
  ];
  for (let i = 1; i <= 6; i++) {
    wire.push({
      role: 'assistant',
      content: `round ${i}`,
      tool_calls: [toolCall(`c${i}`, 'read_file', { path: `f${i}.js` })],
    });
    wire.push({ role: 'tool', tool_call_id: `c${i}`, content: big(1_600, String(i)) });
  }
  return wire;
}

describe('compactWire', () => {
  it('leaves a prompt below 95% of the window alone', async () => {
    const wire: WireMessage[] = [
      { role: 'system', content: 's' },
      { role: 'user', content: big(MAX * COMPACT_AT - 10) },
    ];
    let asked = false;
    expect(
      await compactWire(wire, 1, MAX, async () => {
        asked = true;
        return 'x';
      }),
    ).toBeUndefined();
    expect(asked).toBe(false);
    expect(wire).toHaveLength(2);
  });

  it('summarizes the earlier conversation and keeps the system prompt, the task and the newest rounds', async () => {
    const wire = agentWire();
    expect(wireSize(wire)).toBeGreaterThanOrEqual(MAX * COMPACT_AT);
    let sent: WireMessage[] = [];
    const result = await compactWire(wire, 3, MAX, async (messages) => {
      sent = messages;
      return 'Read f1–f4; the bug is in serve().';
    });

    expect(result).toEqual({ question: 2, summary: 'Read f1–f4; the bug is in serve().' });
    expect(wire[0]).toEqual({ role: 'system', content: 'You are the agent.' });
    expect(wire[1].content).toBe(
      `${SUMMARY_HEADING}\nRead f1–f4; the bug is in serve().\n\nFile contents shown earlier aren't here any more: read a file again before changing it.`,
    );
    expect(wire[2]).toEqual({ role: 'user', content: 'fix the server' });
    // The newest rounds stay word for word, each tool result after its call.
    expect(wire[3]).toMatchObject({
      role: 'assistant',
      tool_calls: [expect.objectContaining({ id: expect.any(String) })],
    });
    expect(wire.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'c6' });
    for (let i = 3; i < wire.length; i++) {
      if (wire[i].role === 'tool') expect(wire[i - 1].role).toBe('assistant');
    }
    expect(wireSize(wire)).toBeLessThan(MAX * 0.5);
    // The summarizer saw the earlier turn and the older rounds, long results cut.
    const transcript = sent[1].content;
    expect(transcript).toMatch(/User: earlier question[\s\S]*Assistant: earlier answer/);
    expect(transcript).toMatch(/Called read_file \{"path":"f1\.js"\}/);
    expect(transcript).toMatch(/Called read_file \{"path":"f5\.js"\}\n\nTool result:\n5{1500} … \(cut\)/);
    expect(transcript).not.toMatch(/fix the server/);
  });

  it("doesn't summarize a summary again with nothing new", async () => {
    const wire: WireMessage[] = [
      { role: 'system', content: 's' },
      { role: 'user', content: `${SUMMARY_HEADING}\nold summary` },
      { role: 'user', content: big(MAX) },
    ];
    expect(await compactWire(wire, 2, MAX, async () => 'again')).toBeUndefined();
    expect(wire).toHaveLength(3);
  });

  it('changes nothing when the summary comes back empty', async () => {
    const wire = agentWire();
    const before = JSON.stringify(wire);
    expect(await compactWire(wire, 3, MAX, async () => '  ')).toBeUndefined();
    expect(JSON.stringify(wire)).toBe(before);
  });
});
