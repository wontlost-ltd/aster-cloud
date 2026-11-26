import { getTranslations } from 'next-intl/server';
import { redirect, notFound } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { authorizePolicyAction, loadPolicyForAction } from '@/lib/policy-access';
import { db, policyVersions } from '@/lib/prisma';
import { eq, and } from 'drizzle-orm';
import { isPolicyFrozen } from '@/lib/policy-freeze';
import { EditPolicyContent } from './edit-policy-content';
import { getStructuralAliasGrant } from '@/lib/structural-alias-grants';
import { resolveEntitlementForRequest } from '@/lib/capabilities/resolve';
import { toEditorAuthoringProps } from '@/lib/capabilities/editor-props';
import { isNameEscapeEnabled } from '@/lib/platform-settings';
import { localizedTitle } from '@/lib/page-metadata';
import { resolveStoredVersionLocale } from '@/lib/policy-version-locale';
import { activeLayoutSha256, loadVersionLayout } from '@/lib/policy-layout/store';
import { layoutForCanonical } from '@/lib/policy-layout/reconcile';
import { parseStoredEmbeddedVocabulary, type EmbeddedVocabulary } from '@/lib/policy-embedded-vocabulary';

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
        teamId: access.policy.teamId || null,
      }
    : null;
  // 切换公开状态需要 publish（团队策略 owner/admin），member 编辑时复选框只读
  const canPublish = access.ok
    ? (await authorizePolicyAction({ userId: session.user.id }, access.policy, 'publish')).allowed
    : false;

  if (!policyData) {
    notFound();
  }

  // C2：加载活跃版本冻结的 aliasSet（canonical JSON），使编辑器预填现有别名。
  // 版本号 = Policy.version（与 content 同源的活跃版本）。解析失败/无别名 → null。
  const activeVersion = await db.query.policyVersions.findFirst({
    where: and(eq(policyVersions.policyId, id), eq(policyVersions.version, policyData.version)),
    columns: {
      id: true,
      aliasSet: true,
      embeddedVocabulary: true,
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

  // 活跃版本的策略内嵌词汇（ADR 0060）：与能力无关地下发——它是编译输入，编辑器编译与 LSP 都要用；
  // 无能力的作者只看到只读列表，保存时省略字段由服务端沿用。已存文本损坏时不预填（保存沿用时服务端 400 并说明）。
  let initialEmbeddedVocabulary: EmbeddedVocabulary | null = null;
  try {
    initialEmbeddedVocabulary = parseStoredEmbeddedVocabulary(activeVersion?.embeddedVocabulary ?? null);
  } catch {
    initialEmbeddedVocabulary = null;
  }

  // 冻结策略只读：套餐降级超限后该策略被冻结，不可编辑。
  // 入口处服务端拦截，避免用户进编辑器改完后才在保存时被 API 403 拒绝。
  const freeze = await isPolicyFrozen(policyData.ownerId, id);
  if (freeze.isFrozen) {
    redirect(`/${locale}/policies/${id}?frozen=1`);
  }
  const allowStructuralAliases = await getStructuralAliasGrant(session.user.id);
  // 能力按策略所属团队判定套餐（个人策略为 null）（ADR 0058 §4.10）
  const structuredAuthoring = toEditorAuthoringProps(
    await resolveEntitlementForRequest(session.user.id, 'structured_authoring', {
      teamId: policyData.teamId ?? null,
    }),
  );
  // 编辑器名字转义（ADR 0058 修订 3）：平台开关，缺行 / 读库失败一律关闭
  const nameEscape = await isNameEscapeEnabled();

  // 显示排版（ADR 0058 §7.4）：是否带排版与能力无关（保存前的丢弃提示要用）；排版本身只给有权的作者加载。
  // 编辑器里的源码是 Policy.content，排版须与它逐字对应，否则按不一致处理、不加载（绝不加载过期排版）。
  const hasActiveLayout = activeVersion ? (await activeLayoutSha256(activeVersion.id)) !== null : false;
  const storedLayout =
    structuredAuthoring.allowed && hasActiveLayout && activeVersion
      ? layoutForCanonical(await loadVersionLayout(activeVersion.id), policyData.content)
      : null;

  // 序列化策略数据
  const policy = {
    id: policyData.id,
    name: policyData.name,
    description: policyData.description,
    content: policyData.content,
    isPublic: policyData.isPublic,
    groupId: policyData.groupId,
    teamId: policyData.teamId,
    aliasSet: initialAliasSet,
    embeddedVocabulary: initialEmbeddedVocabulary,
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
      structuredAuthoring={structuredAuthoring}
      nameEscape={nameEscape}
      visibilityLocked={!canPublish}
      hasActiveLayout={hasActiveLayout}
      initialLayout={storedLayout?.status === 'ok' ? storedLayout.layout : null}
      initialLayoutInconsistent={storedLayout?.status === 'inconsistent'}
    />
  );
}
