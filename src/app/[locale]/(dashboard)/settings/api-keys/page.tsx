import { getTranslations, getLocale } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { getSession } from '@/lib/auth';
import { listApiKeys } from '@/lib/api-keys';
import { db, teamMembers } from '@/lib/prisma';
import { ApiKeysContent } from './api-keys-content';

export default async function ApiKeysPage() {
  const session = await getSession();
  if (!session?.user?.id) {
    redirect('/login');
  }

  const t = await getTranslations('settings.apiKeys');
  const tNav = await getTranslations('dashboardNav');
  const tCommon = await getTranslations('common');
  const locale = await getLocale();

  // 获取 API keys 列表
  const keys = await listApiKeys(session.user.id);

  // 用户所在团队，供创建表单选择作用域（与 GET /api/teams 同一查询口径）
  const memberships = await db.query.teamMembers.findMany({
    where: eq(teamMembers.userId, session.user.id),
    with: { team: { columns: { id: true, name: true } } },
  });
  const teams = memberships.map((m) => ({ id: m.team.id, name: m.team.name }));

  // 序列化数据以便传递给客户端组件
  const apiKeys = keys.map((key) => ({
    id: key.id,
    name: key.name,
    prefix: key.prefix,
    teamId: key.teamId,
    teamName: key.teamName,
    lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
    createdAt: key.createdAt.toISOString(),
    expiresAt: key.expiresAt?.toISOString() ?? null,
  }));

  // 预渲染所有翻译字符串
  const translations = {
    breadcrumb: t('breadcrumb'),
    title: t('title'),
    subtitle: t('subtitle'),
    keyCreated: t('keyCreated'),
    copyWarning: t('copyWarning'),
    copy: t('copy'),
    dismiss: t('dismiss'),
    createNew: t('createNew'),
    keyPlaceholder: t('keyPlaceholder'),
    creating: t('creating'),
    createKey: t('createKey'),
    enterName: t('enterName'),
    confirmRevoke: t('confirmRevoke'),
    yourKeys: t('yourKeys'),
    noKeys: t('noKeys'),
    name: t('name'),
    key: t('key'),
    lastUsed: t('lastUsed'),
    created: t('created'),
    actions: t('actions'),
    never: t('never'),
    revoke: t('revoke'),
    usageExample: t('usageExample'),
    usageDescription: t('usageDescription'),
    scope: t('scope'),
    scopePersonal: t('scopePersonal'),
    // 含 {team} 占位符的模板由客户端替换；用 raw 取原文，避免 t() 缺参时格式化失败回退为 key 路径
    scopeTeam: t.raw('scopeTeam') as string,
    scopeColumn: t('scopeColumn'),
    errorNotMember: t('errorNotMember'),
    errorPlanNoApiAccess: t('errorPlanNoApiAccess'),
    examples: {
      getPolicyId: t('examples.getPolicyId'),
      getPolicyIdDesc: t('examples.getPolicyIdDesc'),
      executePolicy: t('examples.executePolicy'),
      executePolicyDesc: t('examples.executePolicyDesc'),
      listPolicies: t('examples.listPolicies'),
      listPoliciesDesc: t('examples.listPoliciesDesc'),
      responseExample: t('examples.responseExample'),
      responseExampleDesc: t('examples.responseExampleDesc'),
      errorHandling: t('examples.errorHandling'),
      errorHandlingDesc: t('examples.errorHandlingDesc'),
      error401: t('examples.error401'),
      error403: t('examples.error403'),
      error404: t('examples.error404'),
      error429: t('examples.error429'),
    },
    nav: {
      settings: tNav('settings'),
    },
    cancel: tCommon('cancel'),
  };

  return (
    <ApiKeysContent
      initialApiKeys={apiKeys}
      teams={teams}
      translations={translations}
      locale={locale}
    />
  );
}
