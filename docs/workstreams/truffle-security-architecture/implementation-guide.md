# Truffle 安全架构 - 实施指南

> **已下线（2026-10-30）**：本文描述的 `POST /api/v1/policies/{id}/secure-execute`（共享密钥 HMAC 签名执行）及
> `src/services/security/secure-executor.ts` 已移除（#654）。原因：生产从未配置 `POLICY_SIGNING_SECRET`，验签实际以空串
> 进行，签名形同虚设；原客户端方案还要求浏览器读取 `NEXT_PUBLIC_` 密钥，等于公开密钥；该端点只认登录会话、不认 API Key，
> 界面也没有调用方。普通执行路径已按当前生效版本、envelope 校验与冻结词汇快照执行。将来如需「按指定版本执行」，
> 应在普通 execute / v1 execute 上加可选的期望版本哈希参数，复用现有认证与配额。以下为历史设计，仅供参考。

本文档提供安全架构的详细实现代码，可直接用于开发。

## 目录

1. [Prisma Schema 扩展](#1-prisma-schema-扩展)
2. [安全服务实现](#2-安全服务实现)
3. [API 路由实现](#3-api-路由实现)
4. [前端集成](#4-前端集成)
5. [定时任务](#5-定时任务)
6. [多版本共存](#6-多版本共存)

---

## 1. Prisma Schema 扩展

在 `prisma/schema.prisma` 中添加：

```prisma
// ============================================
// 策略安全架构扩展
// ============================================

// 策略版本表（支持多版本共存）
model PolicyVersion {
  id           String              @id @default(cuid())
  policyId     String
  version      Int
  source       String              @db.Text
  sourceHash   String              // SHA-256(source)
  prevHash     String?             // 链式哈希，指向前一版本
  createdBy    String
  createdAt    DateTime            @default(now())
  status       PolicyVersionStatus @default(DRAFT)

  // 多版本共存支持
  isDefault    Boolean             @default(false)  // 是否为默认执行版本
  releaseNote  String?             @db.Text         // 版本发布说明
  deprecatedAt DateTime?                            // 废弃时间
  deprecatedBy String?                              // 废弃操作人
  archivedAt   DateTime?                            // 归档时间
  archivedBy   String?                              // 归档操作人

  policy    Policy           @relation(fields: [policyId], references: [id], onDelete: Cascade)
  approvals PolicyApproval[]

  @@unique([policyId, version])
  @@index([policyId])
  @@index([sourceHash])
  @@index([status])
  @@index([policyId, status])
  @@index([policyId, isDefault])
}

enum PolicyVersionStatus {
  DRAFT              // 草稿 - 编辑中
  PENDING_APPROVAL   // 待审批 - 已提交等待审批
  APPROVED           // 已批准 - 可执行
  REJECTED           // 已拒绝 - 不可执行
  DEPRECATED         // 已废弃 - 仍可执行但有警告
  ARCHIVED           // 已归档 - 不可执行，仅供审计
}

// 审批记录表
model PolicyApproval {
  id         String           @id @default(cuid())
  versionId  String
  approverId String
  decision   ApprovalDecision
  comment    String?          @db.Text
  createdAt  DateTime         @default(now())

  version PolicyVersion @relation(fields: [versionId], references: [id], onDelete: Cascade)

  @@index([versionId])
  @@index([approverId])
  @@index([createdAt])
}

enum ApprovalDecision {
  APPROVED
  REJECTED
  REQUESTED_CHANGES
}

// Nonce 表（防重放攻击）
model UsedNonce {
  id        String   @id @default(cuid())
  nonce     String   @unique
  policyId  String?  // 关联的策略 ID
  userId    String?  // 使用者 ID
  usedAt    DateTime @default(now())
  expiresAt DateTime

  @@index([expiresAt])
  @@index([policyId])
}

// 安全事件日志
model SecurityEvent {
  id         String            @id @default(cuid())
  eventType  SecurityEventType
  severity   EventSeverity
  policyId   String?
  userId     String?
  ipAddress  String?
  userAgent  String?
  requestId  String?           // 请求追踪 ID
  details    Json
  createdAt  DateTime          @default(now())

  @@index([eventType])
  @@index([severity])
  @@index([policyId])
  @@index([createdAt])
}

enum SecurityEventType {
  SIGNATURE_INVALID           // 签名无效
  NONCE_REUSED                // Nonce 重放
  TIMESTAMP_EXPIRED           // 时间戳过期
  HASH_MISMATCH               // 哈希不匹配
  UNAUTHORIZED_APPROVAL       // 未授权审批
  SELF_APPROVAL_ATTEMPT       // 自审批尝试
  POLICY_EXECUTED             // 策略执行
  APPROVAL_DECISION           // 审批决策
  VERSION_CREATED             // 版本创建
  VERSION_NOT_FOUND           // 版本不存在
  DEPRECATED_VERSION_EXECUTED // 执行已废弃版本（警告）
  VERSION_SET_DEFAULT         // 设置默认版本
  VERSION_DEPRECATED          // 版本被废弃
  VERSION_ARCHIVED            // 版本被归档
}

enum EventSeverity {
  INFO
  WARNING
  ERROR
  CRITICAL
}

// 在 Policy 模型中添加关联
// model Policy {
//   ...existing fields...
//   versions PolicyVersion[]
// }
```

---

## 2. 安全服务实现

### 2.1 哈希与签名服务

`src/services/security/policy-security.ts`

```typescript
import { createHmac, createHash } from 'crypto';

const TIMESTAMP_WINDOW_MS = 5 * 60 * 1000; // 5 分钟

export interface SignedRequest {
  policyId: string;
  hash: string;
  input: unknown;
  timestamp: number;
  nonce: string;
  signature: string;
  version?: number;  // 可选：指定执行版本（不传则使用默认版本）
}

export interface SignaturePayload {
  policyId: string;
  hash: string;
  input: unknown;
  timestamp: number;
  nonce: string;
  version?: number;  // 可选：指定执行版本
}

/**
 * 计算策略源码的 SHA-256 哈希
 */
export function computeSourceHash(source: string): string {
  return `sha256:${createHash('sha256').update(source, 'utf8').digest('hex')}`;
}

/**
 * 计算链式哈希（包含前一版本哈希）
 */
export function computeChainedHash(source: string, prevHash: string | null): string {
  const content = prevHash ? `${source}${prevHash}` : source;
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

/**
 * 生成请求签名
 */
export function signRequest(payload: SignaturePayload, secret: string): string {
  const data = JSON.stringify({
    policyId: payload.policyId,
    hash: payload.hash,
    input: payload.input,
    timestamp: payload.timestamp,
    nonce: payload.nonce,
    version: payload.version,  // 包含版本号（可选）
  });

  const signature = createHmac('sha256', secret).update(data).digest('hex');
  return `hmac-sha256:${signature}`;
}

/**
 * 验证请求签名
 */
export function verifySignature(request: SignedRequest, secret: string): boolean {
  const expectedSignature = signRequest(
    {
      policyId: request.policyId,
      hash: request.hash,
      input: request.input,
      timestamp: request.timestamp,
      nonce: request.nonce,
      version: request.version,  // 包含版本号（可选）
    },
    secret
  );

  // 使用时间安全比较防止时序攻击
  return timingSafeEqual(request.signature, expectedSignature);
}

/**
 * 验证时间戳是否在有效窗口内
 */
export function validateTimestamp(timestamp: number): boolean {
  const now = Date.now();
  const diff = Math.abs(now - timestamp);
  return diff <= TIMESTAMP_WINDOW_MS;
}

/**
 * 时间安全的字符串比较
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
```

### 2.2 Nonce 服务

`src/services/security/nonce-service.ts`

```typescript
import { prisma } from '@/lib/prisma';

const NONCE_EXPIRY_MS = 10 * 60 * 1000; // 10 分钟

export interface NonceCheckResult {
  valid: boolean;
  reason?: 'ALREADY_USED' | 'INVALID_FORMAT';
}

/**
 * 检查并记录 Nonce（原子操作）
 */
export async function checkAndRecordNonce(
  nonce: string,
  policyId?: string,
  userId?: string
): Promise<NonceCheckResult> {
  // 验证 Nonce 格式（UUID v4）
  const uuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuidV4Regex.test(nonce)) {
    return { valid: false, reason: 'INVALID_FORMAT' };
  }

  const expiresAt = new Date(Date.now() + NONCE_EXPIRY_MS);

  try {
    // 尝试创建 Nonce 记录（唯一约束保证原子性）
    await prisma.usedNonce.create({
      data: {
        nonce,
        policyId,
        userId,
        expiresAt,
      },
    });
    return { valid: true };
  } catch (error: unknown) {
    // 唯一约束冲突 = Nonce 已被使用
    if (isPrismaUniqueConstraintError(error)) {
      return { valid: false, reason: 'ALREADY_USED' };
    }
    throw error;
  }
}

/**
 * 清理过期的 Nonce 记录
 */
export async function cleanupExpiredNonces(): Promise<number> {
  const result = await prisma.usedNonce.deleteMany({
    where: {
      expiresAt: {
        lt: new Date(),
      },
    },
  });
  return result.count;
}

function isPrismaUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: string }).code === 'P2002'
  );
}
```

### 2.3 安全事件服务

`src/services/security/security-event-service.ts`

```typescript
import { prisma } from '@/lib/prisma';
import type { SecurityEventType, EventSeverity } from '@prisma/client';

export interface SecurityEventData {
  eventType: SecurityEventType;
  severity: EventSeverity;
  policyId?: string;
  userId?: string;
  ipAddress?: string;
  userAgent?: string;
  requestId?: string;
  details: Record<string, unknown>;
}

/**
 * 记录安全事件
 */
export async function logSecurityEvent(data: SecurityEventData): Promise<void> {
  try {
    await prisma.securityEvent.create({
      data: {
        eventType: data.eventType,
        severity: data.severity,
        policyId: data.policyId,
        userId: data.userId,
        ipAddress: data.ipAddress,
        userAgent: data.userAgent,
        requestId: data.requestId,
        details: data.details,
      },
    });
  } catch (error) {
    // 安全事件记录失败不应影响主流程
    console.error('[SecurityEvent] Failed to log event:', error);
  }
}

/**
 * 批量记录安全事件（用于审计导出）
 */
export async function getSecurityEvents(options: {
  startDate?: Date;
  endDate?: Date;
  eventTypes?: SecurityEventType[];
  severities?: EventSeverity[];
  policyId?: string;
  limit?: number;
  offset?: number;
}) {
  const where: Record<string, unknown> = {};

  if (options.startDate || options.endDate) {
    where.createdAt = {};
    if (options.startDate) {
      (where.createdAt as Record<string, unknown>).gte = options.startDate;
    }
    if (options.endDate) {
      (where.createdAt as Record<string, unknown>).lte = options.endDate;
    }
  }

  if (options.eventTypes?.length) {
    where.eventType = { in: options.eventTypes };
  }

  if (options.severities?.length) {
    where.severity = { in: options.severities };
  }

  if (options.policyId) {
    where.policyId = options.policyId;
  }

  return prisma.securityEvent.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: options.limit ?? 100,
    skip: options.offset ?? 0,
  });
}
```

### 2.4 安全执行服务

`src/services/security/secure-executor.ts`

```typescript
import { prisma } from '@/lib/prisma';
import {
  computeSourceHash,
  verifySignature,
  validateTimestamp,
  type SignedRequest,
} from './policy-security';
import { checkAndRecordNonce } from './nonce-service';
import { logSecurityEvent } from './security-event-service';
import { createPolicyApiClient } from '../policy/policy-api';

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
  isDeprecated?: boolean;      // 是否执行的是已废弃版本
  expectedVersion?: number;    // 哈希不匹配时，期望的版本号
  expectedHash?: string;       // 哈希不匹配时，期望的哈希
}

export type SecurityErrorCode =
  | 'SIGNATURE_INVALID'
  | 'NONCE_REUSED'
  | 'NONCE_INVALID'
  | 'TIMESTAMP_EXPIRED'
  | 'HASH_MISMATCH'
  | 'POLICY_NOT_FOUND'
  | 'NO_APPROVED_VERSION'
  | 'VERSION_NOT_EXECUTABLE'   // 指定版本不可执行（未批准或已归档）
  | 'EXECUTION_FAILED';

const SIGNING_SECRET = process.env.POLICY_SIGNING_SECRET || '';

/**
 * 安全执行策略（支持多版本共存）
 *
 * 执行流程：
 * 1. 验证签名
 * 2. 验证时间戳
 * 3. 验证 Nonce（防重放）
 * 4. 获取目标版本（指定版本 或 默认版本 或 最新批准版本）
 * 5. 验证哈希匹配
 * 6. 执行策略
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
  const eventContext = { policyId: request.policyId, userId, ipAddress, userAgent, requestId };

  // 1. 验证签名
  if (!verifySignature(request, SIGNING_SECRET)) {
    await logSecurityEvent({
      ...eventContext,
      eventType: 'SIGNATURE_INVALID',
      severity: 'ERROR',
      details: { providedSignature: request.signature.substring(0, 20) + '...' },
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
  const nonceResult = await checkAndRecordNonce(request.nonce, request.policyId, userId);
  if (!nonceResult.valid) {
    await logSecurityEvent({
      ...eventContext,
      eventType: 'NONCE_REUSED',
      severity: 'ERROR',
      details: { nonce: request.nonce, reason: nonceResult.reason },
    });
    return {
      success: false,
      error: nonceResult.reason === 'ALREADY_USED' ? 'Nonce 已被使用' : 'Nonce 格式无效',
      errorCode: nonceResult.reason === 'ALREADY_USED' ? 'NONCE_REUSED' : 'NONCE_INVALID',
    };
  }

  // 4. 获取目标版本（支持多版本共存）
  let targetVersion: PolicyVersionWithPolicy | null = null;
  let isDeprecated = false;

  if (request.version !== undefined) {
    // 4a. 指定版本执行
    targetVersion = await prisma.policyVersion.findFirst({
      where: {
        policyId: request.policyId,
        version: request.version,
        status: { in: ['APPROVED', 'DEPRECATED'] },  // 允许执行已批准或已废弃版本
      },
      include: { policy: true },
    });

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
    targetVersion = await prisma.policyVersion.findFirst({
      where: {
        policyId: request.policyId,
        status: 'APPROVED',
        isDefault: true,
      },
      include: { policy: true },
    });

    if (!targetVersion) {
      // 没有默认版本，取最新批准版本
      targetVersion = await prisma.policyVersion.findFirst({
        where: {
          policyId: request.policyId,
          status: 'APPROVED',
        },
        orderBy: { version: 'desc' },
        include: { policy: true },
      });
    }

    if (!targetVersion) {
      return {
        success: false,
        error: '未找到可执行的策略版本',
        errorCode: 'NO_APPROVED_VERSION',
      };
    }
  }

  // 5. 验证哈希匹配
  const expectedHash = targetVersion.sourceHash;
  if (request.hash !== expectedHash) {
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
      error: request.version !== undefined
        ? `版本 v${request.version} 的哈希不匹配`
        : '策略哈希不匹配，请刷新页面获取最新版本',
      errorCode: 'HASH_MISMATCH',
      expectedVersion: targetVersion.version,
      expectedHash: expectedHash,
    };
  }

  // 6. 执行策略（使用数据库中的源码，不使用请求中的任何源码）
  const startTime = Date.now();
  try {
    const apiClient = createPolicyApiClient(tenantId, userId);
    const response = await apiClient.evaluateSource(
      targetVersion.source, // 关键：使用数据库中的源码
      request.input as Record<string, unknown>
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
        success: response.success,
      },
    });

    return {
      success: response.success,
      result: response.result,
      error: response.error,
      executionTimeMs,
      version: targetVersion.version,
      sourceHash: targetVersion.sourceHash,
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

// 类型定义
type PolicyVersionWithPolicy = Awaited<ReturnType<typeof prisma.policyVersion.findFirst>> & {
  policy: Policy;
};
```

---

## 3. API 路由实现

### 3.1 安全执行端点

`src/app/api/v1/policies/[id]/secure-execute/route.ts`

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { executeSecurely, type SignedRequest } from '@/services/security/secure-executor';
import { v4 as uuidv4 } from 'uuid';

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const requestId = uuidv4();
  
  try {
    // 1. 认证
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json(
        { success: false, error: '未授权' },
        { status: 401 }
      );
    }

    // 2. 解析请求体
    const body = await request.json();
    const signedRequest: SignedRequest = {
      policyId: params.id,
      hash: body.hash,
      input: body.input,
      timestamp: body.timestamp,
      nonce: body.nonce,
      signature: body.signature,
      version: body.version,  // 可选：指定执行版本
    };

    // 3. 获取请求元数据
    const ipAddress = request.headers.get('x-forwarded-for')?.split(',')[0] || 
                      request.headers.get('x-real-ip') || 
                      'unknown';
    const userAgent = request.headers.get('user-agent') || undefined;

    // 4. 安全执行
    const result = await executeSecurely({
      request: signedRequest,
      userId: session.user.id,
      tenantId: session.user.teamId || session.user.id,
      ipAddress,
      userAgent,
      requestId,
    });

    // 5. 返回结果
    const status = result.success ? 200 : 
                   result.errorCode === 'SIGNATURE_INVALID' ? 401 :
                   result.errorCode === 'HASH_MISMATCH' ? 409 :
                   400;

    return NextResponse.json(
      {
        success: result.success,
        result: result.result,
        error: result.error,
        errorCode: result.errorCode,
        executionTimeMs: result.executionTimeMs,
        version: result.version,
        sourceHash: result.sourceHash,
        isDeprecated: result.isDeprecated,        // 是否执行的是已废弃版本
        expectedVersion: result.expectedVersion,  // 哈希不匹配时的期望版本
        expectedHash: result.expectedHash,        // 哈希不匹配时的期望哈希
        requestId,
      },
      { status }
    );
  } catch (error) {
    console.error(`[SecureExecute] Request ${requestId} failed:`, error);
    return NextResponse.json(
      {
        success: false,
        error: '服务器内部错误',
        requestId,
      },
      { status: 500 }
    );
  }
}
```

---

## 4. 前端集成

### 4.1 安全执行 Hook

`src/hooks/useSecurePolicyExecute.ts`

```typescript
import { useState, useCallback } from 'react';
import { v4 as uuidv4 } from 'uuid';

interface SecureExecuteOptions {
  policyId: string;
  source: string;
  input: Record<string, unknown>;
  version?: number;  // 可选：指定执行版本
}

interface SecureExecuteResult {
  success: boolean;
  result?: unknown;
  error?: string;
  errorCode?: string;
  executionTimeMs?: number;
  version?: number;
  isDeprecated?: boolean;      // 是否执行的是已废弃版本
  expectedVersion?: number;    // 哈希不匹配时的期望版本
  expectedHash?: string;       // 哈希不匹配时的期望哈希
}

// 注意：在生产环境中，签名应该在后端完成（BFF 模式）
// 这里的实现仅用于演示，实际部署时应使用服务端签名
const SIGNING_SECRET = process.env.NEXT_PUBLIC_POLICY_SIGNING_SECRET || '';

export function useSecurePolicyExecute() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const execute = useCallback(async (options: SecureExecuteOptions): Promise<SecureExecuteResult> => {
    setLoading(true);
    setError(null);

    try {
      // 1. 计算源码哈希
      const hash = await computeHashInBrowser(options.source);

      // 2. 生成请求参数
      const timestamp = Date.now();
      const nonce = uuidv4();

      // 3. 生成签名（生产环境应在 BFF 层完成）
      const signature = await signRequestInBrowser({
        policyId: options.policyId,
        hash,
        input: options.input,
        timestamp,
        nonce,
        version: options.version,  // 包含版本号
      });

      // 4. 发送请求
      const response = await fetch(`/api/v1/policies/${options.policyId}/secure-execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          hash,
          input: options.input,
          timestamp,
          nonce,
          signature,
          version: options.version,  // 指定执行版本
        }),
      });

      const result = await response.json();

      if (!result.success) {
        setError(result.error || '执行失败');
      }

      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : '未知错误';
      setError(message);
      return { success: false, error: message };
    } finally {
      setLoading(false);
    }
  }, []);

  return { execute, loading, error };
}

async function computeHashInBrowser(source: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(source);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return `sha256:${hashHex}`;
}

async function signRequestInBrowser(payload: {
  policyId: string;
  hash: string;
  input: unknown;
  timestamp: number;
  nonce: string;
  version?: number;  // 可选：指定执行版本
}): Promise<string> {
  const data = JSON.stringify(payload);
  const encoder = new TextEncoder();
  const keyData = encoder.encode(SIGNING_SECRET);
  const messageData = encoder.encode(data);

  const key = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signatureBuffer = await crypto.subtle.sign('HMAC', key, messageData);
  const signatureArray = Array.from(new Uint8Array(signatureBuffer));
  const signatureHex = signatureArray.map(b => b.toString(16).padStart(2, '0')).join('');
  
  return `hmac-sha256:${signatureHex}`;
}
```

---

## 5. 定时任务

### 5.1 Nonce 清理任务

`src/cron/cleanup-nonces.ts`

```typescript
import { cleanupExpiredNonces } from '@/services/security/nonce-service';

/**
 * 清理过期的 Nonce 记录
 * 建议每 5 分钟运行一次
 */
export async function cleanupNoncesJob(): Promise<void> {
  console.log('[Cron] Starting nonce cleanup...');
  
  try {
    const deletedCount = await cleanupExpiredNonces();
    console.log(`[Cron] Cleaned up ${deletedCount} expired nonces`);
  } catch (error) {
    console.error('[Cron] Nonce cleanup failed:', error);
  }
}

// Vercel Cron 配置示例 (vercel.json):
// {
//   "crons": [
//     {
//       "path": "/api/cron/cleanup-nonces",
//       "schedule": "*/5 * * * *"
//     }
//   ]
// }
```

### 5.2 Cron API 路由

`src/app/api/cron/cleanup-nonces/route.ts`

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { cleanupNoncesJob } from '@/cron/cleanup-nonces';

export async function GET(request: NextRequest) {
  // 验证 Cron 密钥（Vercel Cron 会自动添加此 header）
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  await cleanupNoncesJob();
  
  return NextResponse.json({ success: true });
}
```

---

## 6. 多版本共存

### 6.1 版本生命周期

```
┌─────────────────────────────────────────────────────────────────────┐
│                        版本状态流转图                                │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌────────┐    提交审批    ┌──────────────────┐                    │
│  │ DRAFT  │ ─────────────→ │ PENDING_APPROVAL │                    │
│  └────────┘                └──────────────────┘                    │
│      ↑                            │                                 │
│      │                    ┌───────┴───────┐                         │
│      │                    ↓               ↓                         │
│      │               ┌──────────┐    ┌──────────┐                  │
│      └───────────────│ REJECTED │    │ APPROVED │ ←── 可执行       │
│         拒绝后修改    └──────────┘    └──────────┘                  │
│                                           │                         │
│                                    ┌──────┴──────┐                  │
│                                    ↓             ↓                  │
│                             ┌────────────┐  ┌──────────┐           │
│                             │ DEPRECATED │  │ ARCHIVED │           │
│                             └────────────┘  └──────────┘           │
│                              可执行(警告)     不可执行              │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 6.2 版本管理服务

`src/services/policy/version-manager.ts`

```typescript
import { prisma } from '@/lib/prisma';
import { computeChainedHash } from '../security/policy-security';
import { logSecurityEvent } from '../security/security-event-service';
import type { PolicyVersionStatus } from '@prisma/client';

/**
 * 创建新版本
 */
export async function createVersion(params: {
  policyId: string;
  source: string;
  createdBy: string;
  releaseNote?: string;
}): Promise<{ version: number; sourceHash: string }> {
  const { policyId, source, createdBy, releaseNote } = params;

  // 获取最新版本号和哈希
  const latestVersion = await prisma.policyVersion.findFirst({
    where: { policyId },
    orderBy: { version: 'desc' },
    select: { version: true, sourceHash: true },
  });

  const newVersionNumber = (latestVersion?.version ?? 0) + 1;
  const prevHash = latestVersion?.sourceHash ?? null;
  const sourceHash = computeChainedHash(source, prevHash);

  await prisma.policyVersion.create({
    data: {
      policyId,
      version: newVersionNumber,
      source,
      sourceHash,
      prevHash,
      createdBy,
      releaseNote,
      status: 'DRAFT',
    },
  });

  await logSecurityEvent({
    eventType: 'VERSION_CREATED',
    severity: 'INFO',
    policyId,
    userId: createdBy,
    details: { version: newVersionNumber, sourceHash },
  });

  return { version: newVersionNumber, sourceHash };
}

/**
 * 设置默认执行版本（原子操作）
 */
export async function setDefaultVersion(params: {
  policyId: string;
  version: number;
  userId: string;
}): Promise<void> {
  const { policyId, version, userId } = params;

  // 验证目标版本存在且已批准
  const targetVersion = await prisma.policyVersion.findFirst({
    where: {
      policyId,
      version,
      status: 'APPROVED',
    },
  });

  if (!targetVersion) {
    throw new Error(`版本 v${version} 不存在或未批准，无法设为默认`);
  }

  // 原子操作：清除旧默认 + 设置新默认
  await prisma.$transaction([
    prisma.policyVersion.updateMany({
      where: { policyId, isDefault: true },
      data: { isDefault: false },
    }),
    prisma.policyVersion.update({
      where: { id: targetVersion.id },
      data: { isDefault: true },
    }),
  ]);

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
 */
export async function deprecateVersion(params: {
  policyId: string;
  version: number;
  userId: string;
  reason?: string;
}): Promise<void> {
  const { policyId, version, userId, reason } = params;

  const targetVersion = await prisma.policyVersion.findFirst({
    where: {
      policyId,
      version,
      status: 'APPROVED',
    },
  });

  if (!targetVersion) {
    throw new Error(`版本 v${version} 不存在或未批准，无法废弃`);
  }

  // 如果是默认版本，不允许废弃
  if (targetVersion.isDefault) {
    throw new Error(`版本 v${version} 是默认版本，请先设置其他版本为默认`);
  }

  await prisma.policyVersion.update({
    where: { id: targetVersion.id },
    data: {
      status: 'DEPRECATED',
      deprecatedAt: new Date(),
      deprecatedBy: userId,
    },
  });

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
 */
export async function archiveVersion(params: {
  policyId: string;
  version: number;
  userId: string;
  reason?: string;
}): Promise<void> {
  const { policyId, version, userId, reason } = params;

  const targetVersion = await prisma.policyVersion.findFirst({
    where: {
      policyId,
      version,
      status: { in: ['APPROVED', 'DEPRECATED'] },
    },
  });

  if (!targetVersion) {
    throw new Error(`版本 v${version} 不存在或状态不允许归档`);
  }

  // 如果是默认版本，不允许归档
  if (targetVersion.isDefault) {
    throw new Error(`版本 v${version} 是默认版本，请先设置其他版本为默认`);
  }

  await prisma.policyVersion.update({
    where: { id: targetVersion.id },
    data: {
      status: 'ARCHIVED',
      archivedAt: new Date(),
      archivedBy: userId,
    },
  });

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
 */
export async function listVersions(policyId: string) {
  return prisma.policyVersion.findMany({
    where: { policyId },
    orderBy: { version: 'desc' },
    select: {
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
      _count: { select: { approvals: true } },
    },
  });
}

/**
 * 获取可执行版本列表
 */
export async function listExecutableVersions(policyId: string) {
  return prisma.policyVersion.findMany({
    where: {
      policyId,
      status: { in: ['APPROVED', 'DEPRECATED'] },
    },
    orderBy: { version: 'desc' },
    select: {
      version: true,
      sourceHash: true,
      status: true,
      isDefault: true,
      releaseNote: true,
      deprecatedAt: true,
    },
  });
}
```

### 6.3 版本管理 API

`src/app/api/v1/policies/[id]/versions/route.ts`

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { createVersion, listVersions } from '@/services/policy/version-manager';

// GET /api/v1/policies/{id}/versions - 获取版本列表
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: '未授权' }, { status: 401 });
  }

  const versions = await listVersions(params.id);
  return NextResponse.json({ versions });
}

// POST /api/v1/policies/{id}/versions - 创建新版本
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: '未授权' }, { status: 401 });
  }

  const body = await request.json();
  const { source, releaseNote } = body;

  if (!source) {
    return NextResponse.json({ error: '缺少 source 字段' }, { status: 400 });
  }

  try {
    const result = await createVersion({
      policyId: params.id,
      source,
      createdBy: session.user.id,
      releaseNote,
    });

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '创建版本失败' },
      { status: 500 }
    );
  }
}
```

`src/app/api/v1/policies/[id]/versions/[version]/set-default/route.ts`

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { setDefaultVersion } from '@/services/policy/version-manager';

// POST /api/v1/policies/{id}/versions/{version}/set-default
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string; version: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: '未授权' }, { status: 401 });
  }

  const version = parseInt(params.version, 10);
  if (isNaN(version)) {
    return NextResponse.json({ error: '无效的版本号' }, { status: 400 });
  }

  try {
    await setDefaultVersion({
      policyId: params.id,
      version,
      userId: session.user.id,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '设置默认版本失败' },
      { status: 400 }
    );
  }
}
```

