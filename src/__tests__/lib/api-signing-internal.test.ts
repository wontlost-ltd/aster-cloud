import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac, createHash } from 'node:crypto';
import {
  hmacSha256,
  joinBusinessRoles,
  sha256Hex,
  signInternalCallerHeaders,
  signRunnerLauncherHeaders,
} from '@/lib/api-signing';

const KEY = 'test-internal-caller-secret-32chars';

// 与后端 InternalCallerFilter 逐字节一致的 canonical v3 重算（ADR 0042 §4.1）：
//   method\npath\nquery\nts\nnonce\nbodySha256\ntenant\nrole\nuserId\nbusinessRoles
function expectedSig(
  method: string,
  path: string,
  ts: string,
  nonce: string,
  body: string | undefined,
  tenant: string,
  role: string,
  identity: { query?: string; userId?: string; roles?: string } = {},
  key: string = KEY,
): string {
  const bodyHash = createHash('sha256')
    .update(body ? Buffer.from(body, 'utf8') : Buffer.alloc(0))
    .digest('hex');
  const canonical = [
    method, path, identity.query ?? '', ts, nonce, bodyHash, tenant, role,
    identity.userId ?? '', identity.roles ?? '',
  ].join('\n');
  return createHmac('sha256', key).update(canonical).digest('hex');
}

