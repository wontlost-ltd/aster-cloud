/**
 * 安全执行服务 - 策略安全执行器
 *
 * 实现策略执行的安全验证流程：
 * 1. 验证签名
 * 2. 验证时间戳
 * 3. 验证 Nonce（防重放）
 * 4. 获取目标版本（指定版本 或 默认版本 或 最新批准版本）
 * 5. 验证哈希匹配
 * 6. 执行策略（使用数据库中的源码）
 *
 * 遵循零信任原则：不信任任何客户端提供的源码。
 */

import { db, policies, policyVersions } from '@/lib/prisma';
import { eq, and, inArray, desc } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import {
  verifySignature,
  validateTimestamp,
  type SignedRequest,
} from './policy-security';
import { checkAndRecordNonce } from './nonce-service';
import { logSecurityEvent } from './security-event-service';
import { assertPolicyOwnership } from '../policy/version-manager';
import { createPolicyApiClient } from '../policy/policy-api';
import {
  ambiguousInputFieldMessage,
  INPUT_TYPE_EXTRACTION_FAILED_MESSAGE,
  inputMappingAudit,
  loadVersionExecutionVocabulary,
  prepareExecutionInput,
  type AmbiguousInputField,
} from '@/lib/execution-input';
import { resolveStoredVersionLocale } from '@/lib/policy-version-locale';
import { safeEnv } from '@/lib/runtime/safe-env';

type Policy = InferSelectModel<typeof policies>;
type PolicyVersion = InferSelectModel<typeof policyVersions>;
type PolicyVersionStatus = PolicyVersion['status'];

export interface SecureExecuteOptions {
  request: SignedRequest;
  userId: string;
  tenantId: string;
  ipAddress?: string;
  userAgent?: string;
  requestId?: string;
}

export interface SecureExecuteResult {
  success: boolean;
  result?: unknown;
  error?: string;
  errorCode?: SecurityErrorCode;
  executionTimeMs?: number;
  version?: number;
  sourceHash?: string;
  isDeprecated?: boolean;
  expectedVersion?: number;
  expectedHash?: string;
  /** errorCode=AMBIGUOUS_INPUT_FIELD 时：冲突字段（#626）。 */
  ambiguous?: AmbiguousInputField;
}

export type SecurityErrorCode =
  | 'SIGNATURE_INVALID'
  | 'NONCE_REUSED'
  | 'NONCE_INVALID'
  | 'TIMESTAMP_EXPIRED'
  | 'HASH_MISMATCH'
  | 'POLICY_NOT_FOUND'
  | 'NO_APPROVED_VERSION'
  | 'VERSION_NOT_EXECUTABLE'
  | 'AMBIGUOUS_INPUT_FIELD'
  | 'INPUT_TYPE_EXTRACTION_FAILED'
  | 'EXECUTION_FAILED';

const SIGNING_SECRET = safeEnv('POLICY_SIGNING_SECRET') || '';

type PolicyVersionWithPolicy = PolicyVersion & {
  policy: Policy;
};

/**
 * 安全执行策略（支持多版本共存）
 *
 * 多版本执行规则：
 * - 如果请求包含 version 字段：执行指定版本（必须是 APPROVED 或 DEPRECATED）
 * - 如果未指定版本：优先执行 isDefault=true 的版本，否则执行最新批准版本
 * - DEPRECATED 版本仍可执行，但会记录警告日志
 * - ARCHIVED 版本不可执行
 */