`src/app/api/v1/policies/[id]/versions/[version]/deprecate/route.ts`

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { deprecateVersion } from '@/services/policy/version-manager';

// POST /api/v1/policies/{id}/versions/{version}/deprecate
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string; version: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: '未授权' }, { status: 401 });
  }

  const version = parseInt(params.version, 10);
  if (isNaN(version)) {
    return NextResponse.json({ error: '无效的版本号' }, { status: 400 });
  }

  const body = await request.json().catch(() => ({}));

  try {
    await deprecateVersion({
      policyId: params.id,
      version,
      userId: session.user.id,
      reason: body.reason,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '废弃版本失败' },
      { status: 400 }
    );
  }
}
```

`src/app/api/v1/policies/[id]/versions/[version]/archive/route.ts`

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { archiveVersion } from '@/services/policy/version-manager';

// POST /api/v1/policies/{id}/versions/{version}/archive
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string; version: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: '未授权' }, { status: 401 });
  }

  const version = parseInt(params.version, 10);
  if (isNaN(version)) {
    return NextResponse.json({ error: '无效的版本号' }, { status: 400 });
  }

  const body = await request.json().catch(() => ({}));

  try {
    await archiveVersion({
      policyId: params.id,
      version,
      userId: session.user.id,
      reason: body.reason,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '归档版本失败' },
      { status: 400 }
    );
  }
}
```

