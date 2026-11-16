import { describe, expect, it } from 'vitest';
import { CAPABILITIES, CAPABILITY_KEYS, isCapabilityKey } from '@/lib/capabilities/registry';
import { CAPABILITY_ERROR_STATUS, CapabilityError, capabilityErrorResponse } from '@/lib/capabilities/errors';
import { PLATFORM_SETTING_KEYS } from '@/lib/platform-settings';

describe('能力注册表', () => {
  it('structured_authoring 注册项', () => {
    const d = CAPABILITIES.structured_authoring;
    expect(d.settingKey).toBe('capability.structured_authoring.enabled');
    expect(d.settingKey).toBe(PLATFORM_SETTING_KEYS.STRUCTURED_AUTHORING_ENABLED);
    expect(d.teamDelegationSettingKey).toBe('capability.structured_authoring.team_delegation.enabled');
    expect(d.planCapability).toBe('structuredAuthoring');
    expect(d.teamDelegation).toBe(true);
    expect(d.implicitForPlatformAdmin).toBe(false);
    expect(d.precondition).toBeUndefined();
  });

  it('isCapabilityKey 只认注册键', () => {
    expect(CAPABILITY_KEYS).toEqual(['structured_authoring']);
    expect(isCapabilityKey('structured_authoring')).toBe(true);
    expect(isCapabilityKey('ai_workspace')).toBe(false);
    expect(isCapabilityKey(undefined)).toBe(false);
  });
});

describe('CapabilityError', () => {
  it('错误码按表映射 HTTP 状态', () => {
    expect(CAPABILITY_ERROR_STATUS).toEqual({
      invalid_payload: 400, unknown_capability: 404, subject_not_found: 404, grant_not_found: 404,
      not_team_owner: 403, team_delegation_disabled: 403, delegation_not_supported: 400,
      not_team_member: 400, viewer_not_eligible: 400, seat_cap_reached: 409, seat_cap_below_active: 409,
    });
    expect(new CapabilityError('seat_cap_reached').status).toBe(409);
  });

  it('capabilityErrorResponse 返回 { error, code } 与对应状态', async () => {
    const res = capabilityErrorResponse(new CapabilityError('not_team_owner', 403, 'owner only'));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'owner only', code: 'not_team_owner' });
  });
});
