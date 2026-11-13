// @vitest-environment node
/**
 * from-evidence 附签名事实的计划与判定（ADR 0046 §11.6 第 11 条；§11.7 裁定 6、7）。
 *
 * 只有本租户在 aster-api 登记了与 cloud 密钥相同的 issuer#kid、已启用、且 notAfter 晚于 now + TTL 时才附；
 * 其余任何情况（无密钥、未登记 / 已吊销 / 将过期、listFactIssuers 失败、没有可签的 claim）原样返回 action（同一引用）。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { loadBusinessRoles } = vi.hoisted(() => ({ loadBusinessRoles: vi.fn() }));
vi.mock('@/lib/business-roles', () => ({ loadBusinessRoles }));

import { factSourcesFor } from '@/config/fact-sources';
import { attachFacts, cloudIssuerUsable, planFactRequests } from '@/services/guard/fact-plan';
import { FACT_TTL_MS } from '@/services/guard/fact-signer';
import { loadFactSigningKey, resetFactSigningKeyCacheForTests, type FactSigningKey } from '@/services/guard/fact-signing-key';
import type { GuardAction, GuardFactIssuer } from '@/services/policy/guard-types';
import { PolicyApiError, type PolicyApiClient } from '@/services/policy/policy-api';

const NOW = new Date('2026-11-13T00:00:00.000Z');
let secret: string;
let key: FactSigningKey;

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const privateKey = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64');
  const publicKey = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('base64url');
  secret = JSON.stringify({ issuer: 'aster-cloud', kid: 'k-test', privateKey, publicKey });
  key = (await loadFactSigningKey(secret))!;
});

function issuer(over: Partial<GuardFactIssuer> = {}): GuardFactIssuer {
  return {
    alg: 'Ed25519', createdAt: '2026-11-01T00:00:00Z', createdBy: 'owner', enabled: true,
    issuer: key.issuer, kid: key.kid, publicKey: key.publicKey, ...over,
  };
}

function action(over: Partial<GuardAction> = {}): GuardAction {
  return {
    principal: { id: 'user-1', type: 'user', roles: [] },
    action: { name: 'decide' },
    resource: { type: '', id: '' },
    context: { amount: 1 },
    ...over,
  };
}

const ctx = { tenantId: 'team-1', userId: 'user-1', input: { amount: 1 } };
const listFactIssuers = vi.fn();
const client = { listFactIssuers } as unknown as PolicyApiClient;

describe('planFactRequests', () => {
  it('user 主体 → principal.id；roles 非空才签 principal.roles', () => {
    const sources = factSourcesFor('team-1', 'test');
    expect(planFactRequests(action(), sources)).toEqual([{ path: 'principal.id', source: 'hmac.userId' }]);
    expect(planFactRequests(action({ principal: { id: 'u', type: 'user', roles: ['DPO'] } }), sources)).toEqual([
      { path: 'principal.id', source: 'hmac.userId' },
      { path: 'principal.roles', source: 'idp.businessRoles' },
    ]);
  });

  it('非 user 主体不签 principal.id', () => {
    expect(planFactRequests(action({ principal: { id: 'svc', type: 'service', roles: [] } }), factSourcesFor('t', 'test'))).toEqual([]);
  });

  it('credit-pilot（非生产）且 context.applicant 存在 → 追加 context.applicant', () => {
    const act = action({ context: { applicant: { creditScore: 1 } } });
    expect(planFactRequests(act, factSourcesFor('credit-pilot', 'test'))).toContainEqual({
      path: 'context.applicant', source: 'fixture.creditPilot',
    });
    expect(planFactRequests(act, factSourcesFor('credit-pilot', 'production'))).not.toContainEqual(
      expect.objectContaining({ path: 'context.applicant' }),
    );
  });
});

describe('cloudIssuerUsable', () => {
  it('同 issuer#kid、已启用、公钥一致、无 notAfter → 可用', () => {
    expect(cloudIssuerUsable([issuer()], key, NOW)).toBe(true);
  });

  it.each([
    ['未登记', () => []],
    ['只有别的 kid', () => [issuer({ kid: 'other' })]],
    ['已吊销', () => [issuer({ enabled: false })]],
    ['公钥不同（换过密钥未重新启用）', () => [issuer({ publicKey: 'A'.repeat(43) })]],
    ['notAfter 恰为 now + TTL', () => [issuer({ notAfter: new Date(NOW.getTime() + FACT_TTL_MS).toISOString() })]],
  ])('%s → 不可用', (_label, issuers) => {
    expect(cloudIssuerUsable(issuers(), key, NOW)).toBe(false);
  });

  it('notAfter 晚于 now + TTL → 可用', () => {
    const later = new Date(NOW.getTime() + FACT_TTL_MS + 1000).toISOString();
    expect(cloudIssuerUsable([issuer({ notAfter: later })], key, NOW)).toBe(true);
  });
});

describe('attachFacts', () => {
  beforeEach(() => {
    resetFactSigningKeyCacheForTests();
    listFactIssuers.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('noFactsWhenSigningKeyMissing：原样返回同一引用，不查签发方', async () => {
    vi.stubEnv('ASTER_FACT_SIGNING_KEY', '');
    const act = action();
    await expect(attachFacts(client, act, ctx, NOW)).resolves.toBe(act);
    expect(listFactIssuers).not.toHaveBeenCalled();
  });

  it('noFactsWhenCloudIssuerNotEnabled', async () => {
    vi.stubEnv('ASTER_FACT_SIGNING_KEY', secret);
    listFactIssuers.mockResolvedValue({ issuers: [issuer({ enabled: false })] });
    const act = action();
    await expect(attachFacts(client, act, ctx, NOW)).resolves.toBe(act);
  });

  it('noFactsWhenIssuerExpiresWithinTtl', async () => {
    vi.stubEnv('ASTER_FACT_SIGNING_KEY', secret);
    listFactIssuers.mockResolvedValue({ issuers: [issuer({ notAfter: new Date(NOW.getTime() + 60_000).toISOString() })] });
    const act = action();
    await expect(attachFacts(client, act, ctx, NOW)).resolves.toBe(act);
  });

  it('noFactsWhenListIssuersFails', async () => {
    vi.stubEnv('ASTER_FACT_SIGNING_KEY', secret);
    listFactIssuers.mockRejectedValue(new PolicyApiError('down', 503, 'service_unavailable'));
    const act = action();
    await expect(attachFacts(client, act, ctx, NOW)).resolves.toBe(act);
  });

  it('没有可签的 claim（主体 id 与发起人不同）→ 原样返回', async () => {
    vi.stubEnv('ASTER_FACT_SIGNING_KEY', secret);
    listFactIssuers.mockResolvedValue({ issuers: [issuer()] });
    const act = action({ principal: { id: 'someone-else', type: 'user', roles: [] } });
    await expect(attachFacts(client, act, ctx, NOW)).resolves.toBe(act);
  });

  it('attachesOneFactWithPrincipalId', async () => {
    vi.stubEnv('ASTER_FACT_SIGNING_KEY', secret);
    listFactIssuers.mockResolvedValue({ issuers: [issuer({ kid: 'other' }), issuer()] });
    const act = action();
    const out = await attachFacts(client, act, ctx, NOW);

    expect(out).not.toBe(act);
    expect(act).not.toHaveProperty('facts');
    const { facts, ...rest } = out;
    expect(rest).toEqual(act);
    expect(facts).toHaveLength(1);
    expect(facts![0]).toMatchObject({
      alg: 'Ed25519', audience: 'team-1', issuer: 'aster-cloud', kid: 'k-test',
      claims: { 'principal.id': 'user-1' }, sources: { 'principal.id': 'hmac.userId' },
    });
  });
});
