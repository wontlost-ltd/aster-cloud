import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { insertSecurityEventValues, insertSecurityEvent } = vi.hoisted(() => {
  const insertSecurityEventValues = vi.fn();
  const insertSecurityEvent = vi.fn(() => ({ values: insertSecurityEventValues }));
  return { insertSecurityEventValues, insertSecurityEvent };
});

vi.mock('@/lib/prisma', () => ({
  db: { insert: insertSecurityEvent },
  securityEvents: {},
}));

import { logSecurityAdminAction } from '@/services/security/security-event-service';

const adminActions = [
  'API_KEY_CREATED',
  'API_KEY_REVOKED',
  'TEAM_CREATED',
  'TEAM_DELETED',
  'TEAM_OWNERSHIP_TRANSFERRED',
  'TEAM_MEMBER_REMOVED',
  'POLICY_TRASHED',
  'POLICY_RESTORED',
  'POLICY_PERMANENTLY_DELETED',
] as const;

describe('logSecurityAdminAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertSecurityEventValues.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(adminActions)('writes %s using the existing event enum', async (action) => {
    await logSecurityAdminAction('user-1', action, { resourceId: 'resource-1' });

    expect(insertSecurityEventValues).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'VERSION_CREATED',
      severity: 'INFO',
      userId: 'user-1',
      details: { resourceId: 'resource-1', action },
    }));
  });

  it('logs persistence failures without rejecting the admin operation', async () => {
    const error = new Error('database unavailable');
    insertSecurityEventValues.mockRejectedValueOnce(error);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(logSecurityAdminAction('user-1', 'TEAM_DELETED')).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith('[SecurityEvent] Failed to log event:', error);
  });
});
