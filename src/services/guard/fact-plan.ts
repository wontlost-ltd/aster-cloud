/**
 * from-evidence 附签名事实（ADR 0046 §11.6 第 11 条；§11.7 裁定 4、6、7）。
 *
 * 翻转后第一次 from-evidence 没带事实即被 DENY 并消耗证据，所以事实必须随**首次**请求发出：
 * `registerGuardDecision`（执行路由与日志页「重新登记」共用）在 from-evidence 之前调用 {@link attachFacts}。
 *
 * 只在本租户确实能验过时才附（裁定 6）：先查 aster-api `listFactIssuers()`，cloud 的 `issuer#kid` 须存在、`enabled`、
 * 公钥与本进程密钥一致、`notAfter` 缺省或晚于 `now + FACT_TTL_MS`；否则不附——未登记 / 已吊销的签发方会让
 * aster-api 以 `invalid_fact` 400 整个请求，本应 PENDING 的登记整体失败。不附时返回同一个 action 引用，
 * 请求体与引入签发前逐字节相同。本模块永不抛错。
 */
import { type FactSource, type FactSourceContext, factSourcesFor } from '@/config/fact-sources';
import { FACT_TTL_MS, type FactRequest, signFacts } from '@/services/guard/fact-signer';
import { type FactSigningKey, loadFactSigningKey } from '@/services/guard/fact-signing-key';
import type { GuardAction, GuardFactIssuer } from '@/services/policy/guard-types';
import type { PolicyApiClient } from '@/services/policy/policy-api';

const LOG = '[fact-plan]';

/** 由 action 推出要签哪些路径（只给路径与来源，值一律由来源函数在服务端取）。 */
export function planFactRequests(action: GuardAction, sources: ReadonlyMap<string, FactSource>): FactRequest[] {
  const requests: FactRequest[] = [];
  if (action.principal.type === 'user') requests.push({ path: 'principal.id', source: 'hmac.userId' });
  if (action.principal.roles?.length) requests.push({ path: 'principal.roles', source: 'idp.businessRoles' });
  if (sources.has('fixture.creditPilot') && action.context?.applicant !== undefined) {
    requests.push({ path: 'context.applicant', source: 'fixture.creditPilot' });
  }
  return requests;
}

/** 本租户在 aster-api 登记的 cloud 签发方能否验过一条现在签出的事实。 */
export function cloudIssuerUsable(issuers: GuardFactIssuer[], key: FactSigningKey, now: Date): boolean {
  const deadline = now.getTime() + FACT_TTL_MS;
  return issuers.some(
    (i) =>
      i.issuer === key.issuer &&
      i.kid === key.kid &&
      i.enabled &&
      i.publicKey === key.publicKey &&
      (!i.notAfter || Date.parse(i.notAfter) > deadline),
  );
}

async function issuerUsable(client: PolicyApiClient, key: FactSigningKey, now: Date): Promise<boolean> {
  try {
    const { issuers } = await client.listFactIssuers();
    return cloudIssuerUsable(issuers ?? [], key, now);
  } catch (err) {
    console.warn(LOG, 'listFactIssuers 失败，本次不附事实', err);
    return false;
  }
}

/** 能签则返回带一条事实的新 action，否则返回原 action（同一引用）。 */
export async function attachFacts(
  client: PolicyApiClient,
  action: GuardAction,
  ctx: FactSourceContext,
  now: Date,
): Promise<GuardAction> {
  try {
    const key = await loadFactSigningKey();
    if (!key) return action;
    const sources = factSourcesFor(ctx.tenantId);
    const requests = planFactRequests(action, sources);
    if (requests.length === 0 || !(await issuerUsable(client, key, now))) return action;
    const { fact, skipped } = await signFacts({ ctx, requests, action, key, sources, now });
    // 只记路径与原因，不记取值
    if (skipped.length > 0) console.info(LOG, '未签的 claim', skipped);
    return fact ? { ...action, facts: [fact] } : action;
  } catch (err) {
    console.error(LOG, '签发事实失败，本次不附事实', err);
    return action;
  }
}
