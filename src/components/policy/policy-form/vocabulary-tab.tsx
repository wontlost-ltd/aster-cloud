'use client';

/**
 * 编辑器侧栏「词汇」标签（ADR 0058 §8.3，仅在 structured_authoring 为真时挂载）。
 *
 * 术语来自 useUserVocabularyRegistration 已经拉取的词条（不另发请求），按 ADR 0051 角色分为
 * 类型 / 字段（再按 parent 分组）/ 函数 / 枚举成员 / 字面量五组，可按本地化写法或规范名搜索；
 * 点击把本地化写法插入光标处（替换选区）。「把选中文字加为术语」打开词汇管理页同一个对话框，
 * 预填选中文字，保存后由词汇版本失效轮询刷新本标签。词汇的增删权限仍由服务端套餐门禁决定。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { editor as MonacoEditor } from 'monaco-editor';
import { useLocale, useTranslations } from 'next-intl';
import { Button, Input, toast } from '@/components/ui';
import {
  VocabularyDialog,
  type VocabularyDialogValues,
} from '@/app/[locale]/(dashboard)/domain-vocabularies/vocabulary-dialog';
import { useVocabularyErrors } from '@/app/[locale]/(dashboard)/domain-vocabularies/use-vocabulary-errors';
import { pollDomainVocabularyNow } from '@/hooks/useDomainVocabularyInvalidate';
import type { VocabularyTabTerm } from '@/hooks/useUserVocabularyRegistration';

export interface VocabularyTabProps {
  editor: MonacoEditor.IStandaloneCodeEditor | null;
  terms: ReadonlyArray<VocabularyTabTerm>;
  /** 策略所属团队；非空时新术语写入团队词汇（POST 带 ?teamId=），否则写入个人词汇。 */
  teamId?: string | null;
  /** 策略的 CNL 语言，用于预填对话框的语言字段。 */
  policyLocale?: string;
}

/** executeEdits 的来源标识（与模型标签页区分）。 */
const EDIT_SOURCE = 'structured-authoring.vocabulary';

type Kind = VocabularyTabTerm['kind'];

/** 分组顺序与对应的 i18n 键。 */
const GROUPS: ReadonlyArray<{ kind: Kind; key: string }> = [
  { kind: 'struct', key: 'groupStruct' },
  { kind: 'field', key: 'groupField' },
  { kind: 'function', key: 'groupFunction' },
  { kind: 'enum_value', key: 'groupEnumValue' },
  { kind: 'literal', key: 'groupLiteral' },
];

function matches(term: VocabularyTabTerm, query: string): boolean {
  return term.localized.toLowerCase().includes(query) || term.canonical.toLowerCase().includes(query);
}

/** 当前选中的文字；无编辑器或无选区返回空串。 */
function readSelection(editor: MonacoEditor.IStandaloneCodeEditor | null): string {
  const selection = editor?.getSelection();
  if (!editor || !selection) return '';
  return editor.getModel()?.getValueInRange(selection) ?? '';
}

/** 把术语的本地化写法插入光标处（替换选区），进入撤销栈。 */
function insertLocalized(editor: MonacoEditor.IStandaloneCodeEditor, localized: string): void {
  const range = editor.getSelection();
  if (!range) return;
  editor.executeEdits(EDIT_SOURCE, [{ range, text: localized, forceMoveMarkers: true }]);
  editor.pushUndoStop();
  editor.focus();
}

/** 提交新术语；失败时抛出已按错误码本地化的错误，对话框据此保持打开并显示。 */
async function createTerm(
  values: VocabularyDialogValues,
  teamId: string | null,
  errorMessage: (code: string | undefined, serverMessage: string | undefined) => string,
): Promise<void> {
  const url = '/api/v1/domain-vocabularies/terms';
  const res = await fetch(teamId ? `${url}?teamId=${encodeURIComponent(teamId)}` : url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
    credentials: 'same-origin',
    body: JSON.stringify(values),
  });
  if (res.ok) return;
  const env = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
  throw new Error(errorMessage(env.error?.code ?? 'internal_error', env.error?.message));
}

/** 词条全部属于同一领域时返回该领域，否则（无词条或多领域）返回空串，由用户填写。 */
function singleDomain(terms: ReadonlyArray<VocabularyTabTerm>): string {
  const domains = new Set(terms.map((term) => term.domain));
  return domains.size === 1 ? [...domains][0] : '';
}

