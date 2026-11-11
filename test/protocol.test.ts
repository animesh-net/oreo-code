import { describe, expect, it } from 'vitest';
import { effortChoices, effortLabel, shownEffort } from '../src/shared/protocol';
import { OREO_MODELS } from '../src/ollama/models';

describe('Thinking menu', () => {
  it('offers Off and On for a model that only switches, On keeping the saved level', () => {
    expect(effortChoices('switch', 'none')).toEqual([
      { value: 'none', label: 'Off' },
      { value: 'medium', label: 'On' },
    ]);
    expect(effortChoices('switch', 'high').map((c) => c.value)).toEqual(['none', 'high']);
    expect(effortLabel('switch', 'none')).toBe('Thinking off');
    expect(effortLabel('switch', 'low')).toBe('Thinking');
  });

  it('offers levels for a model that always reasons, showing off as low', () => {
    expect(effortChoices('levels', 'none').map((c) => c.label)).toEqual(['Low', 'Medium', 'High']);
    expect(shownEffort('levels', 'none')).toBe('low');
    expect(effortLabel('levels', 'high')).toBe('High');
  });

  it('gives every Oreo model a thinking style', () => {
    expect(OREO_MODELS.map((m) => [m.id, m.thinking])).toEqual([
      ['oreo-4b', 'switch'],
      ['oreo-2b', 'switch'],
    ]);
  });
});
