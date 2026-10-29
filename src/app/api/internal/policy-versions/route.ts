/**
 * 内部端点：按 versionId 取策略版本的**源码**。
 *
 * <h2>为什么需要它</h2>
 *
 * What-If 重放要拿「目标版本的源码」去重跑历史执行。此前 aster-api 在**自己库里**
 * 找（`aster_api.policy_versions`），但那张表是**执行期编译缓存**，与本库的
 * `PolicyVersion`（用户可见的版本历史）**不是同一批数据**：
 *   - 本库 id 是 UUID（text），api 库 id 是 bigint 自增
 *   - api 库的 `policy_id` 里混着 `aster.test.failure...tenant-batch-partial`
 *     这类缓存键，不都是策略 UUID
 *   - 实测行数 57 vs 54，本就不是镜像关系
 *
 * 结果：UI 传来的 UUID 在 api 库里 `Long.parseLong` 直接失败 → 每一次
 * What-If 都返回 TARGET_VERSION_MISSING。**该功能从 UI 上从未成功过。**
 *
 * 版本历史的**系统真相在本服务**，故由本服务提供源码，api 侧不再猜。
 *
 * <h2>安全</h2>
 *
 * 与 `/api/internal/executions/window` 同一套：fail-closed HMAC 验签
 * （`verifyInternalSignature`），并**强制 userId 参与查询条件**——
 * 即便调用方是可信内部服务，也不能"忘了传 userId 就拿到别人的策略源码"。
 * 策略源码属于用户资产，跨租户读取是本仓历史上出过的那类事故。
 *
 * <h2>编译输入</h2>
 *
 * 名称按位置解析依赖词汇（ADR 0051），重放必须与执行用同一份编译输入：响应附带 `vocabulary`
 * （已审批 / 已弃用 = 冻结快照，草稿 = 作者现行词汇，与执行同一口径）与版本冻结的 `aliasSet`。
 * 没有时省略该字段（aster-api 视为无词汇 / 无别名）。
 */

import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';

import { verifyInternalSignature } from '@/lib/internal-signature';
import { db, policyVersions, policies } from '@/lib/prisma';
import { loadStoredVersionCompileContext } from '@/lib/execution-input';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const sharedKey = process.env.ASTER_PLAN_GATE_HMAC_KEY;
  // Fail-closed：没有共享密钥就无法认证调用方，拒绝服务而非泄露数据。
  if (!sharedKey) {
    return NextResponse.json({ error: 'Internal verification unavailable' }, { status: 503 });
  }
  const verified = await verifyInternalSignature(req, '', sharedKey);
  if (!verified.ok) {
    return NextResponse.json({ error: verified.reason }, { status: 401 });
  }

  const url = new URL(req.url);
  const versionId = url.searchParams.get('versionId');
  const userId = url.searchParams.get('userId');

  if (!versionId || !userId) {
    return NextResponse.json(
      { error: 'versionId and userId are required' },
      { status: 400 },
    );
  }

  // ★join policies 并按 userId 过滤 = 租户隔离。
  //   只按 versionId 查会让任何知道（或猜中）UUID 的调用方读到他人源码。
  const rows = await db
    .select({
      id: policyVersions.id,
      policyId: policyVersions.policyId,
      version: policyVersions.version,
      content: policyVersions.content,
      status: policyVersions.status,
      createdBy: policyVersions.createdBy,
      aliasSet: policyVersions.aliasSet,
      vocabularySnapshotIds: policyVersions.vocabularySnapshotIds,
      sourceEnvelopeSha256: policyVersions.sourceEnvelopeSha256,
      sourceScopesJson: policyVersions.sourceScopesJson,
      sourceToolchainId: policyVersions.sourceToolchainId,
    })
    .from(policyVersions)
    .innerJoin(policies, eq(policies.id, policyVersions.policyId))
    .where(and(eq(policyVersions.id, versionId), eq(policies.userId, userId)))
    .limit(1);

  const row = rows[0];
  if (!row) {
    // ★查不到与"不属于你"合并成同一个 404：不区分二者，避免把
    //   "这个 UUID 存在但不是你的"变成一个可探测的存在性信号。
    return NextResponse.json({ error: 'version_not_found' }, { status: 404 });
  }

  const { vocabulary } = await loadStoredVersionCompileContext({
    source: row.content,
    status: row.status,
    createdBy: row.createdBy,
    aliasSet: row.aliasSet ?? null,
    vocabularySnapshotIds: row.vocabularySnapshotIds,
    sourceEnvelopeSha256: row.sourceEnvelopeSha256 ?? null,
    sourceScopesJson: row.sourceScopesJson ?? null,
    sourceToolchainId: row.sourceToolchainId ?? null,
  });
  const aliasSet = parseAliasSet(row.aliasSet);

  return NextResponse.json({
    versionId: row.id,
    policyId: row.policyId,
    version: row.version,
    content: row.content,
    ...(vocabulary ? { vocabulary } : {}),
    ...(aliasSet ? { aliasSet } : {}),
  });
}

/** 版本冻结的别名集（canonical JSON）；损坏视同无别名，与执行路径同一口径。 */
function parseAliasSet(aliasSet: string | null | undefined): Record<string, string[]> | null {
  if (!aliasSet) return null;
  try {
    return JSON.parse(aliasSet) as Record<string, string[]>;
  } catch {
    return null;
  }
}
