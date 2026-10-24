import { describe, expect, it } from 'vitest';
import { decisionLabelKey } from './decision-label';

describe('decisionLabelKey', () => {
  it('shows rejection and engine error as separate decisions', () => {
    expect(decisionLabelKey('denied', false)).toBe('denied');
    expect(decisionLabelKey('error', false)).toBe('error');
    expect(decisionLabelKey('approved', true)).toBe('approved');
  });
});