export async function executeSecurely(
  options: SecureExecuteOptions
): Promise<SecureExecuteResult> {
  const { request, userId, tenantId, ipAddress, userAgent, requestId } = options;
  const eventContext = {
    policyId: request.policyId,
    userId,
    ipAddress,
    userAgent,
    requestId,
  };

  // 0. 归属校验（★必须最先做）
  //
  // 此前本函数只校验登录态：`policyId` 从 URL 直接进来，而下面所有查询只按
  // `policyId + version + status` 过滤 → **任何登录用户可执行任意租户的策略**。
  // version-manager.ts 的 IDOR 修复注释列了 8 个受影响路由并明确点名
  // secure-execute，但那次只收口了走 version-manager 的 7 个；本函数有自己的
  // 服务层，被漏下了。
  //
  // 为何放在签名校验**之前**：下面 409 分支会把 `expectedHash`/`expectedVersion`
  // 回给调用方，那是攻击者补齐重放所需的最后一块拼图。先判归属，非所有者
  // 拿不到任何信息。
  //
  // 也不能依赖签名当门禁：SIGNING_SECRET 取自 POLICY_SIGNING_SECRET，而该变量
  // 在全仓任何配置里都不存在（只有本文件读它），`|| ''` 使其退化为空串——
  // 任何人都能用空密钥算出合法签名。密钥即便配上也是**全局单一**，不区分
  // user/tenant/policy，故本质上无法充当归属证明。
  await assertPolicyOwnership(request.policyId, userId);

  // 1. 验证签名
  if (!verifySignature(request, SIGNING_SECRET)) {
    await logSecurityEvent({
      ...eventContext,
      eventType: 'SIGNATURE_INVALID',
      severity: 'ERROR',
      details: {
        providedSignature: request.signature.substring(0, 20) + '...',
      },
    });
    return {
      success: false,
      error: '请求签名无效',
      errorCode: 'SIGNATURE_INVALID',
    };
  }

  // 2. 验证时间戳
  if (!validateTimestamp(request.timestamp)) {
    await logSecurityEvent({
      ...eventContext,
      eventType: 'TIMESTAMP_EXPIRED',
      severity: 'WARNING',
      details: {
        providedTimestamp: request.timestamp,
        serverTime: Date.now(),
      },
    });
    return {
      success: false,
      error: '请求时间戳已过期',
      errorCode: 'TIMESTAMP_EXPIRED',
    };
  }

  // 3. 验证 Nonce（防重放）
  const nonceResult = await checkAndRecordNonce(
    request.nonce,
    request.policyId,
    userId
  );
  if (!nonceResult.valid) {
    await logSecurityEvent({
      ...eventContext,
      eventType: 'NONCE_REUSED',
      severity: 'ERROR',
      details: { nonce: request.nonce, reason: nonceResult.reason },
    });
    return {
      success: false,
      error:
        nonceResult.reason === 'ALREADY_USED'
          ? 'Nonce 已被使用'
          : 'Nonce 格式无效',
      errorCode:
        nonceResult.reason === 'ALREADY_USED' ? 'NONCE_REUSED' : 'NONCE_INVALID',
    };
  }

  // 4. 获取目标版本（支持多版本共存）
  let targetVersion: PolicyVersionWithPolicy | null = null;
  let isDeprecated = false;

  if (request.version !== undefined) {
    // 4a. 指定版本执行
    targetVersion = (await db.query.policyVersions.findFirst({
      where: and(
        eq(policyVersions.policyId, request.policyId),
        eq(policyVersions.version, request.version),
        inArray(policyVersions.status, ['APPROVED', 'DEPRECATED'])
      ),
      with: { policy: true },
    })) as PolicyVersionWithPolicy | null;

    if (!targetVersion) {
      await logSecurityEvent({
        ...eventContext,
        eventType: 'VERSION_NOT_FOUND',
        severity: 'WARNING',
        details: { requestedVersion: request.version },
      });
      return {
        success: false,
        error: `版本 v${request.version} 不存在或不可执行（仅 APPROVED/DEPRECATED 状态可执行）`,
        errorCode: 'VERSION_NOT_EXECUTABLE',
      };
    }

    // 如果是已废弃版本，记录警告
    if (targetVersion.status === 'DEPRECATED') {
      isDeprecated = true;
      await logSecurityEvent({
        ...eventContext,
        eventType: 'DEPRECATED_VERSION_EXECUTED',
        severity: 'WARNING',
        details: {
          version: request.version,
          deprecatedAt: targetVersion.deprecatedAt,
          deprecatedBy: targetVersion.deprecatedBy,
        },
      });
    }
  } else {
    // 4b. 默认版本执行：优先 isDefault，否则最新批准
    targetVersion = await findDefaultExecutableVersion(request.policyId);

    if (!targetVersion) {
      return {
        success: false,
        error: '未找到可执行的策略版本',
        errorCode: 'NO_APPROVED_VERSION',
      };
    }
  }

  // 5. 验证哈希匹配。
  //   - 首选 envelope 哈希（sourceEnvelopeSha256）：覆盖 content+aliasSet+locale+工具链，
  //     绑定完整编译输入，能区分「同 content 不同别名」的两个版本（否则别名替换/版本漂移
  //     不被哈希察觉）。
  //   - 兼容旧客户端：现有前端 computeHashInBrowser 只对 source 串算 SHA-256（=sourceHash），
  //     故 envelope 或 sourceHash 任一匹配即通过（不硬切协议，避免滚动期全体 HASH_MISMATCH，
  //     与 C-HMAC 双栈同思路）。老版本 sourceEnvelopeSha256 为 NULL 时天然回退 sourceHash。
  const envelopeHash = targetVersion.sourceEnvelopeSha256;
  const sourceHash = targetVersion.sourceHash;
  const hashOk =
    (envelopeHash != null && request.hash === envelopeHash) ||
    (sourceHash != null && request.hash === sourceHash);
  const expectedHash = envelopeHash ?? sourceHash;
  if (!hashOk) {
    await logSecurityEvent({
      ...eventContext,
      eventType: 'HASH_MISMATCH',
      severity: 'ERROR',
      details: {
        requestedHash: request.hash,
        expectedHash: expectedHash,
        requestedVersion: request.version,
        actualVersion: targetVersion.version,
      },
    });
    return {
      success: false,
      error:
        request.version !== undefined
          ? `版本 v${request.version} 的哈希不匹配`
          : '策略哈希不匹配，请刷新页面获取最新版本',
      errorCode: 'HASH_MISMATCH',
      expectedVersion: targetVersion.version,
      expectedHash: expectedHash ?? undefined,
    };
  }

  // 6. 执行策略（使用数据库中的源码，不使用请求中的任何源码）
  const startTime = Date.now();
  try {
    // 获取源码：优先使用 source 字段，兼容旧版本使用 content 字段
    const sourceCode = targetVersion.source ?? targetVersion.content;

    if (!sourceCode) {
      throw new Error('策略源码不存在');
    }

    // 执行端按 locale 选 lexicon：优先取版本保存时记录的编译 locale（envelope），
    // 其次沿用快照引用唯一 locale，最后才按源码识别（见 policy-version-locale）。
    const locale = resolveStoredVersionLocale({
      source: sourceCode,
      aliasSet: targetVersion.aliasSet,
      sourceEnvelopeSha256: targetVersion.sourceEnvelopeSha256,
      sourceToolchainId: targetVersion.sourceToolchainId,
      vocabularySnapshotIds: targetVersion.vocabularySnapshotIds,
    });
    // 领域词汇（ADR 0014 线C，#626）：可执行版本均已审批，走冻结快照（作用域内），best-effort。
    const vocabulary = await loadVersionExecutionVocabulary({
      status: targetVersion.status,
      vocabularySnapshotIds: targetVersion.vocabularySnapshotIds,
      authorId: targetVersion.createdBy,
      source: sourceCode,
      locale,
    });

    // C1（secure-execute）：把该版本冻结的关键词别名（canonical JSON）透传到执行端，使
    // 别名源码能规范化编译。冻结即信任——版本创建时已授权+校验+进 envelope，执行不重查
    // grant。损坏 JSON 视为无别名，不阻断执行（envelope 另有防篡改）。
    let aliasSet: Record<string, string[]> | undefined;
    if (targetVersion.aliasSet) {
      try {
        aliasSet = JSON.parse(targetVersion.aliasSet) as Record<string, string[]>;
      } catch {
        aliasSet = undefined;
      }
    }

    // #626：签名已按原始输入校验；此后把策略语言的字段名/枚举值映射为规范名再交给引擎。
    const prepared = prepareExecutionInput({
      input: request.input,
      functionName: undefined,
      vocabulary,
      source: sourceCode,
      locale,
      aliasSet,
    });
    if (!prepared.ok && prepared.reason === 'type_extraction_failed') {
      return { success: false, error: INPUT_TYPE_EXTRACTION_FAILED_MESSAGE, errorCode: 'INPUT_TYPE_EXTRACTION_FAILED' };
    }
    if (!prepared.ok) {
      return {
        success: false,
        error: ambiguousInputFieldMessage(prepared.ambiguous),
        errorCode: 'AMBIGUOUS_INPUT_FIELD',
        ambiguous: prepared.ambiguous,
      };
    }

    const mappingAudit = inputMappingAudit(request.input, prepared.renames);

    const apiClient = createPolicyApiClient(tenantId, userId);
    const response = await apiClient.evaluateSource(
      sourceCode, // 关键：使用数据库中的源码
      prepared.input as Record<string, unknown>,
      {
        locale,
        ...(vocabulary ? { vocabulary } : {}),
        ...(aliasSet ? { aliasSet } : {}),
      }
    );

    const executionTimeMs = Date.now() - startTime;

    await logSecurityEvent({
      ...eventContext,
      eventType: 'POLICY_EXECUTED',
      severity: 'INFO',
      details: {
        version: targetVersion.version,
        isDeprecated,
        executionTimeMs,
        success: !response.error,
        // #626 审计（新增字段）：签名覆盖原始输入，引擎执行映射后的输入；记录原始输入哈希与改写位置。
        inputMapping: mappingAudit,
      },
    });

    return {
      success: !response.error,
      result: response.result,
      error: response.error ?? undefined,
      executionTimeMs,
      version: targetVersion.version,
      sourceHash: targetVersion.sourceHash ?? undefined,
      isDeprecated,
    };
  } catch (error) {
    const executionTimeMs = Date.now() - startTime;

    await logSecurityEvent({
      ...eventContext,
      eventType: 'POLICY_EXECUTED',
      severity: 'ERROR',
      details: {
        version: targetVersion.version,
        executionTimeMs,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
    });

    return {
      success: false,
      error: '策略执行失败',
      errorCode: 'EXECUTION_FAILED',
      executionTimeMs,
    };
  }
}

/**
 * 获取策略的可执行版本列表
 *
 * 返回所有 APPROVED 和 DEPRECATED 状态的版本，
 * 用于前端展示版本选择器。
 */
export async function getExecutableVersions(policyId: string): Promise<
  Array<{
    version: number;
    sourceHash: string | null;
    status: PolicyVersionStatus;
    isDefault: boolean;
    releaseNote: string | null;
    createdAt: Date;
    deprecatedAt: Date | null;
  }>
> {
  const versions = await db.query.policyVersions.findMany({
    where: and(
      eq(policyVersions.policyId, policyId),
      inArray(policyVersions.status, ['APPROVED', 'DEPRECATED'])
    ),
    columns: {
      version: true,
      sourceHash: true,
      status: true,
      isDefault: true,
      releaseNote: true,
      createdAt: true,
      deprecatedAt: true,
    },
    orderBy: [desc(policyVersions.version)],
  });

  return versions;
}

/**
 * 未指定版本时 secure-execute 执行的版本：优先 isDefault 的 APPROVED 版本，否则最新 APPROVED 版本；
 * 都没有时返回 null。草稿等未批准版本永不入选——Cedar 导出复用本函数，保证导出的就是会被执行的版本。
 */
export async function findDefaultExecutableVersion(policyId: string): Promise<PolicyVersionWithPolicy | null> {
  const preferred = await db.query.policyVersions.findFirst({
    where: and(
      eq(policyVersions.policyId, policyId),
      eq(policyVersions.status, 'APPROVED'),
      eq(policyVersions.isDefault, true)
    ),
    with: { policy: true },
  });
  if (preferred) return preferred as PolicyVersionWithPolicy;

  const latest = await db.query.policyVersions.findFirst({
    where: and(
      eq(policyVersions.policyId, policyId),
      eq(policyVersions.status, 'APPROVED')
    ),
    orderBy: [desc(policyVersions.version)],
    with: { policy: true },
  });
  return (latest as PolicyVersionWithPolicy | undefined) ?? null;
}

/**
 * 获取策略的默认版本信息
 *
 * 用于前端初始加载时获取默认执行版本的哈希。
 */
export async function getDefaultVersionInfo(policyId: string): Promise<{
  version: number;
  sourceHash: string;
  source: string;
} | null> {
  const version = await findDefaultExecutableVersion(policyId);
  if (!version || !version.sourceHash) {
    return null;
  }

  return {
    version: version.version,
    sourceHash: version.sourceHash,
    source: version.source ?? version.content,
  };
}