export function VocabularyTab({ editor, terms, teamId = null, policyLocale = '' }: VocabularyTabProps) {
  const t = useTranslations('policyEditor.vocabularyTab');
  const tVocab = useTranslations('domainVocabularies');
  const vocabularyErrors = useVocabularyErrors();
  const uiLocale = useLocale();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(() => readSelection(editor));
  const [dialogOpen, setDialogOpen] = useState(false);
  // 对话框按 initialValues 引用变化重播表单，故种子必须是稳定引用：只在 openDialog 时生成一次
  const [dialogSeed, setDialogSeed] = useState<{ localized: string; locale: string; domain: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!editor) return;
    const refresh = () => setSelected(readSelection(editor));
    // 订阅回调在事件时触发；挂载时的初值已由 useState 读取，此处补一次以覆盖 editor 后到的情况
    refresh();
    const disposable = editor.onDidChangeCursorSelection(refresh);
    return () => disposable.dispose();
  }, [editor]);

  const needle = query.trim().toLowerCase();
  const visible = useMemo(() => (needle ? terms.filter((term) => matches(term, needle)) : terms), [terms, needle]);

  const openDialog = () => {
    setDialogSeed({ localized: selected, locale: policyLocale, domain: singleDomain(terms) });
    setDialogOpen(true);
  };

  const handleSave = useCallback(async (values: VocabularyDialogValues) => {
    setBusy(true);
    try {
      await createTerm(values, teamId, (code, serverMessage) =>
        vocabularyErrors.envelope(code, serverMessage, tVocab('dialog.errorGeneric')),
      );
      setDialogOpen(false);
      toast.success(tVocab('actions.termAdded'));
      // 立即补一次版本轮询，新术语无需等下一个轮询周期即出现在列表里
      pollDomainVocabularyNow(teamId);
    } finally {
      setBusy(false);
    }
  }, [teamId, vocabularyErrors, tVocab]);

  const manageLink = (
    <a
      href={`/${uiLocale}/domain-vocabularies`}
      // 新标签页打开，避免离开编辑器丢失未保存的编辑
      target="_blank"
      rel="noopener noreferrer"
      className="rounded text-xs text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:shadow-ring"
    >
      {t('manage')}
    </a>
  );

  return (
    <div className="space-y-4 text-sm">
      <p className="text-xs text-fg-muted">{t('hint')}</p>
      {terms.length === 0 ? (
        <div className="space-y-2">
          <p className="text-xs text-fg-muted">{t('empty')}</p>
        </div>
      ) : (
        <>
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('searchPlaceholder')}
            aria-label={t('searchPlaceholder')}
          />
          {visible.length === 0 && <p className="text-xs text-fg-muted">{t('noMatch')}</p>}
          {GROUPS.map(({ kind, key }) => {
            const items = visible.filter((term) => term.kind === kind);
            if (items.length === 0) return null;
            return (
              <TermGroup
                key={kind}
                title={t(key)}
                testId={`vocab-group-${key}`}
                items={items}
                byParent={kind === 'field' || kind === 'enum_value'}
                onInsert={(term) => editor && insertLocalized(editor, term.localized)}
              />
            );
          })}
        </>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button type="button" variant="secondary" size="sm" disabled={selected.length === 0} onClick={openDialog}>
          {t('addSelection')}
        </Button>
        {manageLink}
      </div>
      <VocabularyDialog
        isOpen={dialogOpen}
        mode="create"
        initialValues={dialogSeed ?? undefined}
        isSaving={busy}
        onClose={() => {
          if (!busy) setDialogOpen(false);
        }}
        onSave={handleSave}
      />
    </div>
  );
}

interface TermGroupProps {
  title: string;
  testId: string;
  items: ReadonlyArray<VocabularyTabTerm>;
  /** 字段与枚举成员再按 parent 分小组。 */
  byParent: boolean;
  onInsert: (term: VocabularyTabTerm) => void;
}

function TermGroup({ title, testId, items, byParent, onInsert }: TermGroupProps) {
  const sections = byParent ? groupByParent(items) : [{ parent: null, items }];
  return (
    <section data-testid={testId} className="space-y-1">
      <h3 className="flex items-center justify-between text-xs font-semibold uppercase text-fg-muted">
        <span>{title}</span>
        <span>{items.length}</span>
      </h3>
      {sections.map((section) => (
        <div key={section.parent ?? ''} className="space-y-0.5">
          {section.parent && <p className="text-xs font-medium text-fg-muted">{section.parent}</p>}
          <ul className="space-y-0.5">
            {section.items.map((term) => (
              <li key={`${term.domain}/${term.locale}/${term.parent ?? ''}/${term.canonical}/${term.localized}`}>
                <button
                  type="button"
                  className="flex w-full items-baseline justify-between gap-2 rounded px-2 py-1 text-left hover:bg-bg-muted focus-visible:outline-none focus-visible:shadow-ring"
                  onClick={() => onInsert(term)}
                >
                  <span>{term.localized}</span>
                  <span className="text-xs text-fg-muted">{term.canonical}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

/** 按 parent 分组，保持首次出现顺序；缺 parent 的并入空名组。 */
function groupByParent(items: ReadonlyArray<VocabularyTabTerm>): Array<{ parent: string | null; items: VocabularyTabTerm[] }> {
  const map = new Map<string | null, VocabularyTabTerm[]>();
  for (const term of items) {
    const key = term.parent ?? null;
    map.set(key, [...(map.get(key) ?? []), term]);
  }
  return [...map].map(([parent, grouped]) => ({ parent, items: grouped }));
}
