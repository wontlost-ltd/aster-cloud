/**
 * 版本 LayoutMap 的服务端存储（ADR 0058 §7.2、§7.5）。只在服务端使用。
 *
 * - 写：`prepareLayout` 做全量校验并产出确定性序列化与两个哈希；`insertVersionLayout` 在建版本的
 *   同一事务里插入（表只插入，trigger 拒绝 UPDATE 与直接 DELETE）。
 * - 读：`loadVersionLayout` / `loadCarryCandidate` 是读取 layout 内容的唯一入口，每次都复验
 *   layout 哈希、源码哈希与往返（toCanonical === 版本源码），任何一项不过即 `inconsistent`。
 *
 * 执行、导出、评估、回放等路径不得导入本模块（见 policy-layout-isolation.test.ts）：
 * layout 只给人看，不进 envelope、不进哈希链、不影响编译。
 */
import { and, eq } from 'drizzle-orm';
import {
  LayoutError,
  parseLayout,
  serializeLayout,
  toCanonical,
  validatePolicyLayout,
  type LayoutCompileContext,
  type PolicyLayout,
} from '@aster-cloud/aster-lang-ts/layout';
import type { DomainVocabulary } from '@aster-cloud/aster-lang-ts/lexicons/identifiers/types';
import { db, policies, policyVersionLayouts, policyVersions } from '@/lib/prisma';
import { getLexicon } from '@/lib/aster-lexicon';
import type { SnapshotTx } from '@/lib/domain-vocabulary-snapshot';
import { LayoutSaveError } from './errors';
import { sha256Utf8Hex } from './hash';
import type { StoredLayout } from './types';

export interface PreparedLayout {
  layout: PolicyLayout;
  serialized: string;
  layoutSha256: string;
  sourceSha256: string;
}

export interface LayoutContext {
  source: string;
  locale: string;
  aliasSet: Readonly<Record<string, readonly string[]>> | null;
  /**
   * L10b（ADR 0059 修订 5 §2.3，ADR 0058 修订 3 E8）其余的编译输入：与版本源码实际编译相同的结构词授权与有效词汇。
   * 缺省表示调用方给不出完整编译输入——含隐藏转义三元组的排版一律以 `layout_hidden_escape_changes_program` 拒绝（失败封闭），
   * 不含三元组的排版不受影响。
   */
  compile?: { allowStructural: boolean; vocabulary: DomainVocabulary | null };
}

