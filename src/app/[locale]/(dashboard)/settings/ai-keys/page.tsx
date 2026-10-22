import { getLocale } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { db, aiKeyBindings } from '@/lib/prisma';
import { eq } from 'drizzle-orm';
import { byokTokensUsedThisMonth } from '@/lib/ai-quota';
import { AiKeysContent } from './ai-keys-content';
import { localizedTitle } from '@/lib/page-metadata';

export const generateMetadata = localizedTitle('settings.aiKeysPage', 'title');

export default async function AiKeysPage() {
  const session = await getSession();
  if (!session?.user?.id) {
    redirect('/login');
  }

  const locale = await getLocale();

  const bindings = await db.query.aiKeyBindings.findMany({
    where: eq(aiKeyBindings.userId, session.user.id),
    columns: {
      id: true,
      provider: true,
      keyHint: true,
      active: true,
      providerUrl: true,
      tokenQuota: true,
      expiresAt: true,
      priority: true,
      lastUsedAt: true,
      lastErrorAt: true,
      lastError: true,
      createdAt: true,
      model: true,
      availableModels: true,
      modelsCheckedAt: true,
    },
    orderBy: (t, { asc }) => [asc(t.provider), asc(t.priority), asc(t.createdAt)],
  });

  // 本月 BYOK 已用 tokens（每用户总量,见 ai-quota 说明）。
  const usedTokensThisMonth = await byokTokensUsedThisMonth(session.user.id);

  const initialBindings = bindings.map((b) => ({
    id: b.id,
    provider: b.provider,
    keyHint: b.keyHint,
    active: b.active,
    providerUrl: b.providerUrl ?? null,
    tokenQuota: b.tokenQuota ?? null,
    expiresAt: b.expiresAt?.toISOString() ?? null,
    priority: b.priority,
    usedTokensThisMonth,
    lastUsedAt: b.lastUsedAt?.toISOString() ?? null,
    lastErrorAt: b.lastErrorAt?.toISOString() ?? null,
    lastError: b.lastError ?? null,
    createdAt: b.createdAt.toISOString(),
    model: b.model ?? null,
    availableModels: b.availableModels ?? null,
    modelsCheckedAt: b.modelsCheckedAt?.toISOString() ?? null,
  }));

  // Server Component 每请求只渲染一次，Date.now() 在此渲染安全（非客户端重渲染）
  // eslint-disable-next-line react-hooks/purity
  const renderedAt = Date.now();
  return <AiKeysContent initialBindings={initialBindings} locale={locale} renderedAt={renderedAt} />;
}
