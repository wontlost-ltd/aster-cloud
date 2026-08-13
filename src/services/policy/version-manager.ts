/**
 * 策略版本管理服务
 *
 * 支持多版本共存：
 * - DRAFT: 草稿，编辑中
 * - PENDING_APPROVAL: 待审批
 * - APPROVED: 已批准，可执行
 * - REJECTED: 已拒绝
 * - DEPRECATED: 已废弃，仍可执行但有警告
 * - ARCHIVED: 已归档，不可执行
 */

import { db, policies, policyVersions, policyApprovals } from '@/lib/prisma';
import { eq, and, inArray, isNull, desc, sql } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import { computeChainedHash, computeSourceHash } from '../security/policy-security';
import { logSecurityEvent } from '../security/security-event-service';
import { recordAhaMomentIfFirst } from '@/lib/metrics/aha-detection';
import { invalidatePolicyCache } from '@/lib/cache';
import { snapshotOnPolicyApprove } from '@/lib/domain-vocabulary-snapshot';
import {
  canonicalAliasJson,
  cloudToolchainId,
  computeSourceEnvelope,
  STRUCTURAL_KINDS,
  validateUserAliases,
  type ReservedSets,
} from '@/lib/policy-alias';

type PolicyVersion = InferSelectModel<typeof policyVersions>;
type PolicyVersionStatus = PolicyVersion['status'];
type VersionDbClient = Pick<typeof db, 'query' | 'insert'>;

/**
 * 调用方不是该策略的所有者（或策略不存在/已软删）。路由 catch 后返回 404——
 * 刻意不用 403，避免把「该 policyId 存在」这一事实泄露给非所有者（枚举探测）。
 */
export class PolicyAccessDeniedError extends Error {
  constructor(message = '策略不存在') {
    super(message);
    this.name = 'PolicyAccessDeniedError';
  }
}

/**
 * 版本操作的**归属校验单一入口**。
 *
 * <h3>为什么放在服务层而不是各路由</h3>
 *
 * 此前 8 个版本路由（submit/approve/reject/set-default/archive/deprecate/
 * 版本详情/secure-execute）只校验登录态，`policyId` 从 URL 直接进服务层，
 * 而本文件的查询只按 `policyId + version + status` 过滤——**任何登录用户可操作
 * 任意租户的策略版本**。同目录 `versions/route.ts` 早有正确写法，只是没传播到这 8 处。
 *
 * ★最危险的是审批链：`approveVersion` 的四眼原则判的是
 * `targetVersion.createdBy === approverId`，对**外部攻击者恒为 false**
 * （攻击者本就不是创建者）→ SOX 守护不但拦不住，反而主动放行。
 * 配合 submit 可把他人策略从 DRAFT 一路推到 APPROVED。
 *
 * 收口到服务层而非补 8 处路由：路由是会增加的，服务函数是收敛的；
 * 任何新入口只要走这些函数就自动带上校验。
 */
export async function assertPolicyOwnership(policyId: string, userId: string): Promise<void> {
  const owned = await db.query.policies.findFirst({
    where: and(
      eq(policies.id, policyId),
      eq(policies.userId, userId),
      isNull(policies.deletedAt),
    ),
    columns: { id: true },
  });
  if (!owned) {
    throw new PolicyAccessDeniedError();
  }
}

/**
 * 源码存在解析/编译错误——不允许落库。路由 catch 此异常返回 400。
 * 与「别名校验失败」区分：那是别名输入非法，这是源码本身不可编译。
 */
export class PolicyCompileError extends Error {
  constructor(message = '策略存在解析错误，无法保存，请先修复后再试。') {
    super(message);
    this.name = 'PolicyCompileError';
  }
}

/** 编译诊断（只关心 severity 判「是否有 error」）。 */
export interface CompileDiagnostic {
  severity: 'error' | 'warning' | 'info' | 'hint';
}

/**
 * 源码可编译性校验器：返回诊断列表（severity==='error' 即不可保存）。由调用方
 * 注入（依赖倒置）——version-manager 不直接依赖 HTTP 客户端，保持可测且解耦。
 * 用与执行一致的输入（source+locale+aliasSet）编译，避免「前端带 alias 编译
 * 通过、后端不带 alias 误判 error」的前后端语义分裂。校验器自身抛异常（如
 * aster-api 不可达）由 createVersion fail-open 放行。
 */
export type CompileValidator = (input: {
  source: string;
  locale: string;
  aliasSet?: Readonly<Record<string, readonly string[]>> | null;
}) => Promise<{ diagnostics?: CompileDiagnostic[] }>;

