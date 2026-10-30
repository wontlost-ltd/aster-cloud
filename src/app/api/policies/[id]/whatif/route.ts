/**
 * What-if 影响估算（Phase 4）：GET /api/policies/:id/whatif
 *
 * <p><b>★当前状态：结构性不可用，一律返回 409 REPLAY_REQUIRED。</b>
 *
 * <p>本端点原本要回答「把这条策略换成另一个版本，业务指标会怎样」，做法是把
 * **同一批历史执行**在两个版本下的决策逐条对齐，再乘以历史 outcome 分布。
 *
 * <p>但当前数据模型下这个对齐**在合法数据上不可能成立**：
 *
 * <ul>
 *   <li>{@code Execution.id} 是主键，{@code policyVersion} 是普通列 ——
 *       一行只属于一个版本</li>
 *   <li>故同一个 executionId 不可能同时出现在 base 与 target 两个版本的查询结果里，
 *       交集**恒为空**</li>
 * </ul>
 *
 * <p>这不是「生产上大概率没有重叠」，而是**结构上不可能有重叠**。若照常计算，
 * 估算会输出 changed=0 / delta=0 —— 自信地宣称「改这个版本毫无影响」。
 * 那比报错糟得多：它看起来是个结论。
 *
 * <p><b>为什么是 409 而不是 200 + comparable:false</b>：后者把一个**永久**
 * 不可用的能力包装成一次成功的分析响应，只看状态码的调用方会当成有结论。
 * 等真正存在「可比」与「不可比」两种合法结果时，再改成有文档的
 * discriminated union 才有意义。
 *
 * <p><b>解锁条件</b>（均为独立工程，都未落地）：
 * <ul>
 *   <li><b>真回放（M2）</b>：新增 replay artifact，按
 *       {@code (sourceExecutionId, targetPolicyVersionRowId)} 对齐，
 *       而不是复用 {@code Execution.id}</li>
 *   <li><b>影子执行</b>：同一请求的主/影决策共享 correlation id</li>
 *   <li><b>A/B 分流</b>：逐条对齐本就不适用，应改比两个 cohort 的率与分布 ——
 *       那是另一种产品，需要另建 experiment/cohort 端点</li>
 * </ul>
 *
 * <p>纯函数 {@code estimateWhatIf} 保留在 {@code @/lib/analytics/whatif-estimate}，
 * 它本身逻辑正确且有测试覆盖；等上述任一能力落地后直接复用，无需重写。
 */
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth';
import { loadPolicyForAction } from '@/lib/policy-access';
import { errorEnvelope } from '@/lib/api/error-envelope';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await getSession();
  if (!session?.user?.id) {
    return errorEnvelope({ code: 'UNAUTHORIZED', message: 'Not authenticated.', status: 401 });
  }
  const { id } = await params;

  // ★仍然先做租户隔离校验再拒答：否则本端点会变成一个「策略是否存在」的探针 ——
  //   任何登录用户拿别人的 policyId 来打，都能从 409/404 的差异推断出存在性。
  //   授权口径同其他查看类入口：团队策略看当前成员角色，个人策略只认所有者。
  const access = await loadPolicyForAction(id, { userId: session.user.id }, 'view');
  if (!access.ok) {
    // 404 而非 403：不泄露「该 id 存在但不属于你」
    return errorEnvelope({ code: 'NOT_FOUND', message: 'Policy not found.', status: 404 });
  }

  return errorEnvelope({
    code: 'REPLAY_REQUIRED',
    message:
      '暂不支持跨版本 What-if 估算：一次执行只在一个版本下运行，两个版本之间没有可逐条对齐的记录。' +
      '需要先对同一批输入在目标版本上重放（回放能力尚未上线）。',
    status: 409,
  });
}
