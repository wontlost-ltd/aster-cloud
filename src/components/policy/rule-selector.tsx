'use client';

import { useId } from 'react';
import { useTranslations } from 'next-intl';
import type { RuleSymbol } from '@/lib/aster/rules';

interface RuleSelectorProps {
  rules: RuleSymbol[];
  value: string | null;
  onChange: (value: string | null) => void;
}

export function RuleSelector({ rules, value, onChange }: RuleSelectorProps) {
  const t = useTranslations('policies.ruleSelector');
  const hintId = useId();
  const hasRules = rules.length > 0;
  const showHint = rules.length > 1 && !value;

  return (
    <div className="space-y-2">
      <label htmlFor={hintId} className="block text-sm font-semibold text-fg">
        {t('label')}
      </label>
      <select
        id={hintId}
        value={value ?? ''}
        disabled={!hasRules}
        aria-describedby={showHint ? `${hintId}-hint` : undefined}
        onChange={(event) => onChange(event.target.value || null)}
        className="block w-full rounded-lg border border-border-strong bg-bg px-4 py-2.5 text-fg shadow-sm transition-all duration-200 focus:border-primary focus:shadow-ring focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 sm:text-sm"
      >
        {!value && (
          <option value="">
            {hasRules ? t('placeholder') : t('empty')}
          </option>
        )}
        {rules.map((rule) => (
          <option key={`${rule.name}-${rule.range.startLineNumber}`} value={rule.name}>
            {rule.isEntry ? t('entryOption', { name: rule.name }) : rule.name}
          </option>
        ))}
      </select>
      {showHint && (
        <p id={`${hintId}-hint`} className="text-xs text-amber-700 dark:text-amber-300">
          {t('ambiguousHint')}
        </p>
      )}
    </div>
  );
}
