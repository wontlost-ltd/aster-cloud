// @vitest-environment node
/**
 * 信贷试点 seed 的签发方登记步骤（ADR 0046 §11.7 裁定 5）：seed 只把已配置私钥对应的公钥登记到 credit-pilot 租户，
 * 不生成密钥；未配置密钥、公钥冲突都以非零退出（抛错，由 seed main 统一 exit 1）。
 */
import { describe, expect, it, vi } from 'vitest';
import { PilotIssuerError, registerPilotFactIssuer } from '@/scripts/pilot-fact-issuer';
import type { FactSigningKey } from '@/services/guard/fact-signing-key';
import { PolicyApiError, type PolicyApiClient } from '@/services/policy/policy-api';

const KEY = { issuer: 'aster-cloud', kid: 'k-pilot', publicKey: 'P'.repeat(43), privateKey: {} as CryptoKey } satisfies FactSigningKey;

function deps(putFactIssuer: ReturnType<typeof vi.fn>, key: FactSigningKey | null = KEY) {
  return { loadKey: async () => key, client: { putFactIssuer } as unknown as PolicyApiClient, log: vi.fn() };
}

describe('registerPilotFactIssuer', () => {
  it('registersConfiguredPublicKey：以配置的 issuer / kid 登记公钥（只传公钥）', async () => {
    const put = vi.fn().mockResolvedValue({ issuer: KEY.issuer, kid: KEY.kid, enabled: true });
    await registerPilotFactIssuer(deps(put));
    expect(put).toHaveBeenCalledWith('aster-cloud', 'k-pilot', { publicKey: KEY.publicKey });
  });

  it('幂等：重复运行同样只是同一 PUT', async () => {
    const put = vi.fn().mockResolvedValue({ issuer: KEY.issuer, kid: KEY.kid, enabled: true });
    await registerPilotFactIssuer(deps(put));
    await registerPilotFactIssuer(deps(put));
    expect(put.mock.calls).toEqual([put.mock.calls[0], put.mock.calls[0]]);
  });

  it('missingKeyExitsNonZero：未配置 ASTER_FACT_SIGNING_KEY → 抛错且不调用 api', async () => {
    const put = vi.fn();
    await expect(registerPilotFactIssuer(deps(put, null))).rejects.toThrow(
      new PilotIssuerError('未配置 ASTER_FACT_SIGNING_KEY，跳过签发方登记'),
    );
    expect(put).not.toHaveBeenCalled();
  });

  it('conflictExitsNonZeroWithHint：409 issuer_key_conflict → 抛错并提示换 kid 或吊销旧钥', async () => {
    const put = vi.fn().mockRejectedValue(new PolicyApiError('conflict', 409, 'issuer_key_conflict'));
    const err = await registerPilotFactIssuer(deps(put)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PilotIssuerError);
    expect((err as Error).message).toContain('换 kid 或吊销旧钥');
  });

  it('其他 api 错误原样上抛（同样非零退出）', async () => {
    const put = vi.fn().mockRejectedValue(new PolicyApiError('down', 503));
    await expect(registerPilotFactIssuer(deps(put))).rejects.toBeInstanceOf(PolicyApiError);
  });
});