### 6.4 前端版本选择 Hook

`src/hooks/usePolicyVersions.ts`

```typescript
import { useState, useEffect, useCallback } from 'react';

interface PolicyVersion {
  version: number;
  sourceHash: string;
  status: 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'DEPRECATED' | 'ARCHIVED';
  isDefault: boolean;
  releaseNote?: string;
  deprecatedAt?: string;
}

interface UsePolicyVersionsResult {
  versions: PolicyVersion[];
  executableVersions: PolicyVersion[];
  defaultVersion?: PolicyVersion;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  setDefault: (version: number) => Promise<void>;
  deprecate: (version: number, reason?: string) => Promise<void>;
  archive: (version: number, reason?: string) => Promise<void>;
}

export function usePolicyVersions(policyId: string): UsePolicyVersionsResult {
  const [versions, setVersions] = useState<PolicyVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchVersions = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch(`/api/v1/policies/${policyId}/versions`);
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || '获取版本列表失败');
      }

      setVersions(data.versions);
    } catch (err) {
      setError(err instanceof Error ? err.message : '未知错误');
    } finally {
      setLoading(false);
    }
  }, [policyId]);

  useEffect(() => {
    fetchVersions();
  }, [fetchVersions]);

  const setDefault = useCallback(async (version: number) => {
    const response = await fetch(
      `/api/v1/policies/${policyId}/versions/${version}/set-default`,
      { method: 'POST' }
    );

    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || '设置默认版本失败');
    }

    await fetchVersions();
  }, [policyId, fetchVersions]);

  const deprecate = useCallback(async (version: number, reason?: string) => {
    const response = await fetch(
      `/api/v1/policies/${policyId}/versions/${version}/deprecate`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      }
    );

    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || '废弃版本失败');
    }

    await fetchVersions();
  }, [policyId, fetchVersions]);

  const archive = useCallback(async (version: number, reason?: string) => {
    const response = await fetch(
      `/api/v1/policies/${policyId}/versions/${version}/archive`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      }
    );

    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || '归档版本失败');
    }

    await fetchVersions();
  }, [policyId, fetchVersions]);

  const executableVersions = versions.filter(
    v => v.status === 'APPROVED' || v.status === 'DEPRECATED'
  );

  const defaultVersion = versions.find(v => v.isDefault);

  return {
    versions,
    executableVersions,
    defaultVersion,
    loading,
    error,
    refresh: fetchVersions,
    setDefault,
    deprecate,
    archive,
  };
}
```

