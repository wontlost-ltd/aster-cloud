/**
 * 执行日志行的输入打码（cloud#754，ADR 0042 §12 F9）：读路径唯一出口。
 *
 * 日志页与日志 API 只拿到这里产出的打码视图，**任何人**（执行人本人、策略 owner / admin、团队成员）都
 * 看不到 `@pii` 字段与未声明键的原值，日志面也不提供解除——原值只经审批面的解除端点返回，且要求审批
 * PENDING、已验证业务角色并按人入链（§12 D5）。执行人提交时在执行页看到的是自己这一次请求的响应，
 * 不经这里。
 *
 * 分类按执行行记录的冻结版本（`policyVersionRowId`）、入口 Rule、语言与关键词别名推导，与执行同一份
 * 词汇（见 loadVersionExecutionVocabulary）；任一环节取不到 → `none`，值全部 unknown（fail-closed）。
 * 只改展示投影：执行行本身、`canonicalInputHash` 等回放 / 证据列、What-If 与 guard 登记读取的原始输入不受影响。
 */

import { inArray } from 'drizzle-orm';
import { db, policyVersions } from '@/lib/prisma';
import { loadVersionExecutionVocabulary } from './index';
import {
  INPUT_MASK_RULES,
  renderMaskedExecutionInput,
  resolveExecutionInputClassification,
  type ExecutionInputMask,
  type InputClassification,
} from './input-view';

/** 打码所需的执行行字段（Execution 表的子集）。 */
export interface MaskableExecutionRow {
  readonly policyId: string;
  readonly input: unknown;
  readonly policyVersionRowId?: string | null;
  readonly functionName?: string | null;
  readonly locale?: string | null;
  readonly aliasSetJson?: unknown;
}

export interface MaskedExecutionInput {
  readonly input: unknown;
  readonly inputMask: ExecutionInputMask;
}

type VersionRow = {
  id: string;
  policyId: string;
  content: string;
  aliasSet: string | null;
  status: string | null;
  createdBy: string | null;
  vocabularySnapshotIds: unknown;
  sourceScopesJson: string | null;
  embeddedVocabulary: string | null;
};

type AliasSet = Record<string, readonly string[]> | null;

/** 执行行捕获的别名优先（当次实际用的），缺省回退版本记录的别名（与 verify-parity 同口径）。 */
function aliasSetOf(row: MaskableExecutionRow, version: VersionRow): AliasSet {
  const captured = row.aliasSetJson;
  if (captured && typeof captured === 'object' && !Array.isArray(captured)) return captured as AliasSet;
  if (!version.aliasSet) return null;
  try {
    const parsed = JSON.parse(version.aliasSet) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as AliasSet) : null;
  } catch {
    return null;
  }
}

async function loadVersions(rows: readonly MaskableExecutionRow[]): Promise<Map<string, VersionRow>> {
  const ids = [...new Set(rows.map((r) => r.policyVersionRowId).filter((id): id is string => !!id))];
  if (ids.length === 0) return new Map();
  const found = (await db.query.policyVersions.findMany({
    where: inArray(policyVersions.id, ids),
    columns: {
      id: true, policyId: true, content: true, aliasSet: true, status: true, createdBy: true, vocabularySnapshotIds: true,
      sourceScopesJson: true, embeddedVocabulary: true,
    },
  })) as VersionRow[];
  return new Map(found.map((v) => [v.id, v]));
}

/** 一行的分类；版本缺失、版本不属于该策略、词汇加载失败或推导失败均为 null。 */
async function classificationOf(
  row: MaskableExecutionRow,
  versions: Map<string, VersionRow>,
  vocabularies: Map<string, Promise<Record<string, unknown> | undefined>>,
): Promise<InputClassification | null> {
  const version = row.policyVersionRowId ? versions.get(row.policyVersionRowId) : undefined;
  if (!version || version.policyId !== row.policyId || !row.functionName) return null;
  const locale = row.locale ?? '';
  const vocabularyKey = `${version.id}\0${locale}`;
  if (!vocabularies.has(vocabularyKey)) {
    vocabularies.set(vocabularyKey, loadVersionExecutionVocabulary({
      status: version.status,
      vocabularySnapshotIds: version.vocabularySnapshotIds,
      authorId: version.createdBy,
      policyId: version.policyId,
      source: version.content,
      locale,
      embeddedVocabulary: version.embeddedVocabulary,
      sourceScopesJson: version.sourceScopesJson,
    }));
  }
  const vocabulary = await vocabularies.get(vocabularyKey)!;
  return resolveExecutionInputClassification(
    { source: version.content, locale, aliasSet: aliasSetOf(row, version), vocabulary },
    row.functionName,
  );
}

/**
 * 批量打码：同一版本只查一次版本表、只加载一次词汇，分类按（源码, 语言, 别名, 词汇, 入口）缓存。
 * 版本表查询失败时整批按 `none` 打码，不把原值回落给调用方。
 */
export async function maskExecutionInputs(rows: readonly MaskableExecutionRow[]): Promise<MaskedExecutionInput[]> {
  let versions: Map<string, VersionRow>;
  try {
    versions = await loadVersions(rows);
  } catch (err) {
    console.warn('[execution-input] failed to load versions for input masking; masking everything', err);
    versions = new Map();
  }
  const vocabularies = new Map<string, Promise<Record<string, unknown> | undefined>>();
  return Promise.all(rows.map(async (row) => {
    const classification = await classificationOf(row, versions, vocabularies).catch(() => null);
    return {
      input: renderMaskedExecutionInput(row.input, classification),
      inputMask: { maskRules: INPUT_MASK_RULES, marksSource: classification ? 'version' : 'none' },
    };
  }));
}