describe('signInternalCallerHeaders (红队 P0-C 加固)', () => {
  const originalKey = process.env.ASTER_PLAN_GATE_HMAC_KEY;

  beforeEach(() => {
    process.env.ASTER_PLAN_GATE_HMAC_KEY = KEY;
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.ASTER_PLAN_GATE_HMAC_KEY;
    else process.env.ASTER_PLAN_GATE_HMAC_KEY = originalKey;
  });

  it('返回 cloud-bff 头 + nonce + ts + 签名', async () => {
    const h = await signInternalCallerHeaders('POST', '/api/v1/policies/evaluate-source');
    expect(h['X-Internal-Caller']).toBe('cloud-bff');
    expect(h['X-Aster-Timestamp']).toMatch(/^\d+$/);
    expect(h['X-Aster-Nonce']).toMatch(/^[0-9a-f]{32}$/);
    expect(h['X-Internal-Signature']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('签名与后端 canonical v3 基线一致（含 body/tenant/role，query/userId/roles 缺省为空）', async () => {
    const path = '/api/v1/ai/complete';
    const body = '{"model":"cheap","prompt":"hi"}';
    const tenant = 'tenant-42';
    const role = 'MEMBER';
    const h = await signInternalCallerHeaders('POST', path, body, tenant, role);
    const expected = expectedSig(
      'POST', path, h['X-Aster-Timestamp'], h['X-Aster-Nonce'], body, tenant, role,
    );
    expect(h['X-Internal-Signature']).toBe(expected);
  });

  it('空 body/tenant/role 时按空字符串签（与后端一致）', async () => {
    const path = '/api/v1/policies/evaluate-source';
    const h = await signInternalCallerHeaders('POST', path);
    const expected = expectedSig(
      'POST', path, h['X-Aster-Timestamp'], h['X-Aster-Nonce'], undefined, '', '',
    );
    expect(h['X-Internal-Signature']).toBe(expected);
  });

  it('改 body → 签名变（防换 LLM model 烧预算）', async () => {
    const path = '/api/v1/ai/complete';
    const a = await signInternalCallerHeaders('POST', path, '{"model":"cheap"}', 't', '');
    // 相同 ts/nonce 不可控，故用基线重算隔离 body 变量
    const sigCheap = expectedSig('POST', path, a['X-Aster-Timestamp'], a['X-Aster-Nonce'], '{"model":"cheap"}', 't', '');
    const sigPricey = expectedSig('POST', path, a['X-Aster-Timestamp'], a['X-Aster-Nonce'], '{"model":"pricey"}', 't', '');
    expect(a['X-Internal-Signature']).toBe(sigCheap);
    expect(sigCheap).not.toBe(sigPricey);
  });

  it('改 tenant → 签名变（防跨租户假冒）', async () => {
    const path = '/api/v1/policies/evaluate-source';
    const h = await signInternalCallerHeaders('POST', path, 'body', 'tenant-a', '');
    const sameTenant = expectedSig('POST', path, h['X-Aster-Timestamp'], h['X-Aster-Nonce'], 'body', 'tenant-a', '');
    const otherTenant = expectedSig('POST', path, h['X-Aster-Timestamp'], h['X-Aster-Nonce'], 'body', 'tenant-b', '');
    expect(h['X-Internal-Signature']).toBe(sameTenant);
    expect(sameTenant).not.toBe(otherTenant);
  });

  it('改 role → 签名变（防提权）', async () => {
    const path = '/api/v1/policies/evaluate-source';
    const h = await signInternalCallerHeaders('POST', path, 'body', 't', 'MEMBER');
    const asMember = expectedSig('POST', path, h['X-Aster-Timestamp'], h['X-Aster-Nonce'], 'body', 't', 'MEMBER');
    const asAdmin = expectedSig('POST', path, h['X-Aster-Timestamp'], h['X-Aster-Nonce'], 'body', 't', 'ADMIN');
    expect(h['X-Internal-Signature']).toBe(asMember);
    expect(asMember).not.toBe(asAdmin);
  });

  it('每次 nonce 唯一（防重放）', async () => {
    const a = await signInternalCallerHeaders('POST', '/x');
    const b = await signInternalCallerHeaders('POST', '/x');
    expect(a['X-Aster-Nonce']).not.toBe(b['X-Aster-Nonce']);
    expect(a['X-Internal-Signature']).not.toBe(b['X-Internal-Signature']);
  });

  it('不同 path → 不同签名', async () => {
    const a = await signInternalCallerHeaders('POST', '/path/a');
    const b = await signInternalCallerHeaders('POST', '/path/b');
    expect(a['X-Internal-Signature']).not.toBe(b['X-Internal-Signature']);
  });

  describe('canonical v3 固定向量（ADR 0042 §4.1）', () => {
    const TS_MS = 1_760_000_000_123;
    const NONCE = 'ab'.repeat(16);

    beforeEach(() => {
      vi.spyOn(Date, 'now').mockReturnValue(TS_MS);
      vi.spyOn(crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(arr: T): T => {
        (arr as unknown as Uint8Array).fill(0xab);
        return arr;
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('签入 query / userId / 排序去重后的业务角色，头值同 canonical', async () => {
      const h = await signInternalCallerHeaders('GET', '/api/v1/guard/approvals', undefined, 'team1', 'member', {
        query: 'status=PENDING&page=0&size=50',
        userId: 'u-1',
        businessRoles: ['DPO', ' CISO ', 'DPO', ''],
      });
      const emptyHash = await sha256Hex(new Uint8Array(0).buffer as ArrayBuffer);
      const canonical =
        `GET\n/api/v1/guard/approvals\nstatus=PENDING&page=0&size=50\n1760000000\n${NONCE}\n${emptyHash}` +
        '\nteam1\nmember\nu-1\nCISO,DPO';
      expect(h['X-Aster-Timestamp']).toBe('1760000000');
      expect(h['X-Aster-Nonce']).toBe(NONCE);
      expect(h['X-Internal-Signature']).toBe(await hmacSha256(KEY, canonical));
      expect(h['X-User-Business-Roles']).toBe('CISO,DPO');
    });

    it('角色按 UTF-16 码元排序（同 Java String.compareTo，非 localeCompare）', async () => {
      expect(joinBusinessRoles(['b', 'B', 'a'])).toBe('B,a,b');
      const h = await signInternalCallerHeaders('GET', '/x', '', 't', 'r', { businessRoles: ['b', 'B', 'a'] });
      const emptyHash = await sha256Hex(new Uint8Array(0).buffer as ArrayBuffer);
      const canonical = `GET\n/x\n\n1760000000\n${NONCE}\n${emptyHash}\nt\nr\n\nB,a,b`;
      expect(h['X-Internal-Signature']).toBe(await hmacSha256(KEY, canonical));
      expect(h['X-User-Business-Roles']).toBe('B,a,b');
    });

    it('无业务角色：不发 X-User-Business-Roles，canonical 末行为空串', async () => {
      const h = await signInternalCallerHeaders('GET', '/x', '', 't', 'r', { query: '', userId: '' });
      const emptyHash = await sha256Hex(new Uint8Array(0).buffer as ArrayBuffer);
      const canonical = `GET\n/x\n\n1760000000\n${NONCE}\n${emptyHash}\nt\nr\n\n`;
      expect(h['X-Internal-Signature']).toBe(await hmacSha256(KEY, canonical));
      expect(h).not.toHaveProperty('X-User-Business-Roles');
    });
  });

  it('改 query / userId / 角色 → 签名变（防改写查询与冒充审批人）', async () => {
    const path = '/api/v1/guard/approvals';
    const id = { query: 'status=PENDING', userId: 'u-1', businessRoles: ['CISO'] };
    const h = await signInternalCallerHeaders('GET', path, '', 't', 'member', id);
    const ts = h['X-Aster-Timestamp'];
    const nonce = h['X-Aster-Nonce'];
    const base = { query: 'status=PENDING', userId: 'u-1', roles: 'CISO' };
    expect(h['X-Internal-Signature']).toBe(expectedSig('GET', path, ts, nonce, '', 't', 'member', base));
    for (const tampered of [
      { ...base, query: 'status=APPROVED' },
      { ...base, userId: 'u-2' },
      { ...base, roles: 'CISO,DPO' },
    ]) {
      expect(h['X-Internal-Signature']).not.toBe(expectedSig('GET', path, ts, nonce, '', 't', 'member', tampered));
    }
  });

  it('缺 key 时抛错', async () => {
    delete process.env.ASTER_PLAN_GATE_HMAC_KEY;
    await expect(signInternalCallerHeaders('POST', '/x')).rejects.toThrow(
      /ASTER_PLAN_GATE_HMAC_KEY/
    );
  });

  it('timestamp 是 unix 秒', async () => {
    const before = Math.floor(Date.now() / 1000);
    const h = await signInternalCallerHeaders('POST', '/x');
    const after = Math.floor(Date.now() / 1000);
    const ts = parseInt(h['X-Aster-Timestamp'], 10);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after + 1);
  });
});

describe('signRunnerLauncherHeaders', () => {
  beforeEach(() => { process.env.ASTER_RUNNER_LAUNCHER_HMAC_KEY = 'test-launcher-key'; });

  it('独立 key 签名 + cloud-runner-launcher caller', async () => {
    const headers = await signRunnerLauncherHeaders(
      'POST', '/api/v1/runner/launch', '{"tenantId":"t1"}', 't1', 'ADMIN');
    expect(headers['X-Internal-Caller']).toBe('cloud-runner-launcher');
    expect(headers['X-Internal-Signature']).toMatch(/^[a-f0-9]{64}$/); // sha256 hex
    expect(headers['X-Aster-Timestamp']).toMatch(/^\d+$/);
    expect(headers['X-Aster-Nonce']).toBeTruthy();
  });

  it('签名使用 canonical v3（query/userId/businessRoles 为空串）', async () => {
    const body = '{"tenantId":"t1"}';
    const h = await signRunnerLauncherHeaders('POST', '/api/v1/runner/launch', body, 't1', 'ADMIN');
    expect(h['X-Internal-Signature']).toBe(
      expectedSig('POST', '/api/v1/runner/launch', h['X-Aster-Timestamp'], h['X-Aster-Nonce'], body, 't1', 'ADMIN', {},
        'test-launcher-key'),
    );
  });

  it('缺 key → 抛（不静默）', async () => {
    delete process.env.ASTER_RUNNER_LAUNCHER_HMAC_KEY;
    await expect(signRunnerLauncherHeaders('POST', '/p', 'b', 't', 'r')).rejects.toThrow('ASTER_RUNNER_LAUNCHER_HMAC_KEY');
  });

  it('tenant/role 放 header（供接收端重建 canonical）', async () => {
    const h = await signRunnerLauncherHeaders('POST', '/p', 'b', 'tenant-x', 'ADMIN');
    expect(h['X-Aster-Tenant']).toBe('tenant-x');
    expect(h['X-Aster-Role']).toBe('ADMIN');
  });
  // ★「独立 key 真隔离」由 Task 4b stub 测试证明（错 key 签名被真 key 的 stub 拒 4xx）——
  //   比在此处比对两次调用的签名更可靠（后者 nonce/timestamp 每次不同，无法单独归因于 key）。
});