/**
 * 跑源码可编译性门禁：编译含 error 诊断则抛 PolicyCompileError。
 * 校验器抛 PolicyCompileError（如上游 4xx 用户输入错误）→ 上抛拒绝落库；
 * 其它异常（5xx/网络/超时）→ fail-open 放行（记录，不阻断保存）。
 *
 * POST/PUT 路由在 db.transaction **之前**调用（避免事务内网络调用+持锁等待）；
 * createVersion 内部也调它，作为无事务直调入口（如 v1/versions）的兜底。
 */
export async function assertCompilable(
  validator: CompileValidator,
  input: {
    source: string;
    locale: string;
    aliasSet?: Readonly<Record<string, readonly string[]>> | null;
  },
): Promise<void> {
  try {
    const result = await validator(input);
    const hasError = (result.diagnostics ?? []).some(
      (d) => d.severity === 'error',
    );
    if (hasError) {
      throw new PolicyCompileError();
    }
  } catch (err) {
    if (err instanceof PolicyCompileError) throw err;
    console.warn(
      '[assertCompilable] compile precheck unavailable, allowing save',
      err instanceof Error ? err.message : err,
    );
  }
}

export interface CreateVersionParams {
  policyId: string;
  source: string;
  createdBy: string;
  releaseNote?: string;
  /** 编译 locale（进 source envelope）。缺省 'en-US'。 */
  locale?: string;
  /**
   * 用户自定义关键词别名（ADR 0022 方案 D），kind→[别名,...]。缺省=无别名。
   * 提供时经 validate → canonicalJson 冻结，并算 source envelope 一并落库。
   */
  aliasSet?: Readonly<Record<string, readonly string[]>> | null;
  /** 别名校验占用集（规范拼写/base别名/领域词汇）。提供 aliasSet 时应一并提供。 */
  aliasReserved?: ReservedSets;
  /** 是否允许结构词别名。必须由服务端 entitlement 传入。 */
  allowStructuralAliases?: boolean;
  /** 工具链身份串（进 envelope）。缺省由 env ASTER_RUNTIME_BUILD 拼。 */
  toolchainId?: string;
  /**
   * 源码可编译性校验器（注入）。提供时：编译源码，若含 error 诊断则抛
   * PolicyCompileError（拒绝落库不可编译源码）。fail-open：校验器自身抛异常
   * （编译服务不可达）→ 记录并放行。缺省=不校验（向后兼容）。
   */
  validateCompilable?: CompileValidator;
  /** 事务客户端；用于把 policy insert + version insert 包进同一事务。 */
  dbClient?: VersionDbClient;
}

export interface CreateVersionResult {
  id: string;
  version: number;
  sourceHash: string;
  sourceEnvelopeSha256: string;
}

/**
 * 创建新版本
 *
 * 自动计算链式哈希，确保版本历史完整性。
 */
/**
 * 版本状态变更后失效执行缓存。
 *
 * <h2>为什么每个改版本的函数都要调</h2>
 *
 * <p>执行入口 {@code /api/policies/[id]/execute} 命中 KV 缓存时**完全不查库**——
 * 那条 SQL 分支把 {@code policy_content} 直接选成 {@code NULL::text}，
 * 源码取自 {@code getCachedPolicyMeta()}，而缓存里存着 content 与活跃版本的 aliasSet。
 *
 * <p>此前只有 {@code PUT /api/policies/[id]} 失效缓存，版本相关的写函数一个都不失效。
 * 后果是**用户改了策略、执行的仍是旧源码**：真实事故里用户反复重建策略、
 * 甚至直接改库都无效，因为执行根本没读库——表现为源码里明明写着
 * {@code is greater than 750}，报错却说 `is` 后面跟了符号。
 *
 * <p>失败只记日志不抛：缓存失效不该阻断业务写入（写已提交，缓存另有 TTL 兜底）。
 */
async function invalidateAfterVersionChange(policyId: string): Promise<void> {
  try {
    await invalidatePolicyCache(policyId);
  } catch (err) {
    console.warn('[version-manager] 失效策略缓存失败:', policyId, err);
  }
}

