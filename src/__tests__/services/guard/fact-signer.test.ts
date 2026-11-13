// @vitest-environment node
/**
 * 服务端签发端 fact-signer 与来源函数清单（ADR 0046 §11 D5 第 2 项；§11.7 裁定 2、7、8）。
 *
 * 签发端只接受 `{ path, source, args }`，值一律由清单里的来源函数在服务端取得；签名前与 action 对应路径的值
 * 做 JCS 字节比对，不等即丢弃该 claim（永不发出会被 aster-api 以 claim_mismatch 拒绝的事实）。
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { loadBusinessRoles } = vi.hoisted(() => ({ loadBusinessRoles: vi.fn() }));
vi.mock('@/lib/business-roles', () => ({ loadBusinessRoles }));

import { factSourcesFor, pathAllowed } from '@/config/fact-sources';
import { jcsCanonicalize } from '@/lib/jcs';
import type { FactSigningKey } from '@/services/guard/fact-signing-key';
import { FACT_TTL_MS, FactSignerError, signFacts } from '@/services/guard/fact-signer';
import type { GuardAction } from '@/services/policy/guard-types';

const NOW = new Date('2026-11-13T00:00:00.000Z');
const TENANT = 'team-1';
const USER = 'user-1';

let key: FactSigningKey;
let verifyKey: CryptoKey;

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const publicKey = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('base64url');
  key = { issuer: 'aster-cloud', kid: 'k-test', publicKey, privateKey: pair.privateKey };
  verifyKey = pair.publicKey;
});

beforeEach(() => {
  loadBusinessRoles.mockReset();
  loadBusinessRoles.mockResolvedValue(['Credit Officer', 'DPO']);
});

function action(over: Partial<GuardAction> = {}): GuardAction {
  return {
    principal: { id: USER, type: 'user', roles: ['Credit Officer', 'DPO'] },
    action: { name: 'decide' },
    resource: { type: '', id: '' },
    context: { amount: 1 },
    ...over,
  };
}

function run(requests: unknown[], act: GuardAction = action(), tenantId = TENANT) {
  return signFacts({
    ctx: { tenantId, userId: USER, input: (act.context ?? {}) as Record<string, unknown> },
    requests,
    action: act,
    key,
    sources: factSourcesFor(tenantId, 'test'),
    now: NOW,
  });
}

async function rejection(p: Promise<unknown>): Promise<FactSignerError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(FactSignerError);
  return err as FactSignerError;
}

describe('signFacts — 请求校验（签发端不接受原值）', () => {
  it('valueKeyIsClaimsNotAllowed', async () => {
    const err = await rejection(run([{ path: 'principal.id', source: 'hmac.userId', value: 'x' }]));
    expect(err.code).toBe('claims_not_allowed');
    expect(err.path).toBe('principal.id');
    expect(err.status).toBe(400);
  });

  it('claims 键同样是 claims_not_allowed', async () => {
    const err = await rejection(run([{ path: 'principal.id', source: 'hmac.userId', claims: { 'principal.id': 'x' } }]));
    expect(err.code).toBe('claims_not_allowed');
  });

  it('unknownSourceRejected', async () => {
    const err = await rejection(run([{ path: 'principal.id', source: 'catalog.piiMark' }]));
    expect(err.code).toBe('unknown_fact_source');
    expect(err.path).toBe('principal.id');
  });

  it('pathOutsideAllowedPathsRejected', async () => {
    const err = await rejection(run([{ path: 'context.amount', source: 'hmac.userId' }]));
    expect(err.code).toBe('path_not_allowed');
    expect(err.path).toBe('context.amount');
  });

  it('moreThan64RequestsRejected', async () => {
    const requests = Array.from({ length: 65 }, (_, i) => ({ path: `principal.x${i}`, source: 'hmac.userId' }));
    const err = await rejection(run(requests));
    expect(err.code).toBe('invalid_fact_request');
  });

  it.each([
    ['不是数组', { path: 'principal.id', source: 'hmac.userId' }],
    ['项不是对象', ['principal.id']],
    ['多余键', [{ path: 'principal.id', source: 'hmac.userId', extra: 1 }]],
    ['path 为空', [{ path: '', source: 'hmac.userId' }]],
    ['path 超过 128 字符', [{ path: `context.${'a'.repeat(121)}`, source: 'hmac.userId' }]],
    ['source 不是字符串', [{ path: 'principal.id', source: 1 }]],
    ['args 不是对象', [{ path: 'principal.id', source: 'hmac.userId', args: [] }]],
    ['path 重复', [{ path: 'principal.id', source: 'hmac.userId' }, { path: 'principal.id', source: 'hmac.userId' }]],
  ])('畸形请求（%s）→ invalid_fact_request', async (_label, requests) => {
    const err = await rejection(run(requests as unknown[]));
    expect(err.code).toBe('invalid_fact_request');
  });

  it('任一项不合规时整体拒绝，不调用任何来源函数', async () => {
    await rejection(run([{ path: 'principal.roles', source: 'idp.businessRoles' }, { path: 'x', source: 'nope' }]));
    expect(loadBusinessRoles).not.toHaveBeenCalled();
  });
});

describe('signFacts — 签名载荷', () => {
  it('signedPayloadExactJcsBytes', async () => {
    const { fact, skipped } = await run([{ path: 'principal.id', source: 'hmac.userId' }]);

    expect(skipped).toEqual([]);
    expect(fact).not.toBeNull();
    const { signature, ...payload } = fact!;
    const expected =
      '{"alg":"Ed25519","audience":"team-1","claims":{"principal.id":"user-1"},' +
      '"expiresAt":"2026-11-13T00:10:00.000Z","issuedAt":"2026-11-13T00:00:00.000Z",' +
      '"issuer":"aster-cloud","kid":"k-test","sources":{"principal.id":"hmac.userId"}}';
    expect(jcsCanonicalize(payload)).toBe(expected);
    expect(Object.keys(fact!).sort()).toEqual(
      ['alg', 'audience', 'claims', 'expiresAt', 'issuedAt', 'issuer', 'kid', 'signature', 'sources'],
    );
    // base64url 无填充、64 字节
    expect(signature).toMatch(/^[A-Za-z0-9_-]{86}$/);
    const raw = Buffer.from(signature, 'base64url');
    expect(raw.length).toBe(64);
    const ok = await crypto.subtle.verify({ name: 'Ed25519' }, verifyKey, raw, new TextEncoder().encode(expected));
    expect(ok).toBe(true);
    expect(Date.parse(fact!.expiresAt) - Date.parse(fact!.issuedAt)).toBe(FACT_TTL_MS);
  });

  it('sourcesMatchClaimsKeySet', async () => {
    const { fact } = await run([
      { path: 'principal.id', source: 'hmac.userId' },
      { path: 'principal.roles', source: 'idp.businessRoles' },
    ]);
    expect(Object.keys(fact!.claims).sort()).toEqual(['principal.id', 'principal.roles']);
    expect(Object.keys(fact!.sources).sort()).toEqual(Object.keys(fact!.claims).sort());
    expect(fact!.sources).toEqual({ 'principal.id': 'hmac.userId', 'principal.roles': 'idp.businessRoles' });
    expect(fact!.claims['principal.roles']).toEqual(['Credit Officer', 'DPO']);
    expect(loadBusinessRoles).toHaveBeenCalledWith(USER, TENANT);
  });

  it('audience 恒为租户 id', async () => {
    const { fact } = await run([{ path: 'principal.id', source: 'hmac.userId' }], action(), 'other-tenant');
    expect(fact!.audience).toBe('other-tenant');
  });
});

describe('signFacts — 与 action 比对', () => {
  it('mismatchingClaimIsDroppedBeforeSigning', async () => {
    // 执行人在输入里自报的 principal_roles 与已登记业务角色不同：只丢该 claim，其余照签
    const act = action({ principal: { id: USER, type: 'user', roles: ['Chief Risk Officer'] } });
    const { fact, skipped } = await run(
      [{ path: 'principal.id', source: 'hmac.userId' }, { path: 'principal.roles', source: 'idp.businessRoles' }],
      act,
    );
    expect(skipped).toEqual([{ path: 'principal.roles', reason: 'value_mismatch' }]);
    expect(fact!.claims).toEqual({ 'principal.id': USER });
    expect(fact!.sources).toEqual({ 'principal.id': 'hmac.userId' });
  });

  it('rolesInDifferentOrderAreDropped', async () => {
    const act = action({ principal: { id: USER, type: 'user', roles: ['DPO', 'Credit Officer'] } });
    const { fact, skipped } = await run([{ path: 'principal.roles', source: 'idp.businessRoles' }], act);
    expect(skipped).toEqual([{ path: 'principal.roles', reason: 'value_mismatch' }]);
    expect(fact).toBeNull();
  });

  it('allDroppedYieldsNullFact', async () => {
    const act = action({ principal: { id: 'someone-else', type: 'user', roles: [] } });
    const { fact, skipped } = await run(
      [{ path: 'principal.id', source: 'hmac.userId' }, { path: 'principal.roles', source: 'idp.businessRoles' }],
      act,
    );
    expect(fact).toBeNull();
    expect(skipped.map((s) => s.reason)).toEqual(['value_mismatch', 'value_mismatch']);
  });

  it('路径在 action 中不存在 → value_mismatch', async () => {
    const act = { principal: { id: USER, type: 'user' }, action: { name: 'decide' } } as GuardAction;
    const { fact, skipped } = await run([{ path: 'principal.roles', source: 'idp.businessRoles' }], act);
    expect(fact).toBeNull();
    expect(skipped).toEqual([{ path: 'principal.roles', reason: 'value_mismatch' }]);
  });

  it('来源函数取不到值（或抛错）→ unresolved', async () => {
    loadBusinessRoles.mockRejectedValueOnce(new Error('db down'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { fact, skipped } = await run([{ path: 'principal.roles', source: 'idp.businessRoles' }]);
    expect(fact).toBeNull();
    expect(skipped).toEqual([{ path: 'principal.roles', reason: 'unresolved' }]);
    err.mockRestore();
  });

  it('dottedKeyCollisionIsDroppedAsAmbiguous', async () => {
    const applicant = { creditScore: 760, monthlyIncome: 9000, monthlyDebt: 2000, requestedAmount: 60000, activeDefaults: 0 };
    const act = action({ context: { applicant, 'applicant.x': 1 } });
    const { fact, skipped } = await signFacts({
      ctx: { tenantId: 'credit-pilot', userId: USER, input: act.context as Record<string, unknown> },
      requests: [{ path: 'context.applicant', source: 'fixture.creditPilot' }],
      action: act,
      key,
      sources: factSourcesFor('credit-pilot', 'test'),
      now: NOW,
    });
    expect(fact).toBeNull();
    expect(skipped).toEqual([{ path: 'context.applicant', reason: 'ambiguous_path' }]);
  });

  it('上层对象里的点号键与 claim 路径相撞同样是 ambiguous_path', async () => {
    const act = action({ principal: { id: USER, type: 'user', roles: [] }, 'principal.id': USER } as unknown as GuardAction);
    const { skipped } = await run([{ path: 'principal.id', source: 'hmac.userId' }], act);
    expect(skipped).toEqual([{ path: 'principal.id', reason: 'ambiguous_path' }]);
  });
});

describe('fact-sources 清单', () => {
  it('第一期三项；catalog.piiMark 不在清单（裁定 2）', () => {
    expect([...factSourcesFor('credit-pilot', 'test').keys()].sort()).toEqual(
      ['fixture.creditPilot', 'hmac.userId', 'idp.businessRoles'],
    );
    expect(factSourcesFor('team-1', 'test').has('catalog.piiMark')).toBe(false);
  });

  it('fixtureSourceAbsentInProduction', () => {
    expect(factSourcesFor('credit-pilot', 'production').has('fixture.creditPilot')).toBe(false);
    expect([...factSourcesFor('credit-pilot', 'production').keys()].sort()).toEqual(['hmac.userId', 'idp.businessRoles']);
  });

  it('fixtureSourceOnlyForCreditPilotTenant', () => {
    expect(factSourcesFor('team-1', 'development').has('fixture.creditPilot')).toBe(false);
    expect(factSourcesFor('credit-pilot', 'development').has('fixture.creditPilot')).toBe(true);
  });

  it('pathAllowed：精确路径或 .* 之下的更深路径', () => {
    expect(pathAllowed(['principal.id'], 'principal.id')).toBe(true);
    expect(pathAllowed(['principal.id'], 'principal.idx')).toBe(false);
    expect(pathAllowed(['context.*'], 'context.applicant')).toBe(true);
    expect(pathAllowed(['context.*'], 'context.applicant.creditScore')).toBe(true);
    expect(pathAllowed(['context.*'], 'context')).toBe(false);
    expect(pathAllowed(['context.*'], 'contextual.x')).toBe(false);
  });
});
