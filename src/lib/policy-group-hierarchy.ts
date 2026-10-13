/**
 * 策略分组的父子关系：写入前防环，读取时容忍已有的环。
 *
 * <p>PolicyGroup.parentId 是裸 text 列（无外键、无约束），数据库不会挡住环。
 * 环一旦写入，沿父子关系遍历的代码就会出问题（#478）：
 * <ul>
 *   <li>PUT 的子孙校验无限递归；</li>
 *   <li>列表接口把分组拼成树，A↔B 互为子节点，序列化 JSON 时报循环引用、整页 500；</li>
 *   <li>按父分组收集子孙 id 时死循环。</li>
 * </ul>
 * 所有遍历都只沿 parentId 向上走、并记录已经过的分组，因此遇到环也会停下。
 */

/** 取某分组当前的 parentId；分组不存在时返回 undefined。 */
export type ParentLookup = (groupId: string) => Promise<string | null | undefined>;

/** 沿父链最多向上走的层数：远超任何真实分组树，只作损坏数据下的兜底。 */
export const MAX_GROUP_DEPTH = 256;

/**
 * 应用一组「分组 → 新父分组」改动后，父子关系里是否会出现环。
 *
 * <p>对每个被挂到新父分组下的分组，从新父分组沿父链向上走（父链先看本次改动，再查库）：
 * 回到该分组本身，或重复经过任一分组（库里已有环），都判定为成环。
 * 只向上经过祖先、不展开子孙，查询次数受树高限制。
 *
 * @param edits 分组 id → 新 parentId（null 表示移到顶层）
 */
export async function wouldCreateParentCycle(
  edits: ReadonlyMap<string, string | null>,
  lookupParent: ParentLookup,
): Promise<boolean> {
  const fetched = new Map<string, string | null>();
  const parentOf = async (id: string): Promise<string | null> => {
    if (edits.has(id)) return edits.get(id) ?? null;
    if (!fetched.has(id)) fetched.set(id, (await lookupParent(id)) ?? null);
    return fetched.get(id) ?? null;
  };

  for (const [groupId, newParent] of edits) {
    const visited = new Set<string>([groupId]);
    let current = newParent;
    while (current) {
      if (visited.has(current) || visited.size > MAX_GROUP_DEPTH) return true;
      visited.add(current);
      current = await parentOf(current);
    }
  }
  return false;
}

/**
 * 把分组拼成树时实际采用的父分组。
 *
 * <p>父分组不在列表里，或沿父链向上会绕回（处在环上、或挂在环下），都按顶层处理。
 * 这样已有的坏数据仍能显示出来（用户可以把它们移回正确位置），而不是让整棵树无法序列化。
 */
export function resolveTreeParents(
  groups: ReadonlyArray<{ id: string; parentId: string | null }>,
): Map<string, string | null> {
  const declared = new Map(groups.map((g) => [g.id, g.parentId]));
  const resolved = new Map<string, string | null>();
  for (const group of groups) {
    resolved.set(group.id, reachesRoot(group.id, declared) ? group.parentId : null);
  }
  return resolved;
}

/** 从 id 沿父链向上，是否能走到顶层（parentId 为空或父分组不在列表内）而不绕回。 */
function reachesRoot(id: string, declared: ReadonlyMap<string, string | null>): boolean {
  const visited = new Set<string>([id]);
  let current = declared.get(id) ?? null;
  while (current && declared.has(current)) {
    if (visited.has(current)) return false;
    visited.add(current);
    current = declared.get(current) ?? null;
  }
  return true;
}

/**
 * 把平铺的分组拼成树（列表接口与策略页侧栏共用）。父分组按 {@link resolveTreeParents} 取，
 * 因此环上的分组落在顶层，不会出现互为子节点的循环结构。
 *
 * @param toNode 把一条分组转成带空 children 的树节点
 */
export function buildGroupTree<
  T extends { id: string; parentId: string | null },
  N extends { children: N[] },
>(groups: readonly T[], toNode: (group: T) => N): N[] {
  const nodes = new Map(groups.map((g) => [g.id, toNode(g)]));
  const treeParents = resolveTreeParents(groups);
  const roots: N[] = [];
  for (const group of groups) {
    const node = nodes.get(group.id)!;
    const parent = nodes.get(treeParents.get(group.id) ?? '');
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}
