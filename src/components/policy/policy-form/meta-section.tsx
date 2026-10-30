'use client';

import { ChevronDown, ChevronRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { PolicyGroupSelect } from '@/components/policy/policy-group-select';
import { cn } from '@/components/ui';

/**
 * Collapsible meta section for the policy form.
 *
 * Holds name / description / group / public-toggle. Defaults to
 * expanded on the new-policy route (the user just sees an empty
 * form and needs to know what to fill) and collapsed on edit (the
 * primary task there is touching the rule body — meta is rarely
 * the reason to land on the page).
 *
 * Field design choices vs. the old form:
 *   - Description is a <textarea> rather than <input>. Authors
 *     describe what a policy does, and three lines fit that better
 *     than a 1-line input that truncates.
 *   - Public toggle gets an explanation paragraph — "what does
 *     public mean?" was an unanswered question in the old version.
 *   - Group + Public sit on the same row at md+ widths to keep
 *     the section vertically compact when expanded.
 */

export interface MetaSectionProps {
  name: string;
  description: string;
  groupId: string | null;
  isPublic: boolean;
  locale: string;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onNameChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onGroupIdChange: (value: string | null) => void;
  onIsPublicChange: (value: boolean) => void;
  /** 当前用户不能切换公开状态（团队策略只有 owner/admin 可以，ADR 0016）：复选框只读并给出说明 */
  visibilityLocked?: boolean;
  /** Optional inline error to render under the name field — used
   *  for "name is required" without spinning up a full Alert. */
  nameError?: string | null;
}

export function MetaSection({
  name,
  description,
  groupId,
  isPublic,
  locale,
  expanded,
  onExpandedChange,
  onNameChange,
  onDescriptionChange,
  onGroupIdChange,
  onIsPublicChange,
  visibilityLocked = false,
  nameError,
}: MetaSectionProps) {
  const t = useTranslations('policies.form');

  const isZh = locale.startsWith('zh');
  const groupLabel = isZh ? '分组' : 'Group';
  const groupPlaceholder = isZh ? '选择分组（可选）...' : 'Select a group (optional)...';

  return (
    <section className="rounded-xl border border-border bg-bg shadow-sm">
      <button
        type="button"
        onClick={() => onExpandedChange(!expanded)}
        aria-expanded={expanded}
        aria-controls="policy-meta-body"
        className={cn(
          'flex w-full items-center gap-2 px-5 py-3 text-left',
          'transition-colors hover:bg-bg-subtle',
          'focus-visible:outline-none focus-visible:shadow-ring',
          expanded && 'border-b border-border',
        )}
      >
        {expanded ? (
          <ChevronDown aria-hidden className="size-4 text-fg-muted" />
        ) : (
          <ChevronRight aria-hidden className="size-4 text-fg-muted" />
        )}
        <span className="font-medium text-fg">{t('metaSection')}</span>
        <span className="text-xs text-fg-muted">·</span>
        <span className="text-xs text-fg-muted">{t('metaSectionHint')}</span>
        {/* When collapsed, surface the policy name inline so the user
            knows what they're editing without expanding. */}
        {!expanded && name && (
          <>
            <span className="text-xs text-fg-muted">·</span>
            <span className="truncate text-xs text-fg" title={name}>
              {name}
            </span>
          </>
        )}
      </button>

      {expanded && (
        <div id="policy-meta-body" className="space-y-5 px-5 py-5">
          <div>
            <label
              htmlFor="policy-name"
              className="block text-sm font-medium text-fg"
            >
              {t('name')}
              <span className="ml-1 text-danger" aria-hidden>*</span>
            </label>
            <input
              id="policy-name"
              type="text"
              value={name}
              onChange={(e) => onNameChange(e.target.value)}
              required
              autoComplete="off"
              aria-invalid={!!nameError || undefined}
              aria-describedby={nameError ? 'policy-name-error' : undefined}
              className={cn(
                'mt-1.5 block w-full rounded-lg border bg-bg px-3 py-2 text-sm text-fg shadow-sm transition-colors',
                'placeholder:text-fg-subtle',
                'focus:outline-none focus:ring-2 focus:ring-primary/20',
                nameError
                  ? 'border-danger focus:border-danger'
                  : 'border-border-strong focus:border-primary',
              )}
              placeholder={t('namePlaceholder')}
            />
            {nameError && (
              <p id="policy-name-error" className="mt-1 text-xs text-danger">
                {nameError}
              </p>
            )}
          </div>

          <div>
            <label
              htmlFor="policy-description"
              className="block text-sm font-medium text-fg"
            >
              {t('description')}
            </label>
            <textarea
              id="policy-description"
              value={description}
              onChange={(e) => onDescriptionChange(e.target.value)}
              rows={2}
              className={cn(
                'mt-1.5 block w-full resize-y rounded-lg border border-border-strong bg-bg px-3 py-2 text-sm text-fg shadow-sm transition-colors',
                'placeholder:text-fg-subtle',
                'focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20',
              )}
              placeholder={t('descriptionPlaceholder')}
            />
          </div>

          <div className="grid gap-5 md:grid-cols-2">
            <PolicyGroupSelect
              value={groupId}
              onChange={onGroupIdChange}
              label={groupLabel}
              placeholder={groupPlaceholder}
            />

            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-fg">
                {isZh ? '可见性' : 'Visibility'}
              </span>
              <label className="inline-flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={isPublic}
                  disabled={visibilityLocked}
                  onChange={(e) => onIsPublicChange(e.target.checked)}
                  className="size-4 cursor-pointer rounded border-border-strong text-primary focus:ring-2 focus:ring-primary/20"
                />
                <span className="text-sm text-fg">{t('isPublic')}</span>
              </label>
              {visibilityLocked && (
                <p className="text-xs text-fg-muted">{t('visibilityOwnerAdminOnly')}</p>
              )}
              <p className="text-xs text-fg-muted">
                {isZh
                  ? '勾选后，拥有链接的任何人均可只读查看此策略源代码。不影响执行权限。'
                  : 'When checked, anyone with the link can view this policy source read-only. Execution permissions are unaffected.'}
              </p>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
