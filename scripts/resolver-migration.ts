/**
 * 存量重编译管理脚本（ADR 0051 §9，cloud "PolicyVersion"）。逻辑见 src/services/policy/resolver-migration.ts：
 * 逐行事务、主键升序每批 50、编译经 aster-api 签名接口（带版本词汇），可随时中断与重跑。
 *
 * 由发布 Job 在 aster-api 迁移端点之后调用，须在 rollout 窗口内执行（迁移 0061 先于代码上线）。
 * 环境变量与 cloud 服务相同：DATABASE_URL、ASTER_POLICY_API_INTERNAL_URL（未设置时客户端回落到生产地址，
 * 本地运行务必显式指定）及内部签名密钥 ASTER_PLAN_GATE_HMAC_KEY / ASTER_HMAC_SECRET。
 *
 * 调用（引擎 browser 入口只声明 import 条件，故以 --conditions=import 运行）：
 *   pnpm ops:resolver-migration [--batch-size 50] [--policy-prefix <id 前缀>] [--report <文件>]
 *
 * 输出：stdout 打印完整报告 JSON（processed/succeeded/failed/failures/triage）；--report 另写一份到文件。
 * 退出码：0 = 全部行已有结论（成功、设计内归档或完整性不符待人工）；1 = 有基础设施故障行保持待迁移，需重跑；
 * 2 = 脚本自身出错。
 */
import 'dotenv/config';
import { writeFile } from 'node:fs/promises';
import { getDb } from '@/lib/prisma';
import { RESOLVER_MIGRATION_BATCH_SIZE, runResolverMigration } from '@/services/policy/resolver-migration';

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<number> {
  const batchSize = Number(argValue('--batch-size') ?? RESOLVER_MIGRATION_BATCH_SIZE);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) {
    console.error('--batch-size must be an integer in 1..500');
    return 2;
  }
  const report = await runResolverMigration({ batchSize, policyIdPrefix: argValue('--policy-prefix') });
  const json = JSON.stringify(report, null, 2);
  console.log(json);
  const reportPath = argValue('--report');
  if (reportPath) await writeFile(reportPath, `${json}\n`, 'utf8');
  console.error(
    `[resolver-migration] processed=${report.processed} succeeded=${report.succeeded} failed=${report.failed} ` +
      `integrity=${report.triage.integrityMismatch.length} infrastructure=${report.triage.infrastructure.length}`,
  );
  return report.triage.infrastructure.length > 0 ? 1 : 0;
}

main()
  .then(async (code) => {
    await getDb().$client.end({ timeout: 5 });
    process.exit(code);
  })
  .catch((err) => {
    console.error('[resolver-migration] FAILED:', err);
    process.exit(2);
  });