export async function createVersion(
  params: CreateVersionParams
): Promise<CreateVersionResult> {
  const { policyId, source, createdBy, releaseNote } = params;
  const client = params.dbClient ?? db;
  const locale = params.locale ?? 'en-US';

  // ADR 0022 方案 D：校验 + 冻结别名 + 算 source envelope（防替换篡改）。
  let aliasSetJson: string | null = null;
  if (params.aliasSet && Object.keys(params.aliasSet).length > 0) {
    // fail-closed（Codex 复核）：有别名但没给占用集 → 拒绝。空 reserved 会跳过遮蔽/领域词
    // 碰撞校验（退回 H3/遮蔽风险）。调用方必须从 ts 引擎 lexicon 构造完整 ReservedSets。
    if (!params.aliasReserved) {
      throw new Error(
        'aliasSet 非空但未提供 aliasReserved（规范拼写/base别名/领域词汇占用集）——拒绝创建，' +
          '防跳过遮蔽/碰撞校验',
      );
    }
    const vr = validateUserAliases(params.aliasSet, params.aliasReserved, {
      allowStructural: params.allowStructuralAliases ?? false,
    });
    if (!vr.valid) {
      throw new Error(`用户自定义别名校验失败: ${vr.errors.join('; ')}`);
    }
    aliasSetJson = canonicalAliasJson(params.aliasSet);
  }

  // 有解析错误的源码不落库（覆盖所有 createVersion 入口）。POST/PUT 已在事务外
  // preflight（见 assertCompilable），故不再传 validateCompilable 进来避免事务内
  // 网络调用+重复编译；v1/versions 无事务，直接靠此兜底。
  if (params.validateCompilable) {
    await assertCompilable(params.validateCompilable, {
      source,
      locale,
      aliasSet: params.aliasSet,
    });
  }

  const toolchainId = params.toolchainId ?? cloudToolchainId();
  const sourceEnvelopeSha256 = computeSourceEnvelope(source, aliasSetJson, locale, toolchainId);

  // 获取最新版本号和链接哈希。
  // 链接 = envelope（存在时）否则 sourceHash —— 与 Java chainLink 对齐（ADR 0022 §11.5 C1-a）：
  // 让 alias_set 篡改对版本链可见（前序版本带别名时其 envelope 进链，改 alias_set 即断链）。
  const latestVersion = await client.query.policyVersions.findFirst({
    where: eq(policyVersions.policyId, policyId),
    orderBy: [desc(policyVersions.version)],
    columns: { version: true, sourceHash: true, sourceEnvelopeSha256: true },
  });

  const newVersionNumber = (latestVersion?.version ?? 0) + 1;
  const prevHash = latestVersion
    ? (latestVersion.sourceEnvelopeSha256 ?? latestVersion.sourceHash)
    : null;
  const sourceHash = computeChainedHash(source, prevHash);

  const [created] = await client.insert(policyVersions).values({
    id: crypto.randomUUID(),
    policyId,
    version: newVersionNumber,
    source,
    content: source, // 兼容旧字段
    sourceHash,
    prevHash,
    createdBy,
    releaseNote,
    status: 'DRAFT',
    aliasSet: aliasSetJson,
    sourceEnvelopeSha256,
    sourceToolchainId: toolchainId,
  }).returning();

  const hasStructuralAliases = aliasSetJson
    ? Object.keys(JSON.parse(aliasSetJson) as Record<string, string[]>)
      .some((kind) => STRUCTURAL_KINDS.has(kind))
    : false;

  await logSecurityEvent({
    eventType: 'VERSION_CREATED',
    severity: 'INFO',
    policyId,
    userId: createdBy,
    details: {
      version: newVersionNumber,
      sourceHash,
      hasAliases: aliasSetJson != null,
      aliasSet: aliasSetJson,
      hasStructuralAliases,
      structuralAliasAuthorized: params.allowStructuralAliases === true,
    },
  });

  // ★写完必须失效执行缓存：命中缓存的执行路径不查库（见 invalidateAfterVersionChange）
  await invalidateAfterVersionChange(policyId);
  return {
    id: created.id,
    version: newVersionNumber,
    sourceHash,
    sourceEnvelopeSha256,
  };

}

/**
 * 更新版本源码（仅限草稿状态）
 */
