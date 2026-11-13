import { describe, expect, it } from 'vitest';
import { effortChoices, effortLabel, shownEffort } from '../src/shared/protocol';

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

  it('offers no Thinking choices for a model that cannot think', () => {
    expect(effortChoices('none', 'high')).toEqual([]);
    expect(effortLabel('none', 'high')).toBe('No thinking');
  });
});