/** 版本的 L10b 编译上下文；`ctx.compile` 缺省时为 undefined（失败封闭）。aliasSet 与词法表叠加口径相同。 */
function compileContextOf(
  ctx: LayoutContext,
  aliasSet: Record<string, string[]> | undefined,
): LayoutCompileContext | undefined {
  if (!ctx.compile) return undefined;
  return {
    locale: ctx.locale,
    aliasSet: aliasSet ?? null,
    allowStructural: ctx.compile.allowStructural,
    vocabulary: ctx.compile.vocabulary,
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function fromLayoutError(e: LayoutError): LayoutSaveError {
  return new LayoutSaveError(e.code, 400, e.message, {
    ...(e.offset !== undefined ? { offset: e.offset } : {}),
    ...(e.limit !== undefined ? { limit: e.limit } : {}),
  });
}

/** 把请求体里的 layout 读成包的形态；借 parseLayout 做未知键与序列化体积上限检查。 */
function readSubmitted(input: unknown): PolicyLayout {
  if (!isPlainObject(input)) {
    throw new LayoutSaveError('layout_invalid_format', 400, 'layout must be a JSON object');
  }
  let text: string;
  try {
    text = JSON.stringify(input);
  } catch {
    throw new LayoutSaveError('layout_invalid_format', 400, 'layout is not serializable JSON');
  }
  try {
    return parseLayout(text);
  } catch (e) {
    if (e instanceof LayoutError) throw fromLayoutError(e);
    throw e;
  }
}

/**
 * 校验一个 layout 能否随版本源码保存，返回存储形态。校验与编辑器共用包的 `validatePolicyLayout`，
 * 词法表为版本 locale 的词法表并入版本冻结的 aliasSet（裁决 R7），隐藏转义的 L10b 用版本的编译上下文（E8）。
 * 失败抛 400 `LayoutSaveError`。
 */
export function prepareLayout(input: unknown, ctx: LayoutContext): PreparedLayout {
  const parsed = readSubmitted(input);
  const aliasSet = ctx.aliasSet && Object.keys(ctx.aliasSet).length > 0
    ? (ctx.aliasSet as Record<string, string[]>)
    : undefined;
  const result = validatePolicyLayout(parsed, ctx.source, getLexicon(ctx.locale), aliasSet, compileContextOf(ctx, aliasSet));
  if (!result.ok) {
    throw new LayoutSaveError(result.code, 400, result.message, {
      ...(result.offset !== undefined ? { offset: result.offset } : {}),
      ...(result.limit !== undefined ? { limit: result.limit } : {}),
    });
  }
  // 序列化会合并相邻内容 span；返回的 layout 取序列化后的形态，与库里存的逐字一致。
  const serialized = serializeLayout(parsed);
  return {
    layout: parseLayout(serialized),
    serialized,
    layoutSha256: sha256Utf8Hex(serialized),
    sourceSha256: sha256Utf8Hex(ctx.source),
  };
}

export async function insertVersionLayout(
  tx: SnapshotTx,
  input: { policyVersionId: string; prepared: PreparedLayout; createdBy: string },
): Promise<void> {
  await tx.insert(policyVersionLayouts).values({
    policyVersionId: input.policyVersionId,
    formatVersion: 1,
    layout: input.prepared.serialized,
    layoutSha256: input.prepared.layoutSha256,
    sourceSha256: input.prepared.sourceSha256,
    createdBy: input.createdBy,
  });
}

interface LayoutRow {
  versionId: string;
  layout: string;
  layoutSha256: string;
  sourceSha256: string;
  source: string | null;
  content: string;
}

// 函数而非模块级常量：导入本模块（经 version-manager）时不触碰表对象。
const layoutRowColumns = () => ({
  versionId: policyVersionLayouts.policyVersionId,
  layout: policyVersionLayouts.layout,
  layoutSha256: policyVersionLayouts.layoutSha256,
  sourceSha256: policyVersionLayouts.sourceSha256,
  source: policyVersions.source,
  content: policyVersions.content,
});

function inconsistent(row: LayoutRow, check: string): StoredLayout {
  console.error('[policy-layout] inconsistent', { versionId: row.versionId, check });
  return { status: 'inconsistent', layoutSha256: row.layoutSha256 };
}

/** 读取复验：layout 哈希、源码哈希、可解析、往返相等，依次检查。往返独立于哈希（两列可被一并改写）。 */
function verifyRow(row: LayoutRow | undefined): StoredLayout {
  if (!row) return { status: 'none' };
  const source = row.source ?? row.content;
  if (sha256Utf8Hex(row.layout) !== row.layoutSha256) return inconsistent(row, 'layout_sha256');
  if (sha256Utf8Hex(source) !== row.sourceSha256) return inconsistent(row, 'source_sha256');
  let layout: PolicyLayout;
  try {
    layout = parseLayout(row.layout);
  } catch {
    return inconsistent(row, 'parse');
  }
  if (toCanonical(layout) !== source) return inconsistent(row, 'roundtrip');
  return { status: 'ok', layout, layoutSha256: row.layoutSha256 };
}

/** 版本的 layout（读接口用）。不做权限检查：调用方必须先完成既有的读权限检查。 */
export async function loadVersionLayout(versionId: string): Promise<StoredLayout> {
  const [row] = await db
    .select(layoutRowColumns())
    .from(policyVersionLayouts)
    .innerJoin(policyVersions, eq(policyVersions.id, policyVersionLayouts.policyVersionId))
    .where(eq(policyVersionLayouts.policyVersionId, versionId))
    .limit(1);
  return verifyRow(row);
}

/** 只取哈希列：保存路由据此判断 layout 是否变化、是否需要解析能力。不复验。 */
export async function activeLayoutSha256(versionId: string): Promise<string | null> {
  const [row] = await db
    .select({ layoutSha256: policyVersionLayouts.layoutSha256 })
    .from(policyVersionLayouts)
    .where(eq(policyVersionLayouts.policyVersionId, versionId))
    .limit(1);
  return row?.layoutSha256 ?? null;
}

/** 策略活跃版本（`PolicyVersion.version = Policy.version`）的 layout 哈希；供不预先取活跃版本的保存路由。 */
export async function activeLayoutSha256ForPolicy(policyId: string): Promise<string | null> {
  const [row] = await db
    .select({ layoutSha256: policyVersionLayouts.layoutSha256 })
    .from(policies)
    .innerJoin(policyVersions, and(eq(policyVersions.policyId, policies.id), eq(policyVersions.version, policies.version)))
    .innerJoin(policyVersionLayouts, eq(policyVersionLayouts.policyVersionId, policyVersions.id))
    .where(eq(policies.id, policyId))
    .limit(1);
  return row?.layoutSha256 ?? null;
}

/**
 * 沿用候选（裁决 R5）：在建版本事务内、链尾锁之后，按 `Policy.version` 取活跃版本的 layout 并复验。
 * 调用时 `Policy.version` 尚未回填为新版本号，读到的是上一活跃版本。
 */
export async function loadCarryCandidate(tx: SnapshotTx, policyId: string): Promise<StoredLayout> {
  const [row] = await tx
    .select(layoutRowColumns())
    .from(policies)
    .innerJoin(policyVersions, and(eq(policyVersions.policyId, policies.id), eq(policyVersions.version, policies.version)))
    .innerJoin(policyVersionLayouts, eq(policyVersionLayouts.policyVersionId, policyVersions.id))
    .where(eq(policies.id, policyId))
    .limit(1);
  return verifyRow(row);
}
