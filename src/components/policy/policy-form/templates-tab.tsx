'use client';

/**
 * 侧栏「模板」标签：按类别列出内置模板，点击即整体替换编辑器内容（有内容时由父层先确认）。
 *
 * 带 `requires` 的模板（如 #791 结构化编写展示模板）在能力不满足时显示为锁定：不可点击，
 * 说明缺哪项能力并链接到文档。普通模板（只替换源码）不受影响，对无能力的用户与以前一致。
 */
import { useTranslations } from 'next-intl';
import { Lock } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import {
  CATEGORY_LABELS,
  POLICY_EXAMPLES,
  getExampleDescription,
  getExampleName,
  hasTemplateExtras,
  isTemplateAvailable,
  normalizeLocale,
  type PolicyExample,
  type TemplateCapabilities,
} from '@/data/policy-examples';

export function TemplatesTab({
  uiLocale,
  capabilities,
  onSelect,
}: {
  uiLocale: string;
  capabilities: TemplateCapabilities;
  onSelect: (t: PolicyExample) => void;
}) {
  const t = useTranslations('policies.form');
  const categories = Object.keys(CATEGORY_LABELS) as Array<keyof typeof CATEGORY_LABELS>;
  // 点击模板会清空并整体替换编辑器内容（非插入到光标）。文案本仓内联三语，
  // 避免为一句提示走 ui-messages 跨仓发版。
  const hint = uiLocale.startsWith('zh')
    ? '点击模板会清空编辑器并替换为该模板内容。'
    : uiLocale.startsWith('de')
      ? 'Ein Klick ersetzt den gesamten Editorinhalt durch die Vorlage.'
      : 'Picking a template clears the editor and replaces its content.';

  return (
    // 内边距对齐关键词别名/策略信息卡片（px-5 py-5），各 tab 内容起始位置一致。
    <div className="space-y-4 px-5 py-5">
      <p className="text-xs text-fg-muted">{hint}</p>
      {categories.map((category) => {
        const items = POLICY_EXAMPLES.filter((e) => e.category === category);
        if (items.length === 0) return null;
        return (
          <div key={category}>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-fg-subtle">
              {CATEGORY_LABELS[category][normalizeLocale(uiLocale)]}
            </h3>
            <ul className="space-y-1">
              {items.map((example) => (
                <li key={example.id}>
                  {isTemplateAvailable(example, capabilities) ? (
                    <button
                      type="button"
                      onClick={() => onSelect(example)}
                      className="w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-bg-subtle focus-visible:outline-none focus-visible:shadow-ring"
                    >
                      <TemplateText example={example} uiLocale={uiLocale} />
                      {hasTemplateExtras(example) && (
                        <div className="mt-1 text-xs text-fg-subtle">{t('templateIncludesExtras')}</div>
                      )}
                    </button>
                  ) : (
                    <LockedTemplate example={example} uiLocale={uiLocale} capabilities={capabilities} />
                  )}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function TemplateText({ example, uiLocale }: { example: PolicyExample; uiLocale: string }) {
  return (
    <>
      <div className="text-sm font-medium text-fg">{getExampleName(example, uiLocale)}</div>
      <div className="mt-0.5 text-xs text-fg-muted">{getExampleDescription(example, uiLocale)}</div>
    </>
  );
}

/** 锁定的模板：不可点击，说明缺哪项能力，并给出授权与排版文档入口。 */
function LockedTemplate({
  example,
  uiLocale,
  capabilities,
}: {
  example: PolicyExample;
  uiLocale: string;
  capabilities: TemplateCapabilities;
}) {
  const t = useTranslations('policies.form');
  const requires = example.requires ?? {};
  const reasons = [
    requires.structuredAuthoring && !capabilities.structuredAuthoring ? t('templateRequiresStructuredAuthoring') : null,
    requires.structuralAliases && !capabilities.structuralAliases ? t('templateRequiresStructuralAliases') : null,
  ].filter((r): r is string => r !== null);
  return (
    <div
      data-testid={`template-locked-${example.id}`}
      aria-disabled="true"
      className="rounded-md border border-dashed border-border px-2 py-1.5 opacity-80"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <TemplateText example={example} uiLocale={uiLocale} />
        </div>
        <span className="inline-flex shrink-0 items-center gap-1 rounded bg-bg-subtle px-1.5 py-0.5 text-[11px] font-medium text-fg-muted">
          <Lock className="h-3 w-3" aria-hidden="true" />
          {t('templateLocked')}
        </span>
      </div>
      {reasons.map((reason) => (
        <p key={reason} className="mt-1 text-xs text-fg-muted">
          {reason}
        </p>
      ))}
      <p className="mt-1 flex flex-wrap gap-x-3 text-xs">
        <Link href="/docs/guides/structured-authoring-admin" className="font-medium text-primary underline hover:no-underline">
          {t('templateDocsAdmin')}
        </Link>
        <Link href="/docs/guides/display-layouts" className="font-medium text-primary underline hover:no-underline">
          {t('templateDocsLayouts')}
        </Link>
      </p>
    </div>
  );
}
