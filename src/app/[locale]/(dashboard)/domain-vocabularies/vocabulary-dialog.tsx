'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  Alert,
  AlertDescription,
  Button,
  Input,
  Label,
  Select,
  Textarea,
} from '@/components/ui';
import { checkVocabularyScope } from '@/lib/domain-vocabulary-format';
import { KIND_OPTIONS, type Kind } from './constants';
import { useFocusTrap } from './use-focus-trap';

function isKnownKind(value: string | undefined): value is Kind {
  return value !== undefined && (KIND_OPTIONS as readonly string[]).includes(value);
}

/**
 * Shape sent to the API. The dialog normalizes aliases (CSV → array)
 * and trims string fields before calling onSave.
 */
export interface VocabularyDialogValues {
  domain: string;
  locale: string;
  kind: Kind;
  canonical: string;
  localized: string;
  parentCanonical?: string;
  description?: string;
  aliases?: string[];
}

interface InitialValues {
  domain?: string;
  locale?: string;
  kind?: string;
  canonical?: string;
  localized?: string;
  parentCanonical?: string | null;
  description?: string | null;
  aliases?: string[];
}

interface VocabularyDialogProps {
  isOpen: boolean;
  mode: 'create' | 'edit';
  initialValues?: InitialValues;
  isSaving?: boolean;
  onClose: () => void;
  onSave: (values: VocabularyDialogValues) => Promise<void>;
}

/**
 * Create/edit dialog for a single vocabulary term link.
 *
 * The dialog is a controlled overlay (backdrop + card). Escape closes
 * it unless a save is in flight. The dialog re-seeds its form state
 * every time it opens so reopening for a different row picks up the
 * new initial values.
 */
