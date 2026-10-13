import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac, createHash } from 'node:crypto';

/**
 * 内存版 UsedNonce：语义与真表一致——nonce 唯一，过期由清理任务按 expiresAt < now 删除。
 * 唯一约束与分批删除本身由真 Postgres 集成测试覆盖（nonce-service.saas.integration.test.ts）。
 */
const store = vi.hoisted(() => {
  const rows = new Map<string, Date>();
  return {
    rows,
    claimNonce: vi.fn(async (nonce: string, expiresAt: Date) => {
      if (rows.has(nonce)) return false;
      rows.set(nonce, expiresAt);
      return true;
    }),
    cleanup(now: Date) {
      for (const [n, exp] of rows) if (exp < now) rows.delete(n);
    },
  };
});
vi.mock('@/services/security/nonce-service', () => ({ claimNonce: store.claimNonce }));

import { verifyInternalSignature, nonceExpiresAt } from '../internal-signature';

beforeEach(() => {
  store.rows.clear();
  store.claimNonce.mockClear();
});

/**
 * `/api/internal/*` 入站验签契约（2026-07-29 审计修复）。
 *
 * 缺陷：8 个内部路由各自手写验签，canonical 一律 `method\npath\ntimestamp`
 * ——不绑定 body、不绑定 query、无 nonce。攻击者拿到任意一次签名（代理日志、
 * SSRF、镜像流量），即可在 300s 窗口内**换掉 body 无限重放**：打
 * /api/internal/api/usage 可为任意 userId 伪造用量、篡改计费归属。
 *
 * 出站签名器早已加固为多字段 canonical——加固只做了发送侧，接收侧从未同步。
 */

const SECRET = 'test-secret-key';
const PATH = '/api/internal/api/usage';
const BODY = '{"userId":"u1"}';

const sha256Hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const hmacHex = (data: string) => createHmac('sha256', SECRET).update(data, 'utf8').digest('hex');
const now = () => Math.floor(Date.now() / 1000);

function makeReq(headers: Record<string, string>, body = BODY, method = 'POST') {
  return new Request(`https://x.test${PATH}`, {
    method,
    body: method === 'GET' ? undefined : body,
    headers,
  });
}

/** v2：method\npath\nts\nnonce\nbodyHash —— 与 Java InternalCallSigner 逐字对齐 */
function v2(ts: number, nonce: string, body: string) {
  return hmacHex(`POST\n${PATH}\n${ts}\n${nonce}\n${sha256Hex(body)}`);
}
/** v1（旧）：method\npath\nts */
const v1 = (ts: number) => hmacHex(`POST\n${PATH}\n${ts}`);

