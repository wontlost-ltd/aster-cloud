/**
 * 信贷试点测试签发方登记（ADR 0046 §11 D5 第 2(c) 项；§11.7 裁定 5）。
 *
 * seed 不生成密钥：密钥对由 `pnpm fact-key:gen --kid <kid>` 生成并配置为 `ASTER_FACT_SIGNING_KEY`，
 * 这里只把它的公钥以 cp-owner 身份登记到 credit-pilot 租户——否则每次 seed 换一把新钥，已运行的 cloud 进程
 * 持有的私钥会与登记的公钥不一致。PUT 按 issuer#kid 幂等；同 kid 已登记了另一把公钥时 aster-api 回
 * 409 `issuer_key_conflict`，须换 kid 或先吊销旧钥。
 */
import type { FactSigningKey } from '@/services/guard/fact-signing-key';
import type { GuardFactIssuer } from '@/services/policy/guard-types';
import { PolicyApiError, type PolicyApiClient } from '@/services/policy/policy-api';

export class PilotIssuerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PilotIssuerError';
  }
}

export interface PilotIssuerDeps {
  loadKey: () => Promise<FactSigningKey | null>;
  client: Pick<PolicyApiClient, 'putFactIssuer'>;
  log: (...args: unknown[]) => void;
}

/** 登记已配置密钥的公钥；未配置密钥或公钥冲突抛 {@link PilotIssuerError}（seed 以非零退出）。 */
export async function registerPilotFactIssuer(deps: PilotIssuerDeps): Promise<GuardFactIssuer> {
  const key = await deps.loadKey();
  if (!key) throw new PilotIssuerError('未配置 ASTER_FACT_SIGNING_KEY，跳过签发方登记');
  try {
    const row = await deps.client.putFactIssuer(key.issuer, key.kid, { publicKey: key.publicKey });
    deps.log(`已登记签发方 ${key.issuer}#${key.kid}（enabled=${row.enabled}）`);
    return row;
  } catch (err) {
    if (err instanceof PolicyApiError && err.code === 'issuer_key_conflict') {
      throw new PilotIssuerError(`签发方 ${key.issuer}#${key.kid} 已登记了另一把公钥：换 kid 或吊销旧钥后重跑`);
    }
    throw err;
  }
}
