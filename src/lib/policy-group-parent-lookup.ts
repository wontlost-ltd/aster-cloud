import { eq } from 'drizzle-orm';
import { db, policyGroups } from '@/lib/prisma';
import type { ParentLookup } from '@/lib/policy-group-hierarchy';

/**
 * 从库里取分组的 parentId，供 {@link wouldCreateParentCycle} 沿父链向上走。
 *
 * <p>只读 parentId、不按归属过滤：调用方已校验过被改分组与新父分组的归属，
 * 这里只判断结构，结果只是一个布尔值，不向调用方暴露任何分组数据。
 */
export const lookupGroupParent: ParentLookup = async (groupId) => {
  const row = await db.query.policyGroups.findFirst({
    where: eq(policyGroups.id, groupId),
    columns: { parentId: true },
  });
  return row?.parentId;
};
