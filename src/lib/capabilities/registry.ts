/*
 * 能力注册表（ADR 0058 §4.1）。
 *
 * 能力的元数据写在代码里，库里只存授权事实；新增能力 = 加一条注册项，不改表结构。
 */

import type { PlanCapabilities } from '@/lib/plans';
import { PLATFORM_SETTING_KEYS } from '@/lib/platform-settings';

export const CAPABILITY_KEYS = ['structured_authoring'] as const;
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

export interface CapabilityDescriptor {
  /** 全局开关的 PlatformSetting 键（缺行默认值在 platform-settings 的 DEFAULTS）。 */
  settingKey: string;
  /** 团队委派总开关的键；不支持委派的能力为 null。 */
  teamDelegationSettingKey: string | null;
  /** 需要的套餐能力；null = 不看套餐。 */
  planCapability: keyof PlanCapabilities | null;
  /** 是否允许团队 owner 在额度内委派授予。 */
  teamDelegation: boolean;
  /** 平台管理员是否隐式拥有。 */
  implicitForPlatformAdmin: boolean;
  /** 部署前提；不满足视为全局关闭。 */
  precondition?: () => boolean;
}

export const CAPABILITIES: Record<CapabilityKey, CapabilityDescriptor> = {
  structured_authoring: {
    settingKey: PLATFORM_SETTING_KEYS.STRUCTURED_AUTHORING_ENABLED,
    teamDelegationSettingKey: PLATFORM_SETTING_KEYS.STRUCTURED_AUTHORING_TEAM_DELEGATION,
    planCapability: 'structuredAuthoring',
    teamDelegation: true,
    implicitForPlatformAdmin: false,
  },
};

export function isCapabilityKey(v: unknown): v is CapabilityKey {
  return typeof v === 'string' && (CAPABILITY_KEYS as readonly string[]).includes(v);
}
