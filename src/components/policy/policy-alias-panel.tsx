'use client';

import { ChevronDown, ChevronRight, Lock } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Alert, AlertDescription, Input, Label, cn } from '@/components/ui';
import { getLexicon } from '@/lib/aster-lexicon';
import {
  parseAliasInput,
  validateUserAliases,
  type AliasIssue,
  type ReservedSets,
} from '@/lib/policy-alias-shared';
import {
  ALIAS_KIND_GROUPS,
  ALL_ALIAS_KINDS,
  kindToSemanticToken,
  type AliasKindGroup,
  type AliasKindMeta,
} from './policy-alias-types';
import { useAliasIssueMessage } from './use-alias-issue-message';

export interface PolicyAliasPanelProps {
  aliasSet: Record<string, string[]>;
  locale: string;
  reservedSets: ReservedSets;
  allowStructural: boolean;
  onChange: (aliasSet: Record<string, string[]>) => void;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}

function configuredCount(aliasSet: Record<string, string[]>): number {
  return Object.values(aliasSet).reduce(
    (sum, values) => sum + values.filter((v) => v.trim()).length,
    0,
  );
}

function kindsForGroup(group: AliasKindGroup): AliasKindMeta[] {
  return ALL_ALIAS_KINDS.filter((meta) => meta.group === group);
}

export function PolicyAliasPanel({
  aliasSet,
  locale,
  reservedSets,
  allowStructural,
  onChange,
  expanded,
  onExpandedChange,
}: PolicyAliasPanelProps) {
  const t = useTranslations('policies.form.aliases');
  const panelId = 'policy-alias-panel-body';
  const lexicon = useMemo(() => getLexicon(locale), [locale]);
  const count = configuredCount(aliasSet);
  // 整体校验一次：跨 kind 重复等问题只有看全集才能发现，按 kind 分发到对应行（两行都标错）。
  const issues = validateUserAliases(aliasSet, reservedSets, { allowStructural }).issues;
  const issuesFor = (kind: string) =>
    issues.filter((issue) => issue.kind === kind || issue.otherKind === kind);

  const updateKind = (kind: string, raw: string) => {
    const values = parseAliasInput(raw);
    const next = { ...aliasSet };
    if (values.length > 0) {
      next[kind] = values;
    } else {
      delete next[kind];
    }
    onChange(next);
  };

  return (
    <section className="rounded-xl border border-border bg-bg shadow-sm">
      <button
        type="button"
        onClick={() => onExpandedChange(!expanded)}
        aria-expanded={expanded}
        aria-controls={panelId}
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
        <span className="font-medium text-fg">{t('title')}</span>
        <span className="text-xs text-fg-muted">·</span>
        <span className="text-xs text-fg-muted">
          {count > 0 ? t('configuredCount', { count }) : t('hint')}
        </span>
      </button>

      {expanded && (
        <div id={panelId} className="space-y-5 px-5 py-5">
          <p className="text-sm text-fg-muted">{t('hint')}</p>
          {ALIAS_KIND_GROUPS.map((group) => {
            const structural = group.group === 'structural';
            const locked = structural && !allowStructural;
            return (
              <div key={group.group} className="space-y-2">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-fg">
                    {t(group.labelKey)}
                  </h3>
                  {locked && (
                    <span className="inline-flex items-center gap-1 text-xs text-fg-muted">
                      <Lock aria-hidden className="size-3" />
                      {t('structuralLocked')}
                    </span>
                  )}
                </div>
                <div className="divide-y divide-border rounded-lg border border-border">
                  {kindsForGroup(group.group).map((meta) => (
                    <AliasKindRow
                      key={meta.kind}
                      meta={meta}
                      value={(aliasSet[meta.kind] ?? []).join(', ')}
                      canonical={String(
                        lexicon.keywords[kindToSemanticToken(meta.kind)] ?? meta.kind,
                      )}
                      locked={locked}
                      issues={issuesFor(meta.kind)}
                      onChange={updateKind}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function AliasKindRow({
  meta,
  value,
  canonical,
  locked,
  issues,
  onChange,
}: {
  meta: AliasKindMeta;
  value: string;
  canonical: string;
  locked: boolean;
  issues: readonly AliasIssue[];
  onChange: (kind: string, raw: string) => void;
}) {
  const t = useTranslations('policies.form.aliases');
  const issueMessage = useAliasIssueMessage();
  // 编辑中保留输入原文：规范化后的 value 会吞掉末尾空格/逗号，导致无法逐字输入多词别名。
  // 每次输入仍即时解析回传（保存不依赖失焦）；失焦后回到规范化展示。
  // draft 记下原文及其解析结果；外部改了 aliasSet（恢复草稿、重置）使 value 与本行上次回传的
  // 结果不一致时，原文作废，直接显示外部值。
  const [draft, setDraft] = useState<{ raw: string; emitted: string } | null>(null);
  const shown = draft && draft.emitted === value ? draft.raw : value;
  const inputId = `policy-alias-${meta.kind}`;
  const errorId = `${inputId}-error`;
  const invalid = issues.length > 0;

  return (
    <div className={cn('grid gap-3 p-3 md:grid-cols-[8rem_1fr_1.4fr]', locked && 'opacity-60')}>
      <div className="flex items-center gap-2">
        <span className="inline-flex h-7 min-w-9 items-center justify-center rounded-md border border-border bg-bg-subtle px-2 font-mono text-xs text-fg">
          {meta.symbol}
        </span>
        <span className="text-sm font-medium text-fg">{t(`kinds.${meta.labelKey}`)}</span>
      </div>
      <div className="min-w-0">
        <span className="block text-xs text-fg-muted">{t('canonical')}</span>
        <span className="block truncate font-mono text-sm text-fg" title={canonical}>
          {canonical}
        </span>
      </div>
      <div className="min-w-0">
        <Label htmlFor={inputId} className="sr-only">
          {t('inputLabel', { kind: t(`kinds.${meta.labelKey}`) })}
        </Label>
        <Input
          id={inputId}
          value={shown}
          disabled={locked}
          onChange={(event) => {
            const raw = event.target.value;
            setDraft({ raw, emitted: parseAliasInput(raw).join(', ') });
            onChange(meta.kind, raw);
          }}
          onBlur={() => setDraft(null)}
          placeholder={t('placeholder')}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? errorId : undefined}
        />
        {invalid && (
          <Alert id={errorId} role="alert" variant="danger" className="mt-2 py-2">
            <AlertDescription className="text-xs">
              {issues.map(issueMessage).join(' ')}
            </AlertDescription>
          </Alert>
        )}
      </div>
    </div>
  );
}
