/**
 * 签名事实的来源函数清单（ADR 0046 §11 D5 第 2 项；§11.7 裁定 2、7）。
 *
 * 清单是代码常量，不可运行时配置：fact-signer 只能为这里登记过的 `source` 在其 `allowedPaths` 内取值，
 * 值一律由来源函数在服务端取得，调用方不能提供原值（裁定 8）。第一期三项：
 * - `hmac.userId`：`principal.id` = 发起人 userId（即签入 HMAC v3 的同一身份）；
 * - `idp.businessRoles`：`principal.roles` = `loadBusinessRoles(userId, tenantId)` 读出的已登记业务角色
 *   （`createPolicyApiClientForUser` 签入 HMAC v3 的同一函数），不读执行输入里的 `principal_roles`；
 * - `fixture.creditPilot`：`context.applicant` = 试点 fixture 常量（ADR 0044 §5），仅非生产且租户为 `credit-pilot`
 *   时登记。请求体里的 `applicant` 只用来**选出**哪一组 fixture（JCS 字节相等），claim 值取自常量本身；
 *   与任何一组都不相等时不签。
 * `catalog.piiMark` 已撤销（ADR 0042 §12 D3）：PII 标记由 aster-api 从被执行的 Core IR 推导，不经签名事实。
 */
import { loadBusinessRoles } from '@/lib/business-roles';
import { jcsCanonicalize } from '@/lib/jcs';
import { CREDIT_PILOT, PILOT_APPLICANTS } from '@/config/credit-pilot-source';

export interface FactSourceContext {
  tenantId: string;
  userId: string;
  /** 执行输入（即 guard action 的 context）；只有 fixture 来源用它挑选 fixture，从不把它的值当作 claim。 */
  input: Record<string, unknown>;
}

export interface FactSource {
  id: string;
  /** 精确路径，或以 '.*' 结尾表示其下任意更深路径（不含该前缀本身）。 */
  allowedPaths: readonly string[];
  /** 返回该路径的服务端取值；取不到返回 undefined（不签）。 */
  resolve(ctx: FactSourceContext, path: string, args: Record<string, unknown>): Promise<unknown | undefined>;
}

export function pathAllowed(allowed: readonly string[], path: string): boolean {
  return allowed.some((p) => (p.endsWith('.*') ? path.startsWith(p.slice(0, -1)) : p === path));
}

const hmacUserId: FactSource = {
  id: 'hmac.userId',
  allowedPaths: ['principal.id'],
  resolve: async (ctx) => ctx.userId,
};

const idpBusinessRoles: FactSource = {
  id: 'idp.businessRoles',
  allowedPaths: ['principal.roles'],
  resolve: (ctx) => loadBusinessRoles(ctx.userId, ctx.tenantId),
};

const FIXTURE_APPLICANT_PATH = 'context.applicant';

function canonicalOrNull(value: unknown): string | null {
  try {
    return jcsCanonicalize(value);
  } catch {
    return null;
  }
}

const fixtureCreditPilot: FactSource = {
  id: 'fixture.creditPilot',
  allowedPaths: ['context.*'],
  resolve: async (ctx, path) => {
    if (path !== FIXTURE_APPLICANT_PATH) return undefined;
    const wanted = canonicalOrNull(ctx.input.applicant);
    if (wanted === null) return undefined;
    return Object.values(PILOT_APPLICANTS).find((fixture) => jcsCanonicalize(fixture) === wanted);
  },
};

/**
 * 本租户可用的来源函数（按 id）；fixture 来源只在非生产的 credit-pilot 租户登记（ADR 0046 D5 第 2(c) 项）。
 * 缺省值刻意写成字面 `process.env.NODE_ENV`（不用 safeEnv）：Next 构建时把它内联为 "production"，
 * Worker 运行期即使没有 NODE_ENV 也不会把 fixture 来源登记进生产。
 */
export function factSourcesFor(tenantId: string, nodeEnv = process.env.NODE_ENV): ReadonlyMap<string, FactSource> {
  const sources: FactSource[] = [hmacUserId, idpBusinessRoles];
  if (nodeEnv !== 'production' && tenantId === CREDIT_PILOT.teamId) sources.push(fixtureCreditPilot);
  return new Map(sources.map((s) => [s.id, s]));
}
