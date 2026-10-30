import { getTranslations } from 'next-intl/server';
import { redirect, notFound } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { loadPolicyForAction } from '@/lib/policy-access';
import { db, policyVersions } from '@/lib/prisma';
import { eq, and } from 'drizzle-orm';
import { isPolicyFrozen } from '@/lib/policy-freeze';
import { EditPolicyContent } from './edit-policy-content';
import { getStructuralAliasGrant } from '@/lib/structural-alias-grants';
import { localizedTitle } from '@/lib/page-metadata';
import { resolveStoredVersionLocale } from '@/lib/policy-version-locale';

export const generateMetadata = localizedTitle('pageTitles', 'policyEdit');

interface PageProps {
  params: Promise<{ id: string; locale: string }>;
}

export default async function EditPolicyPage({ params }: PageProps) {
  const { id, locale } = await params;
  const session = await getSession();
  if (!session?.user?.id) {
    redirect(`/${locale}/login`);
  }
  const t = await getTranslations('policies');

  // 与 PUT /api/policies/[id] 同一授权：团队策略 member 起可编辑（含他人创建的，#669），
  // viewer 与非成员（含已离队的创建者，#670）不能进入编辑页；个人策略只认所有者
  const access = await loadPolicyForAction(id, { userId: session.user.id }, 'update');
  const policyData = access.ok
    ? {
        id: access.policy.id,
        name: access.policy.name,
        description: access.policy.description,
        content: access.policy.content,
        isPublic: access.policy.isPublic,
        groupId: access.policy.groupId,
        version: access.policy.version,
        ownerId: access.policy.userId,
      }
    : null;

  if (!policyData) {
    notFound();
  }

  // C2：加载活跃版本冻结的 aliasSet（canonical JSON），使编辑器预填现有别名。
  // 版本号 = Policy.version（与 content 同源的活跃版本）。解析失败/无别名 → null。
  const activeVersion = await db.query.policyVersions.findFirst({
    where: and(eq(policyVersions.policyId, id), eq(policyVersions.version, policyData.version)),
    columns: {
      aliasSet: true,
      content: true,
      source: true,
      sourceEnvelopeSha256: true,
      sourceScopesJson: true,
      sourceToolchainId: true,
      vocabularySnapshotIds: true,
    },
  });
  // 策略的 CNL 语言（#627）：编辑器显示、编译、保存都用它，且与执行、审批冻结同一函数，
  // 保证编辑器与执行对同一版本给出同一语言。无活跃版本行（极旧数据）时按当前源码走同一判定链。
  const policyCnlLocale = resolveStoredVersionLocale({
    source: activeVersion ? (activeVersion.source ?? activeVersion.content) : policyData.content,
    aliasSet: activeVersion?.aliasSet ?? null,
    sourceEnvelopeSha256: activeVersion?.sourceEnvelopeSha256 ?? null,
    sourceScopesJson: activeVersion?.sourceScopesJson ?? null,
    sourceToolchainId: activeVersion?.sourceToolchainId ?? null,
    vocabularySnapshotIds: activeVersion?.vocabularySnapshotIds ?? null,
  });
  let initialAliasSet: Record<string, string[]> | null = null;
  if (activeVersion?.aliasSet) {
    try {
      initialAliasSet = JSON.parse(activeVersion.aliasSet) as Record<string, string[]>;
    } catch {
      initialAliasSet = null;
    }
  }

  // 冻结策略只读：套餐降级超限后该策略被冻结，不可编辑。
  // 入口处服务端拦截，避免用户进编辑器改完后才在保存时被 API 403 拒绝。
  const freeze = await isPolicyFrozen(policyData.ownerId, id);
  if (freeze.isFrozen) {
    redirect(`/${locale}/policies/${id}?frozen=1`);
  }
  const allowStructuralAliases = await getStructuralAliasGrant(session.user.id);

  // 序列化策略数据
  const policy = {
    id: policyData.id,
    name: policyData.name,
    description: policyData.description,
    content: policyData.content,
    isPublic: policyData.isPublic,
    groupId: policyData.groupId,
    aliasSet: initialAliasSet,
  };

  // 预渲染所有翻译字符串
  const translations = {
    form: {
      editTitle: t('form.editTitle'),
      editSubtitle: t('form.editSubtitle'),
      name: t('form.name'),
      namePlaceholder: t('form.namePlaceholder'),
      description: t('form.description'),
      descriptionPlaceholder: t('form.descriptionPlaceholder'),
      content: t('form.content'),
      contentPlaceholder: t('form.contentPlaceholder'),
      contentHelp: t('form.contentHelp'),
      isPublic: t('form.isPublic'),
      cancel: t('form.cancel'),
      save: t('form.save'),
      saving: t('form.saving'),
      failedToUpdate: t('form.failedToUpdate'),
    },
  };

  return (
    <EditPolicyContent
      policy={policy}
      translations={translations}
      locale={locale}
      policyCnlLocale={policyCnlLocale}
      allowStructuralAliases={allowStructuralAliases}
    />
  );
}
