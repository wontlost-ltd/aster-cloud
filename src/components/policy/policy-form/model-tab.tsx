'use client';

/**
 * 编辑器侧栏「模型」标签（ADR 0058 §8.3，仅在 structured_authoring 为真时挂载）。
 *
 * 上半部是大纲：结构体（含字段）、类型别名、导入别名，点击跳到定义。下半部是三个表单：
 * 新建结构体、为结构体添加字段、新建类型别名——经 lexicon 生成本地化源码后用 executeEdits
 * 插入 Monaco（进入撤销栈），作者不手写关键词。
 *
 * 大纲来源 `source` 是编辑器 300 ms 防抖编译所用的那份源码（见 use-compile.ts 的 source），
 * 此处不再另设防抖；同一 source 只解析一次（useMemo）。
 */
import { useId, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import type { editor as MonacoEditor } from 'monaco-editor';
import { useTranslations } from 'next-intl';
import { Plus, X } from 'lucide-react';
import type { Lexicon } from '@aster-cloud/aster-lang-ts/browser';
import { Button, Input, Label, Select } from '@/components/ui';
import { isValidFieldName, isValidTypeName } from '@/lib/structured-authoring/name-validation';
import { buildModelOutline, type ModelOutline, type Span } from '@/lib/structured-authoring/outline';
import {
  buildFieldClause,
  buildStructSource,
  buildTypeAliasSource,
  builtinTypeNames,
  type FieldInput,
} from '@/lib/structured-authoring/source-builders';
import { SemanticTokenKind } from '@/lib/aster-lexicon';

export interface ModelTabProps {
  editor: MonacoEditor.IStandaloneCodeEditor | null;
  /** 最近一次防抖编译所用的源码。 */
  source: string;
  /** 与编辑器编译一致的 lexicon（含策略关键词别名）。 */
  lexicon: Lexicon;
}

type OpenForm = { kind: 'struct' } | { kind: 'alias' } | { kind: 'field'; struct: string } | null;

/** executeEdits 的来源标识（撤销栈与扩展据此区分编辑来源）。 */
const EDIT_SOURCE = 'structured-authoring.model';

export function ModelTab({ editor, source, lexicon }: ModelTabProps) {
  const t = useTranslations('policyEditor.modelTab');
  const outline = useMemo(() => buildModelOutline(source, lexicon), [source, lexicon]);
  const typeOptions = useMemo(() => collectTypeOptions(lexicon, outline), [lexicon, outline]);
  const [openForm, setOpenForm] = useState<OpenForm>(null);
  // 记录触发过期提示时的大纲源码：源码变化（大纲已刷新）后提示自动失效
  const [staleSource, setStaleSource] = useState<string | null>(null);
  const stale = staleSource === source;
  // 空结构体无法追加字段时的说明（文法不允许零字段结构体，保持表单打开并明示）
  const [emptyStruct, setEmptyStruct] = useState(false);
  const takenTypeNames = useMemo(() => collectTakenTypeNames(outline), [outline]);

  const close = () => {
    setOpenForm(null);
    setStaleSource(null);
    setEmptyStruct(false);
  };

  const jump = (span: Span) => {
    if (!editor) return;
    editor.revealLineInCenter(span.start.line);
    editor.setPosition({ lineNumber: span.start.line, column: span.start.col });
    editor.focus();
  };

  const insertAtEnd = (declaration: string) => {
    if (editor && appendDeclaration(editor, declaration)) close();
  };

  const insertField = (structName: string, field: FieldInput) => {
    if (!editor || !outline) return;
    // 插入位置来自上一次防抖编译的大纲；编辑器内容已变时位置可能失效，等大纲刷新
    if (editor.getModel()?.getValue() !== source) {
      setStaleSource(source);
      return;
    }
    const struct = outline.structs.find((s) => s.name === structName);
    const last = struct?.fields[struct.fields.length - 1];
    if (!last) {
      setEmptyStruct(true);
      return;
    }
    const text = ` ${lexicon.keywords[SemanticTokenKind.AND]} ${buildFieldClause(lexicon, field)}`;
    insertAt(editor, last.span.end, text);
    close();
  };

  return (
    <div className="space-y-4 text-sm">
      <p className="text-xs text-fg-muted">{t('hint')}</p>
      <OutlineView outline={outline} onJump={jump} onAddField={(struct) => {
          setEmptyStruct(false);
          setOpenForm({ kind: 'field', struct });
        }} />
      {stale && (
        <p role="status" className="text-xs text-warning">
          {t('outlineStale')}
        </p>
      )}
      {emptyStruct && (
        <p role="status" className="text-xs text-warning">
          {t('emptyStruct')}
        </p>
      )}
      {openForm?.kind === 'field' && (
        <FieldForm
          key={openForm.struct}
          structName={openForm.struct}
          lexicon={lexicon}
          existingFields={outline?.structs.find((x) => x.name === openForm.struct)?.fields.map((f) => f.name) ?? []}
          typeOptions={typeOptions}
          onCancel={close}
          onSubmit={(field) => insertField(openForm.struct, field)}
        />
      )}
      {openForm?.kind === 'struct' && (
        <StructForm
          lexicon={lexicon}
          takenNames={takenTypeNames}
          typeOptions={typeOptions}
          onCancel={close}
          onSubmit={(input) => insertAtEnd(buildStructSource(lexicon, input))}
        />
      )}
      {openForm?.kind === 'alias' && (
        <AliasForm
          lexicon={lexicon}
          takenNames={takenTypeNames}
          typeOptions={typeOptions}
          onCancel={close}
          onSubmit={(input) => insertAtEnd(buildTypeAliasSource(lexicon, input))}
        />
      )}
      {openForm === null && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={() => setOpenForm({ kind: 'struct' })}>
            {t('newStruct')}
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={() => setOpenForm({ kind: 'alias' })}>
            {t('newTypeAlias')}
          </Button>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 编辑器写入                                                          */
/* ------------------------------------------------------------------ */

function insertAt(editor: MonacoEditor.IStandaloneCodeEditor, at: Span['end'], text: string): void {
  const range = { startLineNumber: at.line, startColumn: at.col, endLineNumber: at.line, endColumn: at.col };
  editor.executeEdits(EDIT_SOURCE, [{ range, text, forceMoveMarkers: true }]);
  editor.pushUndoStop();
}

/** 在文档末尾追加一条声明，与上文之间隔一个空行。 */
function appendDeclaration(editor: MonacoEditor.IStandaloneCodeEditor, declaration: string): boolean {
  const model = editor.getModel();
  if (!model) return false;
  const lastLine = model.getLineCount();
  const value = model.getValue();
  const separator = value.length === 0 || value.endsWith('\n\n') ? '' : value.endsWith('\n') ? '\n' : '\n\n';
  insertAt(editor, { line: lastLine, col: model.getLineMaxColumn(lastLine) }, `${separator}${declaration}\n`);
  return true;
}

/** 类型下拉：本地化内置类型 + 大纲里声明的结构体、枚举与类型别名（去重、保持顺序）。 */
function collectTypeOptions(lexicon: Lexicon, outline: ModelOutline | null): string[] {
  const names = [
    ...builtinTypeNames(lexicon),
    ...(outline?.structs.map((s) => s.name) ?? []),
    ...(outline?.enums.map((e) => e.name) ?? []),
    ...(outline?.typeAliases.map((a) => a.name) ?? []),
  ];
  return [...new Set(names)];
}

/** 已被占用的类型名（结构体、枚举、类型别名），折叠大小写后比较。 */
function collectTakenTypeNames(outline: ModelOutline | null): ReadonlySet<string> {
  const names = [
    ...(outline?.structs.map((s) => s.name) ?? []),
    ...(outline?.enums.map((e) => e.name) ?? []),
    ...(outline?.typeAliases.map((a) => a.name) ?? []),
  ];
  return new Set(names.map(foldName));
}

const foldName = (name: string) => name.trim().toLocaleLowerCase();

/* ------------------------------------------------------------------ */
/* 大纲                                                                */
/* ------------------------------------------------------------------ */

function OutlineView({
  outline,
  onJump,
  onAddField,
}: {
  outline: ModelOutline | null;
  onJump: (span: Span) => void;
  onAddField: (struct: string) => void;
}) {
  const t = useTranslations('policyEditor.modelTab');
  if (!outline) return <p className="text-fg-muted">{t('outlineUnavailable')}</p>;
  const { structs, typeAliases, imports } = outline;
  if (structs.length + typeAliases.length + imports.length === 0) {
    return <p className="text-fg-muted">{t('empty')}</p>;
  }
  return (
    <div className="space-y-3">
      {structs.length > 0 && (
        <OutlineSection title={t('structs')}>
          {structs.map((s) => (
            <li key={`${s.name}-${s.span.start.line}`} className="space-y-0.5">
              <div className="flex items-center gap-1">
                <OutlineItem label={s.name} onClick={() => onJump(s.span)} strong />
                <button
                  type="button"
                  aria-label={t('addFieldTo', { name: s.name })}
                  title={t('addFieldTo', { name: s.name })}
                  onClick={() => onAddField(s.name)}
                  className="shrink-0 rounded p-1 text-fg-muted hover:bg-bg-subtle hover:text-fg focus-visible:outline-none focus-visible:shadow-ring"
                >
                  <Plus aria-hidden className="size-3.5" />
                </button>
              </div>
              <ul className="ml-3 border-l border-border pl-2">
                {s.fields.map((f) => (
                  <li key={`${f.name}-${f.span.start.line}-${f.span.start.col}`}>
                    <OutlineItem label={f.name} detail={f.type} onClick={() => onJump(f.span)} />
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </OutlineSection>
      )}
      {typeAliases.length > 0 && (
        <OutlineSection title={t('typeAliases')}>
          {typeAliases.map((a) => (
            <li key={`${a.name}-${a.span.start.line}`}>
              <OutlineItem label={a.name} detail={a.target} onClick={() => onJump(a.span)} />
            </li>
          ))}
        </OutlineSection>
      )}
      {imports.length > 0 && (
        <OutlineSection title={t('imports')}>
          {imports.map((i) => (
            <li key={`${i.alias}-${i.span.start.line}`}>
              <OutlineItem label={i.alias} detail={i.module} onClick={() => onJump(i.span)} />
            </li>
          ))}
        </OutlineSection>
      )}
    </div>
  );
}

function OutlineSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-1">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">{title}</h3>
      <ul className="space-y-0.5">{children}</ul>
    </section>
  );
}

function OutlineItem({
  label,
  detail,
  strong = false,
  onClick,
}: {
  label: string;
  detail?: string;
  strong?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-w-0 flex-1 items-baseline gap-2 rounded px-1.5 py-0.5 text-left hover:bg-bg-subtle focus-visible:outline-none focus-visible:shadow-ring"
    >
      <span className={strong ? 'truncate font-mono font-medium text-fg' : 'truncate font-mono text-fg'}>{label}</span>
      {detail && <span className="truncate font-mono text-xs text-fg-muted">{detail}</span>}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* 表单                                                                */
/* ------------------------------------------------------------------ */

const isFilled = (value: string) => value.trim().length > 0;

type NameProblem = 'invalid' | 'duplicate' | null;

/** 类型名（结构体 / 类型别名）：须是单个标识符且不与已有类型名冲突；空串不报错（仅禁用提交）。 */
function typeNameProblem(lexicon: Lexicon, name: string, taken: ReadonlySet<string>): NameProblem {
  if (!isFilled(name)) return null;
  if (!isValidTypeName(lexicon, name)) return 'invalid';
  return taken.has(foldName(name)) ? 'duplicate' : null;
}

/** 字段名：须是单个标识符且不与同结构体已有字段（或本表单其他行）重名。 */
function fieldNameProblem(lexicon: Lexicon, name: string, taken: readonly string[]): NameProblem {
  if (!isFilled(name)) return null;
  if (!isValidFieldName(lexicon, name)) return 'invalid';
  return taken.some((t) => foldName(t) === foldName(name)) ? 'duplicate' : null;
}

function ProblemMessage({ problem }: { problem: NameProblem }) {
  const t = useTranslations('policyEditor.modelTab');
  if (!problem) return null;
  return (
    <p role="alert" className="text-xs text-danger">
      {problem === 'invalid' ? t('invalidName') : t('duplicateName')}
    </p>
  );
}

const firstProblem = (...problems: NameProblem[]): NameProblem => problems.find((p) => p !== null) ?? null;

function FormShell({
  title,
  canSubmit,
  problem,
  onSubmit,
  onCancel,
  children,
}: {
  title: string;
  canSubmit: boolean;
  problem: NameProblem;
  onSubmit: () => void;
  onCancel: () => void;
  children: ReactNode;
}) {
  const t = useTranslations('policyEditor.modelTab');
  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (canSubmit) onSubmit();
  };
  return (
    <form aria-label={title} onSubmit={handleSubmit} className="space-y-3 rounded-lg border border-border p-3">
      <h3 className="text-sm font-semibold text-fg">{title}</h3>
      {children}
      <ProblemMessage problem={problem} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t('cancel')}
        </Button>
        <Button type="submit" size="sm" disabled={!canSubmit}>
          {t('insert')}
        </Button>
      </div>
    </form>
  );
}

function TextField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const id = useId();
  return (
    <div className="min-w-0 flex-1 space-y-1">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} autoComplete="off" />
    </div>
  );
}

function TypeSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  const id = useId();
  return (
    <div className="min-w-0 flex-1 space-y-1">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </Select>
    </div>
  );
}

function FieldRow({
  field,
  typeOptions,
  onChange,
  onRemove,
}: {
  field: FieldInput;
  typeOptions: string[];
  onChange: (field: FieldInput) => void;
  onRemove?: () => void;
}) {
  const t = useTranslations('policyEditor.modelTab');
  return (
    <div className="flex items-end gap-2">
      <TextField label={t('fieldName')} value={field.name} onChange={(name) => onChange({ ...field, name })} />
      <TypeSelect
        label={t('fieldType')}
        value={field.type}
        options={typeOptions}
        onChange={(type) => onChange({ ...field, type })}
      />
      {onRemove && (
        <button
          type="button"
          aria-label={t('removeFieldRow')}
          onClick={onRemove}
          className="mb-2 shrink-0 rounded p-1 text-fg-muted hover:bg-bg-subtle hover:text-fg focus-visible:outline-none focus-visible:shadow-ring"
        >
          <X aria-hidden className="size-3.5" />
        </button>
      )}
    </div>
  );
}

function StructForm({
  lexicon,
  takenNames,
  typeOptions,
  onSubmit,
  onCancel,
}: {
  lexicon: Lexicon;
  takenNames: ReadonlySet<string>;
  typeOptions: string[];
  onSubmit: (input: { name: string; fields: FieldInput[] }) => void;
  onCancel: () => void;
}) {
  const t = useTranslations('policyEditor.modelTab');
  const blankField = (): FieldInput => ({ name: '', type: typeOptions[0] ?? '' });
  const [name, setName] = useState('');
  const [fields, setFields] = useState<FieldInput[]>(() => [blankField()]);
  const problem = firstProblem(
    typeNameProblem(lexicon, name, takenNames),
    ...fields.map((f, i) =>
      fieldNameProblem(
        lexicon,
        f.name,
        fields.slice(0, i).map((prev) => prev.name),
      ),
    ),
  );
  const canSubmit = isFilled(name) && fields.every((f) => isFilled(f.name) && isFilled(f.type)) && problem === null;
  const updateField = (index: number, next: FieldInput) => setFields((all) => all.map((f, i) => (i === index ? next : f)));
  const removeField = (index: number) => setFields((all) => all.filter((_, i) => i !== index));

  return (
    <FormShell
      title={t('newStruct')}
      canSubmit={canSubmit}
      problem={problem}
      onCancel={onCancel}
      onSubmit={() => onSubmit({ name, fields })}
    >
      <TextField label={t('structName')} value={name} onChange={setName} />
      {fields.map((field, index) => (
        <FieldRow
          key={index}
          field={field}
          typeOptions={typeOptions}
          onChange={(next) => updateField(index, next)}
          onRemove={fields.length > 1 ? () => removeField(index) : undefined}
        />
      ))}
      <Button type="button" variant="ghost" size="sm" onClick={() => setFields((all) => [...all, blankField()])}>
        {t('addFieldRow')}
      </Button>
    </FormShell>
  );
}

function FieldForm({
  structName,
  lexicon,
  existingFields,
  typeOptions,
  onSubmit,
  onCancel,
}: {
  structName: string;
  lexicon: Lexicon;
  existingFields: readonly string[];
  typeOptions: string[];
  onSubmit: (field: FieldInput) => void;
  onCancel: () => void;
}) {
  const t = useTranslations('policyEditor.modelTab');
  const [field, setField] = useState<FieldInput>({ name: '', type: typeOptions[0] ?? '' });
  const problem = fieldNameProblem(lexicon, field.name, existingFields);
  return (
    <FormShell
      title={t('addFieldTo', { name: structName })}
      canSubmit={isFilled(field.name) && isFilled(field.type) && problem === null}
      problem={problem}
      onCancel={onCancel}
      onSubmit={() => onSubmit(field)}
    >
      <FieldRow field={field} typeOptions={typeOptions} onChange={setField} />
    </FormShell>
  );
}

function AliasForm({
  lexicon,
  takenNames,
  typeOptions,
  onSubmit,
  onCancel,
}: {
  lexicon: Lexicon;
  takenNames: ReadonlySet<string>;
  typeOptions: string[];
  onSubmit: (input: { name: string; target: string }) => void;
  onCancel: () => void;
}) {
  const t = useTranslations('policyEditor.modelTab');
  const [name, setName] = useState('');
  const [target, setTarget] = useState(typeOptions[0] ?? '');
  const problem = typeNameProblem(lexicon, name, takenNames);
  return (
    <FormShell
      title={t('newTypeAlias')}
      canSubmit={isFilled(name) && isFilled(target) && problem === null}
      problem={problem}
      onCancel={onCancel}
      onSubmit={() => onSubmit({ name, target })}
    >
      <TextField label={t('aliasName')} value={name} onChange={setName} />
      <TypeSelect label={t('aliasTarget')} value={target} options={typeOptions} onChange={setTarget} />
    </FormShell>
  );
}
