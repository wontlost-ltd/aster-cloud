'use client';

import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { PolicyForm, type PolicySaveContext } from '@/components/policy/policy-form';
import type { PolicyDraftFields } from '@/components/policy/policy-form/use-policy-draft';
import { extractErrorMessage } from '@/lib/api/error-envelope';
import { getSnippetTemplate } from '@/lib/playground/snippet-templates';

/**
 * /policies/new — thin wrapper around <PolicyForm>.
 *
 * All UI lives in the shared PolicyForm component (IDE layout +
 * autosave + shortcuts). This wrapper only owns the create-specific
 * concerns: POST /api/policies on save, navigate to the new detail
 * page, surface upgrade prompts.
 *
 * Team-scoped creation: when the URL carries `?teamId=<id>` (the
 * "+ New policy" button on /teams/[id]/policies routes here), the
 * same endpoint persists the policy under that team. Permission
 * (POLICY_CREATE on the team) is checked server-side in
 * /api/policies POST. This unifies the old standalone team policy
 * form into the single shared editor.
 */

interface NewPolicyContentProps {
  locale: string;
  allowStructuralAliases: boolean;
}

const EMPTY: PolicyDraftFields = {
  name: '',
  description: '',
  content: '',
  isPublic: false,
  groupId: null,
  aliasSet: null,
};

export function NewPolicyContent({
  locale,
  allowStructuralAliases,
}: NewPolicyContentProps) {
  const t = useTranslations('policies');
  const searchParams = useSearchParams();
  const teamId = searchParams.get('teamId') || undefined;

  // Docs deeplink: `/policies/new?from=docs&template=<id>` loads the
  // matching snippet from the server-side allow-list registry. Unknown
  // ids silently fall back to the empty editor — the URL is never
  // trusted to carry raw source.
  const initial: PolicyDraftFields = useMemo(() => {
    const templateId = searchParams.get('template');
    if (!templateId) return EMPTY;
    const template = getSnippetTemplate(templateId);
    if (!template) return EMPTY;
    return { ...EMPTY, content: template.source };
  }, [searchParams]);

  const handleSave = useCallback(
    async (fields: PolicyDraftFields, { locale: cnlLocale }: PolicySaveContext) => {
      // locale 是策略的 CNL 语言（按源码识别），不是界面语言：德语界面写英文策略应按 en-US 编译与记录（#627）
      const res = await fetch('/api/policies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...fields, teamId, locale: cnlLocale }),
      });
      const data = await res.json();
      if (!res.ok) {
        return {
          message: data.message || extractErrorMessage(data) || t('form.failedToCreate'),
          code: data.code ?? data.error?.code ?? data.error,
          diagnostics: data.diagnostics,
          upgrade: !!data.upgrade,
        };
      }
      return { id: data.id as string };
    },
    [t, teamId],
  );

  return (
    <PolicyForm
      mode="create"
      uiLocale={locale}
      policyId={null}
      initial={initial}
      title={t('form.createTitle')}
      subtitle={t('form.createSubtitle')}
      onSave={handleSave}
      allowStructuralAliases={allowStructuralAliases}
      cancelHref={`/${locale}/policies`}
      detailHrefFor={(id) => `/${locale}/policies/${id}`}
      breadcrumbs={[
        { label: t('title'), href: '/policies' },
        { label: t('form.createTitle') },
      ]}
    />
  );
}