describe('verifyInternalSignature', () => {
  it('v2 签名通过，且标记 usedLegacyCanonical=false', async () => {
    const ts = now(), nonce = 'n-1';
    const r = await verifyInternalSignature(
      makeReq({ 'X-Aster-Timestamp': String(ts), 'X-Aster-Nonce': nonce, 'X-Internal-Signature': v2(ts, nonce, BODY) }),
      BODY, SECRET);
    expect(r).toEqual({ ok: true, usedLegacyCanonical: false });
  });

  it('★换 body 重放：v2 下必须拒绝（这是本次修复的核心）', async () => {
    const ts = now(), nonce = 'n-1';
    const sig = v2(ts, nonce, BODY);           // 对原始 body 的合法签名
    const tampered = '{"userId":"victim"}';    // 攻击者换掉 body
    const r = await verifyInternalSignature(
      makeReq({ 'X-Aster-Timestamp': String(ts), 'X-Aster-Nonce': nonce, 'X-Internal-Signature': sig }, tampered),
      tampered, SECRET, { allowLegacy: false });
    expect(r.ok).toBe(false);
  });

  it('迁移窗口内接受 v1，并标记 usedLegacyCanonical=true（用于观测切换进度）', async () => {
    const ts = now();
    const r = await verifyInternalSignature(
      makeReq({ 'X-Aster-Timestamp': String(ts), 'X-Aster-Signature': v1(ts) }),
      BODY, SECRET, { allowLegacy: true });
    expect(r).toEqual({ ok: true, usedLegacyCanonical: true });
  });

  it('★关闭兼容后 v1 必须被拒——这是迁移第三步的终态', async () => {
    const ts = now();
    const r = await verifyInternalSignature(
      makeReq({ 'X-Aster-Timestamp': String(ts), 'X-Aster-Signature': v1(ts) }),
      BODY, SECRET, { allowLegacy: false });
    expect(r).toEqual({ ok: false, reason: 'invalid_signature' });
  });

  it('★不传 opts 时默认拒绝 v1 —— 钉死迁移第三步已完成', async () => {
    // 既有用例都显式传 allowLegacy，因此**没有一个覆盖默认值**。
    // 而默认值恰恰是生产实际走的分支：ASTER_INTERNAL_ALLOW_LEGACY_SIG
    // 在 wrangler.toml / K8s Secret / 任何部署配置中都未设置。
    // 此前默认是 `!== 'false'`（默认开启），可重放路径一直活在生产。
    delete process.env.ASTER_INTERNAL_ALLOW_LEGACY_SIG;
    const ts = now();
    const r = await verifyInternalSignature(
      makeReq({ 'X-Aster-Timestamp': String(ts), 'X-Aster-Signature': v1(ts) }),
      BODY, SECRET);   // ← 故意不传 opts，走默认分支
    expect(r.ok).toBe(false);
  });

  it('紧急回退：显式设 ASTER_INTERNAL_ALLOW_LEGACY_SIG=true 仍可临时接受 v1', async () => {
    process.env.ASTER_INTERNAL_ALLOW_LEGACY_SIG = 'true';
    try {
      const ts = now();
      const r = await verifyInternalSignature(
        makeReq({ 'X-Aster-Timestamp': String(ts), 'X-Aster-Signature': v1(ts) }),
        BODY, SECRET);
      expect(r).toEqual({ ok: true, usedLegacyCanonical: true });
    } finally {
      delete process.env.ASTER_INTERNAL_ALLOW_LEGACY_SIG;
    }
  });

  it('过期时间戳拒绝（300s 窗口）', async () => {
    const ts = now() - 400, nonce = 'n-1';
    const r = await verifyInternalSignature(
      makeReq({ 'X-Aster-Timestamp': String(ts), 'X-Aster-Nonce': nonce, 'X-Internal-Signature': v2(ts, nonce, BODY) }),
      BODY, SECRET);
    expect(r).toEqual({ ok: false, reason: 'stale_timestamp' });
  });

  it('缺签名头拒绝', async () => {
    const r = await verifyInternalSignature(makeReq({}), BODY, SECRET);
    expect(r).toEqual({ ok: false, reason: 'missing_signature_headers' });
  });

  it('非数字时间戳拒绝（不得落到 NaN 比较）', async () => {
    const r = await verifyInternalSignature(
      makeReq({ 'X-Aster-Timestamp': 'not-a-number', 'X-Internal-Signature': 'ab'.repeat(32) }),
      BODY, SECRET);
    expect(r).toEqual({ ok: false, reason: 'invalid_timestamp' });
  });
});

