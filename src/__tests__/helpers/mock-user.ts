import type { InferSelectModel } from 'drizzle-orm';
import { users } from '@/db/schema';

export type MockUser = InferSelectModel<typeof users>;

/**
 * 测试用 User 工厂：单点同步 schema。
 *
 * 默认值覆盖 schema 全部字段（含未来新增），允许 partial override。
 *
 * 添加新字段时只需更新此处一处；所有测试自动获得安全默认值。
 */
export function mockUser(overrides: Partial<MockUser> = {}): MockUser {
  const now = new Date();
  return {
    id: 'test-user-1',
    name: 'Test User',
    email: 'test@example.com',
    emailNormalized: 'test@example.com',
    emailVerified: null,
    image: null,
    passwordHash: null,
    failedLoginAttempts: 0,
    lastFailedLoginAt: null,
    lockedUntil: null,
    lockoutCount: 0,
    plan: 'free',
    stripeCustomerId: null,
    subscriptionId: null,
    subscriptionStatus: null,
    priceLockedAt: null,
    legacyTier: null,
    trialStartedAt: null,
    trialEndsAt: null,
    trialEndingEmailSentAt: null,
    aiBannedUntil: null,
    aiBanReason: null,
    signupIpHash: null,
    apiQuotaWarn80SentAt: null,
    apiQuotaWarn100SentAt: null,
    apiQuotaWarn200SentAt: null,
    gracePeriodStartsAt: null,
    gracePeriodEndsAt: null,
    dunningEmailsSentCount: 0,
    lastDunningEmailSentAt: null,
    downgradedAt: null,
    onboardingUseCase: null,
    onboardingGoals: null,
    onboardingCompletedAt: null,
    deletedAt: null,
    purgePendingUntil: null,
    reactivationCount: 0,
    priorPurgeCount: 0,
    riskTier: 0,
    riskTierReason: null,
    isAdmin: false,
    businessRoles: [],
    replayRetentionEnabled: false,
    mustChangePassword: false,
    byokQuotaResetAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/**
 * Pro plan user factory (active subscription, no dunning).
 *
 * codex audit Low-3 ergonomics fix: callers shouldn't have to memorize which
 * combination of fields signals an active Pro state.
 */
export function mockProUser(overrides: Partial<MockUser> = {}): MockUser {
  return mockUser({
    plan: 'pro',
    subscriptionStatus: 'active',
    stripeCustomerId: 'cus_test_pro',
    subscriptionId: 'sub_test_pro',
    priceLockedAt: new Date(),
    ...overrides,
  });
}

/** Enterprise plan user factory (BYOK, unlimited). */
export function mockEnterpriseUser(overrides: Partial<MockUser> = {}): MockUser {
  return mockUser({
    plan: 'enterprise',
    subscriptionStatus: 'active',
    stripeCustomerId: 'cus_test_enterprise',
    subscriptionId: 'sub_test_enterprise',
    priceLockedAt: new Date(),
    ...overrides,
  });
}

/** Trial user with 7 days remaining. */
export function mockTrialUser(overrides: Partial<MockUser> = {}): MockUser {
  const now = new Date();
  const sevenDaysFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  return mockUser({
    plan: 'trial',
    subscriptionStatus: 'trialing',
    trialStartedAt: now,
    trialEndsAt: sevenDaysFromNow,
    ...overrides,
  });
}
