import { describe, expect, it } from 'vitest';
import { executionStatus } from './execution-status';

describe('executionStatus', () => {
  it('keeps a completed denial distinct from an execution error', () => {
    expect(executionStatus(false)).toBe('completed');
    expect(executionStatus(true)).toBe('error');
  });
});