export function VocabularyDialog({
  isOpen,
  mode,
  initialValues,
  isSaving = false,
  onClose,
  onSave,
}: VocabularyDialogProps) {
  const t = useTranslations('domainVocabularies.dialog');
  const tKinds = useTranslations('domainVocabularies.kinds');
  const titleId = useId();
  const firstFieldRef = useRef<HTMLInputElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);

  const [domain, setDomain] = useState('');
  const [locale, setLocale] = useState('');
  const [kind, setKind] = useState<Kind>('struct');
  const [canonical, setCanonical] = useState('');
  const [localized, setLocalized] = useState('');
  const [parentCanonical, setParentCanonical] = useState('');
  const [description, setDescription] = useState('');
  const [aliasesInput, setAliasesInput] = useState('');
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, boolean>>({});

  // Re-seed on open. Avoids the "previous edit's values leaking into a
  // create flow" bug that hand-rolled dialogs reliably ship.
  useEffect(() => {
    if (!isOpen) return;
    // 打开时按 initialValues 重播表单状态（防上次编辑泄漏），故意在 effect 内 set
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDomain(initialValues?.domain ?? '');
    setLocale(initialValues?.locale ?? '');
    setKind(isKnownKind(initialValues?.kind) ? initialValues.kind : 'struct');
    setCanonical(initialValues?.canonical ?? '');
    setLocalized(initialValues?.localized ?? '');
    setParentCanonical(initialValues?.parentCanonical ?? '');
    setDescription(initialValues?.description ?? '');
    setAliasesInput((initialValues?.aliases ?? []).join(', '));
    setError('');
    setFieldErrors({});

    // Focus the first field after the browser paints the dialog.
    const id = window.requestAnimationFrame(() => {
      firstFieldRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(id);
  }, [isOpen, initialValues]);

  // ESC + Tab focus trap. The hook centralizes the WCAG 2.4.3 / 2.1.2
  // expectations for aria-modal=true containers.
  const onEscape = useCallback(() => {
    if (!isSaving) onClose();
  }, [isSaving, onClose]);
  useFocusTrap(formRef, isOpen, onEscape);

  if (!isOpen) return null;

  const validate = (): VocabularyDialogValues | null => {
    const errors: Record<string, boolean> = {};
    const required = (value: string, key: string) => {
      const trimmed = value.trim();
      if (!trimmed) errors[key] = true;
      return trimmed;
    };

    const v: VocabularyDialogValues = {
      domain: required(domain, 'domain'),
      locale: required(locale, 'locale'),
      kind,
      canonical: required(canonical, 'canonical'),
      localized: required(localized, 'localized'),
    };
    if (kind === 'field') {
      v.parentCanonical = required(parentCanonical, 'parentCanonical');
    } else if (parentCanonical.trim()) {
      v.parentCanonical = parentCanonical.trim();
    }
    const trimmedDesc = description.trim();
    if (trimmedDesc) v.description = trimmedDesc;

    const aliases = aliasesInput
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean);
    if (aliases.length > 0) v.aliases = aliases;

    // 与服务端同一份格式规则（#612）：只在字段非空时检查格式，空值走上面的必填提示。
    const scope = checkVocabularyScope(v);
    const formatIssues = scope.issues.filter((issue) =>
      issue === 'domain_format' ? Boolean(v.domain) : Boolean(v.locale),
    );
    if (formatIssues.includes('domain_format')) errors.domain = true;
    if (formatIssues.includes('locale_format')) errors.locale = true;

    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      setError(firstErrorMessage(errors, formatIssues));
      return null;
    }
    return { ...v, locale: scope.locale };
  };

  // 校验失败不是「保存失败请重试」：能说明原因的直接说明（缺 Parent struct #590、格式不对 #612）。
  const firstErrorMessage = (
    errors: Record<string, boolean>,
    formatIssues: string[],
  ): string => {
    if (errors.parentCanonical) return t('parentCanonicalHelp');
    if (formatIssues.includes('domain_format')) return t('domainInvalid');
    if (formatIssues.includes('locale_format')) return t('localeInvalid');
    return t('errorGeneric');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSaving) return;
    const values = validate();
    if (!values) return;
    setError('');
    try {
      await onSave(values);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errorGeneric'));
    }
  };

  const title = mode === 'create' ? t('createTitle') : t('editTitle');

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      {/* Backdrop. Click closes (unless saving). tabIndex=-1 keeps it
          out of the Tab cycle so the focus trap inside the form is the
          only path; keyboard users still close via Esc. */}
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        className="absolute inset-0 bg-black/40"
        onClick={() => {
          if (!isSaving) onClose();
        }}
      />

      <form
        ref={formRef}
        onSubmit={handleSubmit}
        className="relative z-10 w-full max-w-2xl rounded-lg bg-bg shadow-xl"
      >
        <header className="flex items-center justify-between border-b border-border px-6 py-4">
          <h2 id={titleId} className="font-display text-lg font-semibold text-fg">
            {title}
          </h2>
          <button
            type="button"
            onClick={() => {
              if (!isSaving) onClose();
            }}
            aria-label={t('cancel')}
            className="rounded p-1 text-fg-muted hover:bg-bg-subtle hover:text-fg focus:outline-none focus-visible:shadow-ring"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </header>

        <div className="grid gap-4 px-6 py-4 sm:grid-cols-2">
          <Field
            id="vd-domain"
            label={t('domain')}
            help={t('domainHelp')}
            error={fieldErrors.domain}
            required
          >
            <Input
              ref={firstFieldRef}
              id="vd-domain"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              state={fieldErrors.domain ? 'invalid' : 'default'}
              autoComplete="off"
              required
            />
          </Field>

          <Field
            id="vd-locale"
            label={t('locale')}
            help={t('localeHelp')}
            error={fieldErrors.locale}
            required
          >
            <Input
              id="vd-locale"
              value={locale}
              onChange={(e) => setLocale(e.target.value)}
              state={fieldErrors.locale ? 'invalid' : 'default'}
              autoComplete="off"
              required
            />
          </Field>

          <Field id="vd-kind" label={t('kind')} required>
            <Select
              id="vd-kind"
              value={kind}
              onChange={(e) => setKind(e.target.value as Kind)}
              required
            >
              {KIND_OPTIONS.map((k) => (
                <option key={k} value={k}>
                  {tKinds(k)}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            id="vd-canonical"
            label={t('canonical')}
            help={t('canonicalHelp')}
            error={fieldErrors.canonical}
            required
          >
            <Input
              id="vd-canonical"
              value={canonical}
              onChange={(e) => setCanonical(e.target.value)}
              state={fieldErrors.canonical ? 'invalid' : 'default'}
              autoComplete="off"
              required
            />
          </Field>

          <Field
            id="vd-localized"
            label={t('localized')}
            error={fieldErrors.localized}
            required
          >
            <Input
              id="vd-localized"
              value={localized}
              onChange={(e) => setLocalized(e.target.value)}
              state={fieldErrors.localized ? 'invalid' : 'default'}
              autoComplete="off"
              required
            />
          </Field>

          <Field
            id="vd-parent"
            label={kind === 'field' ? withoutOptionalSuffix(t('parentCanonical')) : t('parentCanonical')}
            help={t('parentCanonicalHelp')}
            error={fieldErrors.parentCanonical}
            required={kind === 'field'}
          >
            <Input
              id="vd-parent"
              value={parentCanonical}
              onChange={(e) => setParentCanonical(e.target.value)}
              state={fieldErrors.parentCanonical ? 'invalid' : 'default'}
              autoComplete="off"
            />
          </Field>

          <div className="sm:col-span-2">
            <Field id="vd-aliases" label={t('aliases')} help={t('aliasesHelp')}>
              <Input
                id="vd-aliases"
                value={aliasesInput}
                onChange={(e) => setAliasesInput(e.target.value)}
                autoComplete="off"
              />
            </Field>
          </div>

          <div className="sm:col-span-2">
            <Field id="vd-description" label={t('description')}>
              <Textarea
                id="vd-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
              />
            </Field>
          </div>
        </div>

        {error ? (
          <div className="px-6">
            <Alert variant="danger">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          </div>
        ) : null}

        <footer className="flex items-center justify-end gap-2 border-t border-border px-6 py-4">
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              if (!isSaving) onClose();
            }}
            disabled={isSaving}
          >
            {t('cancel')}
          </Button>
          <Button type="submit" variant="primary" disabled={isSaving}>
            {isSaving ? t('saving') : t('save')}
          </Button>
        </footer>
      </form>
    </div>
  );
}

interface FieldProps {
  id: string;
  label: string;
  help?: string;
  error?: boolean;
  required?: boolean;
  children: React.ReactNode;
}

function Field({ id, label, help, error, required, children }: FieldProps) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>
        {label}
        {required ? (
          <span aria-hidden="true" className="ml-0.5 text-danger">
            *
          </span>
        ) : null}
      </Label>
      {children}
      {help ? (
        <p className={`text-xs ${error ? 'text-danger' : 'text-fg-subtle'}`}>
          {help}
        </p>
      ) : null}
    </div>
  );
}

/**
 * 去掉标签末尾的「(optional)」类括注（各语言均为末尾括注：en/de「(optional)」、zh「（可选）」）。
 * kind=field 时 Parent struct 必填，标签不能再写「optional」（#590：此前显示「Parent struct (optional)*」）。
 */
export function withoutOptionalSuffix(label: string): string {
  return label.replace(/\s*[（(][^（()）]*[)）]\s*$/u, '');
}
