// @vitest-environment node
/**
 * 信贷试点 fixture 来源（ADR 0046 §11 D5 第 2(c) 项；§11.7 更正第 6 条）：请求体里的 applicant 只用来选出
 * 哪一组 fixture（JCS 字节相等），claim 值取自常量本身；与任何一组都不相等时不签。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/business-roles', () => ({ loadBusinessRoles: vi.fn() }));

import { PILOT_APPLICANTS } from '@/config/credit-pilot-source';
import { factSourcesFor } from '@/config/fact-sources';
import { signFacts } from '@/services/guard/fact-signer';
import type { GuardAction } from '@/services/policy/guard-types';

const source = factSourcesFor('credit-pilot', 'test').get('fixture.creditPilot')!;
const ctxFor = (applicant: unknown) => ({ tenantId: 'credit-pilot', userId: 'cp-owner', input: { applicant } });

describe('fixture.creditPilot', () => {
  it('fixtureApplicantSignedFromConstant', async () => {
    const copy = JSON.parse(JSON.stringify(PILOT_APPLICANTS.requireApproval));
    expect(copy).not.toBe(PILOT_APPLICANTS.requireApproval);
    await expect(source.resolve(ctxFor(copy), 'context.applicant', {})).resolves.toBe(PILOT_APPLICANTS.requireApproval);

    const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const action: GuardAction = { principal: { id: 'cp-owner', type: 'user', roles: [] }, action: { name: 'decide' }, context: { applicant: copy } };
    const { fact } = await signFacts({
      ctx: ctxFor(copy),
      requests: [{ path: 'context.applicant', source: 'fixture.creditPilot' }],
      action,
      key: { issuer: 'aster-cloud', kid: 'k', publicKey: 'x', privateKey: pair.privateKey },
      sources: factSourcesFor('credit-pilot', 'test'),
      now: new Date('2026-11-13T00:00:00Z'),
    });
    expect(fact!.claims['context.applicant']).toBe(PILOT_APPLICANTS.requireApproval);
    expect(fact!.sources).toEqual({ 'context.applicant': 'fixture.creditPilot' });
  });

  it('键序不同但值相等仍选中同一组（JCS 比对）', async () => {
    const { activeDefaults, ...rest } = PILOT_APPLICANTS.deny;
    await expect(source.resolve(ctxFor({ activeDefaults, ...rest }), 'context.applicant', {})).resolves.toBe(PILOT_APPLICANTS.deny);
  });

  it('nonFixtureApplicantIsNotSigned', async () => {
    const applicant = { ...PILOT_APPLICANTS.requireApproval, requestedAmount: PILOT_APPLICANTS.requireApproval.requestedAmount + 1 };
    await expect(source.resolve(ctxFor(applicant), 'context.applicant', {})).resolves.toBeUndefined();
  });

  it('多一个字段、缺字段、非对象均不签', async () => {
    await expect(source.resolve(ctxFor({ ...PILOT_APPLICANTS.allow, extra: 1 }), 'context.applicant', {})).resolves.toBeUndefined();
    const { creditScore: _c, ...missing } = PILOT_APPLICANTS.allow;
    await expect(source.resolve(ctxFor(missing), 'context.applicant', {})).resolves.toBeUndefined();
    await expect(source.resolve(ctxFor('allow'), 'context.applicant', {})).resolves.toBeUndefined();
    await expect(source.resolve(ctxFor(undefined), 'context.applicant', {})).resolves.toBeUndefined();
  });

  it('只对 context.applicant 取值', async () => {
    await expect(source.resolve(ctxFor(PILOT_APPLICANTS.allow), 'context.applicant.creditScore', {})).resolves.toBeUndefined();
  });
});
