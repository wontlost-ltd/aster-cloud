/**
 * 团队策略的可见词汇：团队词汇 + 作者个人词汇，跨归属冲突时团队优先（ADR 0017 §2）。纯叶子模块，浏览器安全。
 *
 * 冲突口径与 ADR 0051 §8 一致：同角色、同作用域（字段 / 枚举成员按父规范名），NFC 后写法（本地化名或别名）
 * 完全相同却映射到不同规范名。只比较同一主语言的词条（不同语言不会同时进入一条策略的作用域）。
 * 仅大小写不同不算冲突，交给引擎「精确优先、折叠唯一」；完全相同的映射由合并去重处理。
 *
 * 编辑器、保存编译门禁、草稿执行与审批冻结都经这里合并，保证四处看到同一份词汇。
 */

import type { TermLikeRow } from '@/lib/domain-vocabulary-assemble';
import { localeLanguage } from '@/lib/domain-vocabulary-scope';

const ROLE_BY_KIND: Readonly<Record<string, string>> = {
  struct: 'types',
  field: 'fields',
  enum_value: 'enumMembers',
  function: 'functions',
};

/** 写法冲突键：语言 + 角色 + 作用域 + NFC 写法；不认识的 kind 不参与裁决。 */
function writtenKeys(row: TermLikeRow): string[] {
  const role = ROLE_BY_KIND[row.kind];
  if (!role) return [];
  const parent = role === 'fields' || role === 'enumMembers' ? (row.parentCanonical ?? '') : '';
  const forms = [row.localized, ...(row.aliases ?? [])].map((w) => w.normalize('NFC'));
  return [...new Set(forms)].map((w) => JSON.stringify([localeLanguage(row.locale), role, parent, w]));
}

export interface TeamVocabularyMerge<T extends TermLikeRow> {
  /** 合并后的词条行：全部团队词条在前，未被遮蔽的作者词条在后。 */
  rows: T[];
  /** 因与团队词条冲突而不生效的作者个人词条（编辑器据此提示）。 */
  shadowed: T[];
}

/**
 * 合并团队词条与作者个人词条：作者词条只要有一个写法与团队词条冲突（同键、规范名不同）就整条丢弃。
 * 团队内部的冲突不在这里处理（保存团队词条时已按 ADR 0051 §8 拒绝）。
 */
export function mergeTeamAndAuthorRows<T extends TermLikeRow>(
  teamRows: readonly T[],
  authorRows: readonly T[],
): TeamVocabularyMerge<T> {
  const teamCanonicals = new Map<string, Set<string>>();
  for (const row of teamRows) {
    for (const key of writtenKeys(row)) {
      const set = teamCanonicals.get(key) ?? new Set<string>();
      set.add(row.canonical);
      teamCanonicals.set(key, set);
    }
  }
  const kept: T[] = [];
  const shadowed: T[] = [];
  for (const row of authorRows) {
    const conflicts = writtenKeys(row).some((key) => {
      const canonicals = teamCanonicals.get(key);
      return canonicals !== undefined && [...canonicals].some((c) => c !== row.canonical);
    });
    (conflicts ? shadowed : kept).push(row);
  }
  return { rows: [...teamRows, ...kept], shadowed };
}