### 6.5 使用场景示例

```typescript
// 场景 1：执行默认版本（最常见）
const { execute } = useSecurePolicyExecute();
await execute({
  policyId: 'policy-123',
  source: currentSource,
  input: { applicant: { age: 25 } },
  // 不传 version，自动使用 isDefault=true 或最新批准版本
});

// 场景 2：执行指定版本（A/B 测试、灰度发布）
await execute({
  policyId: 'policy-123',
  source: v2Source,
  input: { applicant: { age: 25 } },
  version: 2,  // 指定执行 v2
});

// 场景 3：紧急回滚
const { setDefault } = usePolicyVersions('policy-123');
await setDefault(2);  // 将 v2 设为默认版本，无需重新审批

// 场景 4：废弃旧版本
const { deprecate } = usePolicyVersions('policy-123');
await deprecate(2, '已被 v5 替代');  // v2 仍可执行，但会有警告

// 场景 5：彻底下线
const { archive } = usePolicyVersions('policy-123');
await archive(1, '不再支持');  // v1 不可执行
```

---

## 环境变量配置

`.env.local` 中添加：

```bash
# 策略签名密钥（至少 32 字符的随机字符串）
POLICY_SIGNING_SECRET="your-secure-random-string-at-least-32-chars"

# Cron 任务密钥
CRON_SECRET="your-cron-secret"
```

---

## 下一步

1. 运行 `npx prisma migrate dev --name add-security-schema` 应用数据库迁移
2. 实现版本管理 API (`/api/v1/policies/[id]/versions`) ✅ 已在本文档中提供
3. 实现审批工作流 API（四眼原则）
4. 添加版本管理 UI 组件
5. 配置监控告警（废弃版本执行次数、归档尝试等）