export async function updateVersionSource(params: {
  policyId: string;
  version: number;
  source: string;
  userId: string;
}): Promise<{ sourceHash: string }> {
  const { policyId, version, source, userId: _userId } = params;

  const targetVersion = await db.query.policyVersions.findFirst({
    where: and(
      eq(policyVersions.policyId, policyId),
      eq(policyVersions.version, version),
      eq(policyVersions.status, 'DRAFT')
    ),
  });

  if (!targetVersion) {
    throw new Error(`版本 v${version} 不存在或不是草稿状态，无法编辑`);
  }

  // 重新计算链式哈希
  const prevHash = targetVersion.prevHash;
  const sourceHash = computeChainedHash(source, prevHash);

  await db.update(policyVersions)
    .set({
      source,
      content: source, // 兼容旧字段
      sourceHash,
    })
    .where(eq(policyVersions.id, targetVersion.id));

  // ★写完必须失效执行缓存：命中缓存的执行路径不查库（见 invalidateAfterVersionChange）
  await invalidateAfterVersionChange(policyId);
  return { sourceHash };

}

/**
 * 提交版本审批
 */
export async function submitForApproval(params: {
  policyId: string;
  version: number;
  userId: string;
}): Promise<void> {
  const { policyId, version, userId } = params;

  await assertPolicyOwnership(policyId, userId);

  const targetVersion = await db.query.policyVersions.findFirst({
    where: and(
      eq(policyVersions.policyId, policyId),
      eq(policyVersions.version, version),
      inArray(policyVersions.status, ['DRAFT', 'REJECTED'])
    ),
  });

  if (!targetVersion) {
    throw new Error(`版本 v${version} 不存在或状态不允许提交审批`);
  }

  await db.update(policyVersions)
    .set({ status: 'PENDING_APPROVAL' })
    .where(eq(policyVersions.id, targetVersion.id));

  await logSecurityEvent({
    eventType: 'APPROVAL_DECISION',
    severity: 'INFO',
    policyId,
    userId,
    details: { version, action: 'SUBMIT_FOR_APPROVAL' },
  });

}

/**
 * 审批版本
  // ★写完必须失效执行缓存：命中缓存的执行路径不查库（见 invalidateAfterVersionChange）
  await invalidateAfterVersionChange(policyId);
 */
export async function approveVersion(params: {
  policyId: string;
  version: number;
  approverId: string;
  decision: 'APPROVED' | 'REJECTED' | 'REQUESTED_CHANGES';
  comment?: string;
}): Promise<void> {
  const { policyId, version, approverId, decision, comment } = params;

  // ★必须在四眼原则之前：四眼原则判 createdBy === approverId，
  // 对外部攻击者恒为 false，反而会放行。归属校验是它成立的前提。
  await assertPolicyOwnership(policyId, approverId);

  const targetVersion = await db.query.policyVersions.findFirst({
    where: and(
      eq(policyVersions.policyId, policyId),
      eq(policyVersions.version, version),
      eq(policyVersions.status, 'PENDING_APPROVAL')
    ),
  });

  if (!targetVersion) {
    throw new Error(`版本 v${version} 不存在或不在待审批状态`);
  }

  // 四眼原则：创建者不能审批自己的版本
  if (targetVersion.createdBy === approverId) {
    await logSecurityEvent({
      eventType: 'SELF_APPROVAL_ATTEMPT',
      severity: 'WARNING',
      policyId,
      userId: approverId,
      details: { version },
    });
    throw new Error('不能审批自己创建的版本（四眼原则）');
  }

  // 创建审批记录
  await db.insert(policyApprovals).values({
    id: crypto.randomUUID(),
    versionId: targetVersion.id,
    approverId,
    decision,
    comment,
  });

  // 更新版本状态
  let newStatus: PolicyVersionStatus;
  switch (decision) {
    case 'APPROVED':
      newStatus = 'APPROVED';
      break;
    case 'REJECTED':
      newStatus = 'REJECTED';
      break;
    case 'REQUESTED_CHANGES':
      newStatus = 'DRAFT'; // 退回修改
      break;
  }

  await db.update(policyVersions)
    .set({ status: newStatus })
    .where(eq(policyVersions.id, targetVersion.id));

  await logSecurityEvent({
    eventType: 'APPROVAL_DECISION',
    severity: 'INFO',
    policyId,
    userId: approverId,
    details: { version, decision, comment },
  });

  // PM 02 north-star: detect AHA moment (author's first approved version).
  // Fire-and-forget — failure must NOT break the approval flow.
  if (decision === 'APPROVED' && targetVersion.createdBy) {
    recordAhaMomentIfFirst({
      userId: targetVersion.createdBy,
      policyVersionId: targetVersion.id,
      approvedAt: new Date(),
    }).catch((err) => {
      console.error('[AHA detection] failed (non-blocking):', err);
    });

    // B12 — Snapshot the author's active vocabulary so future rollbacks can
    // restore the exact term set this version was compiled against. The
    // helper is itself best-effort; never block approval on snapshot IO.
    snapshotOnPolicyApprove({
      policyVersionId: targetVersion.id,
      policyAuthorId: targetVersion.createdBy,
    }).catch((err) => {
      console.error('[vocabulary-snapshot] failed (non-blocking):', err);
    });
  }

}

