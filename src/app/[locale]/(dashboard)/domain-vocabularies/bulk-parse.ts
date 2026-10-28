/**
 * 批量导入弹窗的客户端解析与预校验（纯函数，无 I/O）。
 *
 * CSV（带表头）与 JSON（对象数组或单个对象）解析成同一种 {@link ParsedRow}，与 /bulk{,/jobs}
 * 接口契约一致。每个问题只记**问题码 + 参数**，不带英文原文：界面按码取本地化文案（#634），
 * 列名（domain、kind、parentCanonical 等）是 CSV / JSON 里的字面键，作为参数原样嵌入。
 */

import { checkVocabularyScope } from '@/lib/domain-vocabulary-format';
import { KIND_OPTIONS, type Kind } from './constants';

/** 预校验通过的一行。 */
export interface ParsedRow {
  domain: string;
  locale: string;
  kind: Kind;
  canonical: string;
  localized: string;
  parentCanonical?: string;
  description?: string;
  aliases?: string[];
}

/**
 * 解析 / 预校验问题码：
 * - 整段输入（row=0）：invalid_json、csv_needs_header；
 * - 单行：row_not_object、column_count、field_required、kind_invalid、parent_required、
 *   domain_format / locale_format（#612，与服务端同一校验）。
 */
export type ParseIssue =
  | 'invalid_json'
  | 'csv_needs_header'
  | 'row_not_object'
  | 'column_count'
  | 'field_required'
  | 'kind_invalid'
  | 'parent_required'
  | 'domain_format'
  | 'locale_format';

export interface ParseFinding {
  /** 1 起的行号；0 表示整段输入的问题。 */
  row: number;
  issue: ParseIssue;
  values?: Record<string, string | number>;
}

export interface ParseOutcome {
  rows: ParsedRow[];
  errors: ParseFinding[];
}

/** 必填列（按校验顺序）。 */
const REQUIRED_COLUMNS = ['domain', 'locale', 'canonical', 'localized'] as const;

export function parseBulkInput(raw: string): ParseOutcome {
  const trimmed = raw.trim();
  if (!trimmed) return { rows: [], errors: [] };
  // 以 '[' 或 '{' 开头按 JSON 解析，否则按 CSV。
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) return parseJson(trimmed);
  return parseCsv(trimmed);
}

/** 把一行记录的校验结果归入 rows 或 errors。 */
function collect(outcome: ParseOutcome, row: number, record: Record<string, unknown>): void {
  const coerced = coerceRow(record);
  if ('issue' in coerced) outcome.errors.push({ row, ...coerced });
  else outcome.rows.push(coerced.row);
}

function parseJson(text: string): ParseOutcome {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { rows: [], errors: [{ row: 0, issue: 'invalid_json' }] };
  }
  const outcome: ParseOutcome = { rows: [], errors: [] };
  const entries = Array.isArray(value) ? value : [value];
  entries.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      outcome.errors.push({ row: index + 1, issue: 'row_not_object' });
      return;
    }
    collect(outcome, index + 1, entry as Record<string, unknown>);
  });
  return outcome;
}

/** CSV 一行 → 记录；aliases 列用 | 分隔多个别名，免得转义逗号。 */
function csvRecord(header: readonly string[], cells: readonly string[]): Record<string, unknown> {
  const record: Record<string, unknown> = Object.fromEntries(header.map((key, idx) => [key, cells[idx]]));
  if (typeof record.aliases === 'string' && record.aliases) {
    record.aliases = record.aliases.split('|').map((s) => s.trim()).filter(Boolean);
  }
  return record;
}

