import { describe, expect, it } from 'vitest';
import { localizedErrorMessage } from '@/lib/api/localized-error-message';

describe('localizedErrorMessage', () => {
  it('uses the localized copy for a known stable code', () => {
    expect(localizedErrorMessage('invalid_email', { invalid_email: 'Enter a valid email.' }, 'Server message'))
      .toBe('Enter a valid email.');
  });

  it('falls back to the server message for an unknown code', () => {
    expect(localizedErrorMessage('new_code', { invalid_email: 'Enter a valid email.' }, 'Try again later.'))
      .toBe('Try again later.');
  });
});
