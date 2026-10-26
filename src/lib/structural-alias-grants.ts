import { and, eq, isNull } from 'drizzle-orm';
import { db, domainTerms, structuralAliasGrants, userDomainTerms } from '@/lib/prisma';
import { bypassQueryCache } from '@/db/fresh-read';
import { extractReservedAliasSets, getLexicon } from '@/lib/aster-lexicon';
import { normalizeAliasToken, type ReservedSets } from '@/lib/policy-alias-shared';

/**
 * 用户当前是否持有结构词别名授权。
 * 授权是权限状态：管理员授予 / 撤销后编辑器与保存校验必须立即生效，故绕过 Hyperdrive 缓存（#614）。
 */
export async function getStructuralAliasGrant(userId: string): Promise<boolean> {
  const grant = await db.query.structuralAliasGrants.findFirst({
    where: and(
      eq(structuralAliasGrants.userId, userId),
      isNull(structuralAliasGrants.revokedAt),
      bypassQueryCache(),
    ),
    columns: { id: true },
  });
  return Boolean(grant);
}

export async function buildAliasReservedForUser(
  userId: string,
  locale: string,
): Promise<ReservedSets> {
  const base = extractReservedAliasSets(getLexicon(locale));
  const vocabularyTermsLower = new Set<string>();
  const rows = await db
    .select({
      canonical: domainTerms.canonical,
      localized: domainTerms.localized,
      aliases: domainTerms.aliases,
    })
    .from(userDomainTerms)
    .innerJoin(domainTerms, eq(userDomainTerms.termId, domainTerms.id))
    .where(and(
      eq(userDomainTerms.userId, userId),
      isNull(userDomainTerms.deletedAt),
      isNull(userDomainTerms.archivedAt),
    ));

  for (const row of rows) {
    vocabularyTermsLower.add(normalizeAliasToken(row.canonical));
    vocabularyTermsLower.add(normalizeAliasToken(row.localized));
    for (const alias of row.aliases ?? []) {
      vocabularyTermsLower.add(normalizeAliasToken(alias));
    }
  }

  return {
    ...base,
    vocabularyTermsLower,
  };
}