function parseCsv(text: string): ParseOutcome {
  // 单遍分词：只在引号外的换行处断行，引号内的多行单元格（"foo\nbar"）完整保留。
  const allRows = tokenizeCsv(text);
  // 去掉末尾的全空行（文件以换行结尾时常见）。
  while (allRows.length > 0 && allRows[allRows.length - 1]!.every((c) => c === '')) allRows.pop();
  if (allRows.length < 2) return { rows: [], errors: [{ row: 0, issue: 'csv_needs_header' }] };
  const header = allRows[0]!.map((h) => h.trim());
  const outcome: ParseOutcome = { rows: [], errors: [] };
  for (let i = 1; i < allRows.length; i++) {
    const cells = allRows[i]!;
    if (cells.length !== header.length) {
      outcome.errors.push({ row: i + 1, issue: 'column_count', values: { expected: header.length, actual: cells.length } });
      continue;
    }
    collect(outcome, i + 1, csvRecord(header, cells));
  }
  return outcome;
}

/**
 * CSV 分词：引号内的单元格可跨行（RFC-4180 风格），引号内 `""` 表示一个字面引号；
 * 回车一律丢弃，CRLF 与 LF 解析结果相同。
 */
function tokenizeCsv(text: string): string[][] {
  const rows: string[][] = [];
  let cells: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') {
        current += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        current += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      cells.push(current);
      current = '';
    } else if (c === '\n') {
      cells.push(current);
      rows.push(cells);
      cells = [];
      current = '';
    } else if (c !== '\r') {
      current += c;
    }
  }
  // 收尾：没有结尾换行时补上最后一格 / 最后一行。
  if (current.length > 0 || cells.length > 0) {
    cells.push(current);
    rows.push(cells);
  }
  return rows;
}

type CoerceResult = { row: ParsedRow } | Omit<ParseFinding, 'row'>;

function text(record: Record<string, unknown>, key: string): string | undefined {
  const v = record[key];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

function coerceRow(record: Record<string, unknown>): CoerceResult {
  const kindRaw = text(record, 'kind');
  if (!kindRaw) return { issue: 'field_required', values: { field: 'kind' } };
  if (!(KIND_OPTIONS as readonly string[]).includes(kindRaw)) {
    return { issue: 'kind_invalid', values: { kinds: KIND_OPTIONS.join(', ') } };
  }
  const missing = REQUIRED_COLUMNS.find((key) => !text(record, key));
  if (missing) return { issue: 'field_required', values: { field: missing } };
  const [domain, locale, canonical, localized] = REQUIRED_COLUMNS.map((key) => text(record, key)!) as [string, string, string, string];
  const [scopeIssue] = checkVocabularyScope({ domain, locale }).issues;
  if (scopeIssue) return { issue: scopeIssue };

  const kind = kindRaw as Kind;
  const parentCanonical = text(record, 'parentCanonical');
  if (kind === 'field' && !parentCanonical) return { issue: 'parent_required' };

  const aliases = Array.isArray(record.aliases)
    ? record.aliases.filter((v): v is string => typeof v === 'string' && v.length > 0)
    : [];
  const description = text(record, 'description');
  return {
    row: {
      domain,
      locale,
      kind,
      canonical,
      localized,
      ...(parentCanonical ? { parentCanonical } : {}),
      ...(description ? { description } : {}),
      ...(aliases.length > 0 ? { aliases } : {}),
    },
  };
}

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** domain / locale 格式问题沿用 #612 已有文案，其余按问题码取 parseIssues.*。 */
const ISSUE_KEYS: Partial<Record<ParseIssue, string>> = {
  domain_format: 'domainInvalid',
  locale_format: 'localeInvalid',
};

/**
 * 一条解析问题的展示文本（t 为 domainVocabularies.bulk 命名空间）：
 * 行级问题带 `#行号: ` 前缀，整段输入的问题（row=0）只显示文案。
 */
export function parseFindingText(finding: ParseFinding, t: Translate): string {
  const message = t(ISSUE_KEYS[finding.issue] ?? `parseIssues.${finding.issue}`, finding.values);
  return finding.row > 0 ? `#${finding.row}: ${message}` : message;
}
