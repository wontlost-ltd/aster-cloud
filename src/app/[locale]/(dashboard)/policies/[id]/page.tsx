import { getSession } from '@/lib/auth';
import { redirect, notFound } from 'next/navigation';
import { db, policies, executions, users } from '@/lib/prisma';
import { eq, and, desc, sql } from 'drizzle-orm';
import { getTranslations } from 'next-intl/server';
import { isPolicyFrozen } from '@/lib/policy-freeze';
import { getEffectiveLimits, type PlanType } from '@/lib/plans';
import { PolicyDetailContent } from './policy-detail-content';

// 服务端数据获取
async function getPolicyData(userId: string, policyId: string) {
  const policy = await db.query.policies.findFirst({
    where: and(eq(policies.id, policyId), eq(policies.userId, userId)),
    with: {
      versions: {
        orderBy: (versions) => desc(versions.version),
        limit: 10,
      },
    },
  });

  if (!policy) {
    return null;
  }

  // 获取执行次数
  const [{ count: executionCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(executions)
    .where(eq(executions.policyId, policyId));

  return {
    id: policy.id,
    name: policy.name,
    description: policy.description,
    content: policy.content,
    version: policy.version,
    isPublic: policy.isPublic,
    shareSlug: policy.shareSlug,
    piiFields: policy.piiFields as string[] | null,
    createdAt: policy.createdAt.toISOString(),
    updatedAt: policy.updatedAt.toISOString(),
    versions: policy.versions.map((v) => ({
      id: v.id,
      version: v.version,
      content: v.content,
      comment: v.comment,
      createdAt: v.createdAt.toISOString(),
    })),
    _count: { executions: executionCount },
  };
}

export default async function PolicyDetailPage({
  params,
}: {
  params: Promise<{ id: string; locale: string }>;
}) {
  const { id, locale } = await params;
  const session = await getSession();
  if (!session?.user?.id) {
    redirect(`/${locale}/login`);
  }

  const policy = await getPolicyData(session.user.id, id);

  if (!policy) {
    notFound();
  }

  // 冻结状态：套餐降级超限后该策略只读（不可执行/编辑）。
  // 详情页据此禁用按钮并展示冻结横幅，与列表页一致。
  const freeze = await isPolicyFrozen(session.user.id, id);

  // What-If 权益（ADR 0034 §7.2）：free 档 concurrentReplayBatches=0 表示
  // **没有这个功能**，不是「限流为 0」。
  // ★在 server component 读，不新增客户端 fetch、不新增端点——
  //   同 approve/route.ts 的既有模式。
  const planUser = await db.query.users.findFirst({
    where: eq(users.id, session.user.id),
    columns: { plan: true, priceLockedAt: true, legacyTier: true },
  });
  const whatIfEntitled = planUser
    ? getEffectiveLimits({
        plan: planUser.plan as PlanType,
        priceLockedAt: planUser.priceLockedAt,
        legacyTier: planUser.legacyTier,
      }).concurrentReplayBatches !== 0
    : false;   // 查不到用户按无权益处理（fail-closed）

  const t = await getTranslations('policies');

  // 预渲染翻译字符串
  const translations = {
    executeAction: t('executeAction'),
    edit: t('edit'),
    delete: t('delete'),
    confirmDelete: t('confirmDelete'),
    failedToDelete: t('failedToDelete'),
    public: t('public'),
    private: t('private'),
    detail: {
      version: t('detail.version'),
      executions: t('detail.executions'),
      viewLogs: t('detail.viewLogs'),
      piiFields: t('detail.piiFields'),
      status: t('detail.status'),
      piiWarning: t('detail.piiWarning'),
      piiWarningMessage: t('detail.piiWarningMessage'),
      policyContent: t('detail.policyContent'),
      versionHistory: t('detail.versionHistory'),
      backToPolicies: t('detail.backToPolicies'),
    },
    deleteDialog: {
      title: t('deleteDialog.title'),
      description: t('deleteDialog.description', { name: policy.name }),
      confirm: t('deleteDialog.confirm'),
      cancel: t('deleteDialog.cancel'),
    },
    freeze: {
      badge: t('freeze.badge'),
      title: t('freeze.title'),
      message: t('freeze.message', {
        frozen: freeze.frozenCount,
        total: freeze.totalPolicies,
        limit: freeze.activePoliciesLimit,
      }),
      cannotExecute: t('freeze.cannotExecute'),
      cannotEdit: t('freeze.cannotEdit'),
      upgradeLink: t('freeze.upgradeLink'),
    },
  };

  return (
    <PolicyDetailContent
      whatIfEntitled={whatIfEntitled}
      policy={{ ...policy, isFrozen: freeze.isFrozen }}
      translations={translations}
      locale={locale}
    />
  );
}