/**
 * 设置默认执行版本（原子操作）
  // ★写完必须失效执行缓存：命中缓存的执行路径不查库（见 invalidateAfterVersionChange）
  await invalidateAfterVersionChange(policyId);
 */
export async function setDefaultVersion(params: {
  policyId: string;
  version: number;
  userId: string;
}): Promise<void> {
  const { policyId, version, userId } = params;

  await assertPolicyOwnership(policyId, userId);

  // 验证目标版本存在且已批准
  const targetVersion = await db.query.policyVersions.findFirst({
    where: and(
      eq(policyVersions.policyId, policyId),
      eq(policyVersions.version, version),
      eq(policyVersions.status, 'APPROVED')
    ),
  });

  if (!targetVersion) {
    throw new Error(`版本 v${version} 不存在或未批准，无法设为默认`);
  }

  // 原子操作：清除旧默认 + 设置新默认
  await db.transaction(async (tx) => {
    await tx.update(policyVersions)
      .set({ isDefault: false })
      .where(and(
        eq(policyVersions.policyId, policyId),
        eq(policyVersions.isDefault, true)
      ));

    await tx.update(policyVersions)
      .set({ isDefault: true })
      .where(eq(policyVersions.id, targetVersion.id));
  });

  await logSecurityEvent({
    eventType: 'VERSION_SET_DEFAULT',
    severity: 'INFO',
    policyId,
    userId,
    details: { version },
  });

}

/**
 * 废弃版本（仍可执行，但有警告）
  // ★写完必须失效执行缓存：命中缓存的执行路径不查库（见 invalidateAfterVersionChange）
  await invalidateAfterVersionChange(policyId);
 */
export async function deprecateVersion(params: {
  policyId: string;
  version: number;
  userId: string;
  reason?: string;
}): Promise<void> {
  const { policyId, version, userId, reason } = params;

  await assertPolicyOwnership(policyId, userId);

  const targetVersion = await db.query.policyVersions.findFirst({
    where: and(
      eq(policyVersions.policyId, policyId),
      eq(policyVersions.version, version),
      eq(policyVersions.status, 'APPROVED')
    ),
  });

  if (!targetVersion) {
    throw new Error(`版本 v${version} 不存在或未批准，无法废弃`);
  }

  // 如果是默认版本，不允许废弃
  if (targetVersion.isDefault) {
    throw new Error(`版本 v${version} 是默认版本，请先设置其他版本为默认`);
  }

  await db.update(policyVersions)
    .set({
      status: 'DEPRECATED',
      deprecatedAt: new Date(),
      deprecatedBy: userId,
    })
    .where(eq(policyVersions.id, targetVersion.id));

  await logSecurityEvent({
    eventType: 'VERSION_DEPRECATED',
    severity: 'INFO',
    policyId,
    userId,
    details: { version, reason },
  });

}

/**
 * 归档版本（不可执行）
  // ★写完必须失效执行缓存：命中缓存的执行路径不查库（见 invalidateAfterVersionChange）
  await invalidateAfterVersionChange(policyId);
 */
export async function archiveVersion(params: {
  policyId: string;
  version: number;
  userId: string;
  reason?: string;
}): Promise<void> {
  const { policyId, version, userId, reason } = params;

  await assertPolicyOwnership(policyId, userId);

  const targetVersion = await db.query.policyVersions.findFirst({
    where: and(
      eq(policyVersions.policyId, policyId),
      eq(policyVersions.version, version),
      inArray(policyVersions.status, ['APPROVED', 'DEPRECATED'])
    ),
  });

  if (!targetVersion) {
    throw new Error(`版本 v${version} 不存在或状态不允许归档`);
  }

  // 如果是默认版本，不允许归档
  if (targetVersion.isDefault) {
    throw new Error(`版本 v${version} 是默认版本，请先设置其他版本为默认`);
  }

  await db.update(policyVersions)
    .set({
      status: 'ARCHIVED',
      archivedAt: new Date(),
      archivedBy: userId,
    })
    .where(eq(policyVersions.id, targetVersion.id));

  await logSecurityEvent({
    eventType: 'VERSION_ARCHIVED',
    severity: 'INFO',
    policyId,
    userId,
    details: { version, reason },
  });

}

