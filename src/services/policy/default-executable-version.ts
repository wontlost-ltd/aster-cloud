/**
 * 默认可执行版本的选择。
 *
 * 普通执行路径按当前生效版本执行；Cedar 导出复用本函数，保证导出的就是会被执行的版本。
 */

import { db, policies, policyVersions } from '@/lib/prisma';
import { eq, and, desc } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';

type Policy = InferSelectModel<typeof policies>;
type PolicyVersion = InferSelectModel<typeof policyVersions>;

type PolicyVersionWithPolicy = PolicyVersion & {
  policy: Policy;
};

/**
 * 优先 isDefault 的 APPROVED 版本，否则最新 APPROVED 版本；都没有时返回 null。
 * 草稿等未批准版本永不入选。
 */
export async function findDefaultExecutableVersion(policyId: string): Promise<PolicyVersionWithPolicy | null> {
  const preferred = await db.query.policyVersions.findFirst({
    where: and(
      eq(policyVersions.policyId, policyId),
      eq(policyVersions.status, 'APPROVED'),
      eq(policyVersions.isDefault, true)
    ),
    with: { policy: true },
  });
  if (preferred) return preferred as PolicyVersionWithPolicy;

  const latest = await db.query.policyVersions.findFirst({
    where: and(
      eq(policyVersions.policyId, policyId),
      eq(policyVersions.status, 'APPROVED')
    ),
    orderBy: [desc(policyVersions.version)],
    with: { policy: true },
  });
  return (latest as PolicyVersionWithPolicy | undefined) ?? null;
}