describe('重放与 300 秒时间窗（#480）', () => {
  const T0 = 1_800_000_000; // 固定签名时刻（unix 秒）

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0 * 1000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const headers = (ts: number, nonce: string) => ({
    'X-Aster-Timestamp': String(ts),
    'X-Aster-Nonce': nonce,
    'X-Internal-Signature': v2(ts, nonce, BODY),
  });
  const send = (ts: number, nonce: string) =>
    verifyInternalSignature(makeReq(headers(ts, nonce)), BODY, SECRET);
  const at = (sec: number) => vi.setSystemTime(sec * 1000);

  it('★同一请求原样重放：第一次通过，第二次被拒', async () => {
    expect(await send(T0, 'n-replay')).toEqual({ ok: true, usedLegacyCanonical: false });
    expect(await send(T0, 'n-replay')).toEqual({ ok: false, reason: 'replayed_nonce' });
  });

  it('★窗口末端（签名后 299 秒）重放仍被拒', async () => {
    expect((await send(T0, 'n-late')).ok).toBe(true);
    at(T0 + 299);
    expect(await send(T0, 'n-late')).toEqual({ ok: false, reason: 'replayed_nonce' });
  });

  it('★恰好 300 秒：首次仍在窗口内可通过，其后重放被拒', async () => {
    at(T0 + 300);
    expect((await send(T0, 'n-edge')).ok).toBe(true);
    expect(await send(T0, 'n-edge')).toEqual({ ok: false, reason: 'replayed_nonce' });
  });

  it('★超过 300 秒：签名本身因时间戳过期被拒，与 nonce 是否用过无关', async () => {
    expect((await send(T0, 'n-old')).ok).toBe(true);
    at(T0 + 301);
    expect(await send(T0, 'n-old')).toEqual({ ok: false, reason: 'stale_timestamp' });
    // 从没用过的 nonce 也一样：过期签名不会被接受，也不会占用 nonce 表
    expect(await send(T0, 'n-never-used')).toEqual({ ok: false, reason: 'stale_timestamp' });
    expect(store.rows.has('n-never-used')).toBe(false);
  });

  it('★时间戳超前 300 秒以上同样被拒（双向窗口）', async () => {
    expect(await send(T0 + 301, 'n-future')).toEqual({ ok: false, reason: 'stale_timestamp' });
    expect((await send(T0 + 300, 'n-future-edge')).ok).toBe(true);
  });

  it('★清理任务在窗口内运行，删不掉还能被重放的 nonce', async () => {
    // 最坏情形：时间戳超前 300 秒的签名，可接受到 ts+300 = T0+600
    const ts = T0 + 300;
    expect((await send(ts, 'n-gc')).ok).toBe(true);
    for (const t of [T0 + 300, T0 + 599, T0 + 600]) {
      at(t);
      store.cleanup(new Date(t * 1000));
      expect(await send(ts, 'n-gc')).toEqual({ ok: false, reason: 'replayed_nonce' });
    }
    // 窗口关闭后签名本身已过期；此时记录被清掉也放不出重放
    at(ts + 301 + 60);
    store.cleanup(new Date());
    expect(store.rows.has('n-gc')).toBe(false);
    expect(await send(ts, 'n-gc')).toEqual({ ok: false, reason: 'stale_timestamp' });
  });

  it('nonce 记录的过期时刻晚于该签名最后可被接受的时刻', () => {
    expect(nonceExpiresAt(T0).getTime()).toBeGreaterThan((T0 + 300) * 1000);
  });

  it('不同 nonce 的合法请求互不影响', async () => {
    expect((await send(T0, 'n-a')).ok).toBe(true);
    expect((await send(T0, 'n-b')).ok).toBe(true);
  });

  it('★签名不对时不写 nonce（否则任何人都能往表里灌行、或抢先占用合法 nonce）', async () => {
    const r = await verifyInternalSignature(
      makeReq({ 'X-Aster-Timestamp': String(T0), 'X-Aster-Nonce': 'n-forged', 'X-Internal-Signature': 'ab'.repeat(32) }),
      BODY, SECRET);
    expect(r).toEqual({ ok: false, reason: 'invalid_signature' });
    expect(store.claimNonce).not.toHaveBeenCalled();
    // 合法持钥方随后用同一 nonce 仍可通过
    expect((await send(T0, 'n-forged')).ok).toBe(true);
  });

  it('★nonce 存储不可用时拒绝（fail-closed），不退化为只验签名', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    store.claimNonce.mockRejectedValueOnce(new Error('connection refused'));
    expect(await send(T0, 'n-dbdown')).toEqual({ ok: false, reason: 'nonce_check_failed' });
    err.mockRestore();
  });

  it('认领时传入按签名时间戳算出的过期时刻', async () => {
    await send(T0 - 100, 'n-exp');
    expect(store.claimNonce).toHaveBeenCalledWith('n-exp', nonceExpiresAt(T0 - 100));
  });
});