/**
 * 获取策略的所有版本
  // ★写完必须失效执行缓存：命中缓存的执行路径不查库（见 invalidateAfterVersionChange）
  await invalidateAfterVersionChange(policyId);
 */
export async function listVersions(policyId: string) {
  const versions = await db.query.policyVersions.findMany({
    where: eq(policyVersions.policyId, policyId),
    orderBy: [desc(policyVersions.version)],
    columns: {
      id: true,
      version: true,
      sourceHash: true,
      status: true,
      isDefault: true,
      releaseNote: true,
      createdBy: true,
      createdAt: true,
      deprecatedAt: true,
      deprecatedBy: true,
      archivedAt: true,
      archivedBy: true,
    },
  });

  // 获取每个版本的审批数量
  const versionsWithCount = await Promise.all(
    versions.map(async (v) => {
      const approvalCount = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(policyApprovals)
        .where(eq(policyApprovals.versionId, v.id));

      return {
        ...v,
        _count: { approvals: approvalCount[0]?.count || 0 },
      };
    })
  );

  return versionsWithCount;
}

/**
 * 获取可执行版本列表
 */
export async function listExecutableVersions(policyId: string) {
  return db.query.policyVersions.findMany({
    where: and(
      eq(policyVersions.policyId, policyId),
      inArray(policyVersions.status, ['APPROVED', 'DEPRECATED'])
    ),
    orderBy: [desc(policyVersions.version)],
    columns: {
      version: true,
      sourceHash: true,
      status: true,
      isDefault: true,
      releaseNote: true,
      deprecatedAt: true,
    },
  });
}

/**
 * 获取特定版本详情
 */
export async function getVersionDetail(params: {
  policyId: string;
  version: number;
  userId: string;
}) {
  const { policyId, version, userId } = params;

  // 版本详情含策略源码与完整审批历史，必须限定所有者——
  // 此前仅凭 policyId 即可读取任意租户的版本详情。
  await assertPolicyOwnership(policyId, userId);

  const row = await db.query.policyVersions.findFirst({
    where: and(
      eq(policyVersions.policyId, policyId),
      eq(policyVersions.version, version)
    ),
    with: {
      approvals: {
        orderBy: [desc(policyApprovals.createdAt)],
        with: { approverUser: { columns: { name: true, email: true } } },
      },
      // 只取展示所需字段，不整行带出 User（避免把 passwordHash 等敏感列
      // 顺着版本详情 API 泄出去）。
      createdByUser: { columns: { name: true, email: true } },
      deprecatedByUser: { columns: { name: true, email: true } },
      archivedByUser: { columns: { name: true, email: true } },
    },
  });

  if (!row) return null;

  // 展平成 *Name 字段给前端：优先 name，其次 email，都没有（用户已删/历史数据）
  // 则为 null —— 前端此时回退显示原始 ID，**不假装知道是谁**。
  const { createdByUser, deprecatedByUser, archivedByUser, ...rest } = row;
  const displayName = (u: { name: string | null; email: string | null } | null | undefined) =>
    u?.name?.trim() || u?.email?.trim() || null;

  return {
    ...rest,
    createdByName: displayName(createdByUser),
    deprecatedByName: displayName(deprecatedByUser),
    archivedByName: displayName(archivedByUser),
    // 审批记录同样展平：审批人此前也直接渲染裸 UUID。
    // ★兜 undefined：`with.approvals` 理论上恒为数组，但调用方可能注入精简了
    //   relation 的 db（如归属校验单测的 mock）——不能让展示层的姓名解析把
    //   安全相关的调用路径整个打挂。
    approvals: (rest.approvals ?? []).map(({ approverUser, ...a }) => ({
      ...a,
      approverName: displayName(approverUser),
    })),
  };
}

/**
 * 获取版本的源码
 */
export async function getVersionSource(params: {
  policyId: string;
  version: number;
  userId: string;
}): Promise<{ source: string; sourceHash: string } | null> {
  const { policyId, version, userId } = params;

  await assertPolicyOwnership(policyId, userId);

  const result = await db.query.policyVersions.findFirst({
    where: and(
      eq(policyVersions.policyId, policyId),
      eq(policyVersions.version, version)
    ),
    columns: {
      source: true,
      content: true, // 兼容旧字段
      sourceHash: true,
    },
  });

  if (!result) {
    return null;
  }

  return {
    source: result.source ?? result.content,
    sourceHash: result.sourceHash ?? computeSourceHash(result.source ?? result.content),
  };
}
