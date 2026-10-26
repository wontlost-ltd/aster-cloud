'use client';

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { PolicyForm, type PolicySaveContext } from '@/components/policy/policy-form';
import type { PolicyDraftFields } from '@/components/policy/policy-form/use-policy-draft';
import { track, Events, levenshtein } from '@/lib/mixpanel';
import { extractErrorMessage } from '@/lib/api/error-envelope';

/**
 * /policies/[id]/edit — thin wrapper around <PolicyForm>.
 *
 * Edit-specific concerns:
 *   - PUT /api/policies/[id] on save
 *   - AI-draft telemetry (source_kind, draft_edited, draft_published)
 *     preserved from the legacy implementation so existing dashboards
 *     keep getting events
 *   - "frozen" backend response surfaces an upgrade prompt
 */

interface Policy {
  id: string;
  name: string;
  description: string | null;
  content: string;
  isPublic: boolean;
  groupId: string | null;
  /** 活跃版本冻结的关键词别名（ADR 0022），编辑器预填用。 */
  aliasSet?: Record<string, string[]> | null;
}

interface Translations {
  form: {
    editTitle: string;
    editSubtitle: string;
    failedToUpdate: string;
  };
}

interface EditPolicyContentProps {
  policy: Policy;
  translations: Translations;
  locale: string;
  /** 策略的 CNL 语言：服务端用与执行端相同的 resolveStoredVersionLocale 解析，见 policy-form/policy-cnl-locale。 */
  policyCnlLocale: string | null;
  allowStructuralAliases: boolean;
}

export function EditPolicyContent({
  policy,
  translations: t,
  locale,
  policyCnlLocale,
  allowStructuralAliases,
}: EditPolicyContentProps) {
  const tPolicies = useTranslations('policies');

  const handleSave = useCallback(
    async (fields: PolicyDraftFields, { locale: cnlLocale }: PolicySaveContext) => {
      // Preserve the legacy ai-draft telemetry hand-off. window.__asterAiDraft
      // is set by the AI assistant flow when it commits a generated body.
      const aiDraft =
        typeof window !== 'undefined' ? window.__asterAiDraft : undefined;
      const isFromAiDraft = !!aiDraft && aiDraft.content !== fields.content;
      const sourceKind: 'manual' | 'ai_draft' | 'ai_draft_edited' = !aiDraft
        ? 'manual'
        : isFromAiDraft
          ? 'ai_draft_edited'
          : 'ai_draft';

      const res = await fetch(`/api/policies/${policy.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        // 带上策略的 CNL 语言：服务端按它编译并记录进版本（缺省时会按 en-US 记录，#627）
        body: JSON.stringify({
          ...fields,
          locale: cnlLocale,
          metadata: { source_kind: sourceKind },
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        return {
          message: data.message || extractErrorMessage(data) || t.form.failedToUpdate,
          code: data.code ?? data.error?.code ?? data.error,
          diagnostics: data.diagnostics,
          upgrade: !!(data.upgrade || data.frozen),
        };
      }

      // Edit-distance telemetry (matches legacy behavior).
      if (aiDraft && isFromAiDraft) {
        const editDistance = levenshtein(aiDraft.content, fields.content);
        const maxLen = Math.max(
          aiDraft.content.length,
          fields.content.length,
          1,
        );
        track(Events.DRAFT_EDITED, {
          draft_id: policy.id,
          prompt_id: aiDraft.promptId,
          edit_distance: editDistance,
          edit_ratio: editDistance / maxLen,
          time_spent_sec: Math.round((Date.now() - aiDraft.generatedAt) / 1000),
          repair_count: aiDraft.repairCount,
        });
      }
      track(Events.DRAFT_PUBLISHED, {
        draft_id: policy.id,
        source_kind: sourceKind,
        tenant_id: undefined,
      });
      if (typeof window !== 'undefined') {
        delete window.__asterAiDraft;
      }

      return { id: policy.id };
    },
    [policy.id, t.form.failedToUpdate],
  );

  // 宽度/居中/纵向节奏不在本薄包装层处理：本页只渲染共享的 <PolicyForm>，
  // 而 PolicyForm 自身已用设计系统 <Container size="xl"> 作为结构根
  //（width authority + py 纵向节奏 + data-policy-form-root 焦点语义）。
  // new / edit 两个包装层因此保持对称的「只传 props」形态——若在此再套
  // 一层 Container 会与 PolicyForm 内层 Container 嵌套，造成双重宽度约束与
  // 双重纵向内边距。满宽贴边问题由 PolicyForm 内的 Container 统一修复。
  return (
    <PolicyForm
      mode="edit"
      uiLocale={locale}
      policyCnlLocale={policyCnlLocale}
      policyId={policy.id}
      initial={{
        name: policy.name,
        description: policy.description ?? '',
        content: policy.content,
        isPublic: policy.isPublic,
        groupId: policy.groupId,
        aliasSet: policy.aliasSet ?? null,
      }}
      title={t.form.editTitle}
      subtitle={t.form.editSubtitle}
      onSave={handleSave}
      allowStructuralAliases={allowStructuralAliases}
      cancelHref={`/${locale}/policies/${policy.id}`}
      detailHrefFor={(id) => `/${locale}/policies/${id}`}
      breadcrumbs={[
        { label: tPolicies('title'), href: '/policies' },
        {
          label: policy.name || tPolicies('detail.untitled') || 'Untitled',
          href: `/policies/${policy.id}`,
        },
        { label: t.form.editTitle },
      ]}
    />
  );
}
