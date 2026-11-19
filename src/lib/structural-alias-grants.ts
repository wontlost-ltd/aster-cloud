import { and, eq, isNull } from 'drizzle-orm';
import { structuralAliasGrants } from '@/lib/prisma';
import { freshDb } from '@/db/fresh-read';
import { extractReservedAliasSets, getLexicon } from '@/lib/aster-lexicon';
import { normalizeAliasToken, type ReservedSets } from '@/lib/policy-alias-shared';
import { allMappings } from '@/lib/policy-embedded-vocabulary';
import { IdentifierKind, type DomainVocabulary } from '@aster-cloud/aster-lang-ts/lexicons/identifiers/types';

/**
 * 用户当前是否持有结构词别名授权。
 * 授权是权限状态：管理员授予 / 撤销后编辑器与保存校验必须立即生效，故绕过 Hyperdrive 缓存（#614）。
 */
export async function getStructuralAliasGrant(userId: string): Promise<boolean> {
  const grant = await freshDb.query.structuralAliasGrants.findFirst({
    where: and(
      eq(structuralAliasGrants.userId, userId),
      isNull(structuralAliasGrants.revokedAt),
    ),
    columns: { id: true },
  });
  return Boolean(grant);
}

/**
 * 别名校验的占用集（ADR 0060 §5.3、§6.4）：基础 lexicon 的规范拼写与官方别名，加上本次保存编译所用的
 * 同一份有效词汇（作用域内团队 / 作者词条 + 内嵌词条）里的全部写法——各角色的本地化名、别名与规范名，
 * 以及字面量触发词。与编译门禁同源，别名不会与实际参与编译的词条同形，也不会被编译不用的词条误拒。
 * 字面量的规范名是展开后的字符串内容，不是源码里的写法，不进占用集。
 */
export function buildAliasReservedFromVocabulary(
  locale: string,
  vocabulary: DomainVocabulary | null,
): ReservedSets {
  const vocabularyTermsLower = new Set<string>();
  for (const mapping of vocabulary ? allMappings(vocabulary) : []) {
    const forms = [mapping.localized, ...(mapping.aliases ?? [])];
    if (mapping.kind !== IdentifierKind.LITERAL) forms.push(mapping.canonical);
    for (const form of forms) vocabularyTermsLower.add(normalizeAliasToken(form));
  }
  return { ...extractReservedAliasSets(getLexicon(locale)), vocabularyTermsLower };
}
