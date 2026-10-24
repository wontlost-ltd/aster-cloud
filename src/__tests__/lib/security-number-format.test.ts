import { describe, expect, it } from 'vitest';
import { formatSecurityCount, formatSecurityPercentage } from '@/lib/security-number-format';

describe('security dashboard locale formatting', () => {
  it('formats counts and percentages with the active locale', () => {
    expect(formatSecurityCount(1234, 'en-US')).toBe('1,234');
    expect(formatSecurityPercentage(0.001, 'de-DE')).toContain('0,1');
    expect(formatSecurityPercentage(0.001, 'de-DE')).toContain('%');
  });
});
