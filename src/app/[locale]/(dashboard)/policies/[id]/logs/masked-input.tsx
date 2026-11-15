import { piiOf, UNDECLARED_KEY, type PiiPlaceholder } from '@/lib/execution-input/pii-placeholder';

/**
 * 执行日志的输入面板（cloud#754，ADR 0042 §12 F9）。
 *
 * 服务端只下发打码视图，这里按审批输入面板同一口径树形展示：结构保留（对象键、数组长度可见），
 * `$pii` 显示为「级别 · 类别」徽标，未声明类型显示「不可见」徽标；服务端把未声明的键合并为 `$undeclared`
 * 一项（键名不下发），这里显示为「未声明字段」。日志面不提供解除：原值只经审批面的解除端点返回。
 */

export interface InputMaskTranslations {
  /** 面板说明：哪些字段被隐藏、日志面不显示原值。 */
  note: string;
  /** `@pii` 徽标模板，含 `{level}` / `{category}`。 */
  piiBadge: string;
  /** 未声明类型徽标。 */
  unknown: string;
  /** 取不到该次执行版本的输入类型（marksSource = none）时的说明。 */
  marksNone: string;
  /** 合并后的未声明键（键名不展示）的标签。 */
  undeclared: string;
}

export const DEFAULT_INPUT_MASK_TRANSLATIONS: InputMaskTranslations = {
  note: 'Fields declared @pii and undeclared fields are hidden. Execution logs never show their raw values.',
  piiBadge: '{level} · {category}',
  unknown: 'Undeclared type, not visible',
  marksNone: 'The input types of this run\'s policy version are unavailable, so all values are hidden.',
  undeclared: 'Undeclared fields',
};

const labelOf = (name: string, t: InputMaskTranslations) => (name === UNDECLARED_KEY ? t.undeclared : name);

function PiiBadge({ pii, t }: { pii: PiiPlaceholder; t: InputMaskTranslations }) {
  if (pii.level === 'unknown') {
    return <span data-testid="pii-unknown" className="rounded bg-bg-muted px-1.5 py-0.5 text-fg-muted">{t.unknown}</span>;
  }
  const label = pii.category ? t.piiBadge.replace('{level}', pii.level).replace('{category}', pii.category) : pii.level;
  return <span data-testid="pii-masked" className="rounded bg-amber-50 px-1.5 py-0.5 text-amber-800">{label}</span>;
}

function Leaf({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="text-fg-muted">null</span>;
  if (Array.isArray(value)) return <span>{JSON.stringify(value)}</span>;
  return <span>{String(value)}</span>;
}

function Node({ name, value, t }: { name: string; value: unknown; t: InputMaskTranslations }) {
  const pii = piiOf(value);
  const isObject = typeof value === 'object' && value !== null && !Array.isArray(value) && !pii;
  const isRecordList = Array.isArray(value) && value.some((v) => typeof v === 'object' && v !== null);
  if (isObject || isRecordList) {
    const entries: Array<[string, unknown]> = isObject
      ? Object.entries(value as Record<string, unknown>)
      : (value as unknown[]).map((v, i) => [`[${i}]`, v]);
    return (
      <li>
        <span className="font-medium text-fg">{labelOf(name, t)}</span>
        <ul className="ml-4 border-l border-border pl-3">
          {entries.map(([k, v]) => <Node key={k} name={k} value={v} t={t} />)}
        </ul>
      </li>
    );
  }
  return (
    <li className="flex flex-wrap items-center gap-2">
      <span className="text-fg-muted">{labelOf(name, t)}:</span>
      {pii ? <PiiBadge pii={pii} t={t} /> : <Leaf value={value} />}
    </li>
  );
}

export function MaskedInput({ input, marksSource, t }: {
  input: unknown;
  marksSource: 'version' | 'none' | undefined;
  t: InputMaskTranslations;
}) {
  const rootPii = piiOf(input);
  const entries = !rootPii && typeof input === 'object' && input !== null && !Array.isArray(input)
    ? Object.entries(input as Record<string, unknown>)
    : null;
  return (
    <div className="space-y-2 bg-bg p-4 text-xs font-mono text-fg max-h-48 overflow-auto">
      <p className="font-sans text-fg-muted">{marksSource === 'none' ? t.marksNone : t.note}</p>
      {rootPii ? <PiiBadge pii={rootPii} t={t} /> : null}
      {entries ? (
        <ul className="space-y-1">
          {entries.map(([k, v]) => <Node key={k} name={k} value={v} t={t} />)}
        </ul>
      ) : null}
    </div>
  );
}
