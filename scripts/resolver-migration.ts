/**
 * 存量重编译管理脚本（ADR 0051 §9，cloud "PolicyVersion"）。逻辑见 src/services/policy/resolver-migration.ts：
 * 逐行事务、主键升序每批 50、编译经 aster-api 签名接口（带版本词汇），可随时中断与重跑。
 * 由发布 Job 在 aster-api 迁移端点之后调用，须在 rollout 窗口内执行（迁移 0061 先于代码上线）。
 * 用法、环境变量、退出码与已知限制见下方 USAGE（`--help` 打印）。
 */
import 'dotenv/config';
import { writeFile } from 'node:fs/promises';
import { getDb } from '@/lib/prisma';
import {
  RESOLVER_MIGRATION_BATCH_SIZE,
  RESOLVER_MIGRATION_CACHE_URL_ENV,
  RESOLVER_MIGRATION_REQUIRED_ENV,
  missingResolverMigrationEnv,
  runResolverMigration,
} from '@/services/policy/resolver-migration';

const USAGE = `resolver migration (ADR 0051 §9, cloud "PolicyVersion")

Usage:
  pnpm ops:resolver-migration [--batch-size 50] [--policy-prefix <policyId prefix>] [--report <file>]
  (= node --conditions=import --import tsx scripts/resolver-migration.ts …; the engine's ./browser export
   only declares the "import" condition, so plain \`tsx\` cannot resolve it)

Required environment (no fallback — the tool refuses to run without them):
  DATABASE_URL                     cloud database
  ${RESOLVER_MIGRATION_REQUIRED_ENV.join(', ')}
                                   aster-api internal URL and internal signing key; never defaults to production

Optional environment:
  ${RESOLVER_MIGRATION_CACHE_URL_ENV}         aster-cloud base URL reachable from the job; each migrated policy's
                                   execution cache (Workers KV) is invalidated through
                                   POST /api/internal/policies/<id>/invalidate-cache (signed with the key above).
                                   Without it the job cannot reach Workers KV: cached entries expire within 1 hour.

Output: full JSON report on stdout (processed/succeeded/failed/failures/triage); --report also writes it to a file.
Exit codes: 0 = every row has a verdict; 1 = some rows hit infrastructure failures and stay pending (re-run);
            2 = configuration or script error.

Known limits:
  - Success means "recompiled through aster-api with the version's vocabulary and resealed"; cloud stores no Core IR.
  - The cloud row has no locale column: the old seal is checked by guessing the locale from the supported candidates.
    A row saved with any other locale is reported under triage.integrityMismatch (left untouched for manual review).
  - triage.invalidConstructForm (\`X mit f = v\`, aster-lang-ts#244) is a heuristic: P005 plus a regex on the source;
    other P005 failures are listed under triage.otherCompile.
  - Only upstream rejections that carry source-error diagnostics archive a row. 401/403/404/413 and other 4xx without
    diagnostics (or with only COMPILE_INTERNAL_ERROR), 5xx and transport errors are infrastructure failures: nothing
    is changed, re-run after fixing config.

Runbook:
  - Before running, pg_dump "PolicyVersion" and "UserVocabularySnapshot" (ADR 0051 §9 rollback point).
  - Each row lock is held while aster-api compiles (up to the 30s client timeout); a concurrent save on that
    policy's tail version waits for it. Run inside the release window.
  - Relinking rewrites successors' prevHash/sourceHash; a pinned old sourceHash no longer matches (HASH_MISMATCH) and must be refreshed.
`;

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<number> {
  if (process.argv.includes('--help')) {
    console.log(USAGE);
    return 0;
  }
  const missing = missingResolverMigrationEnv(process.env);
  if (missing.length > 0) {
    console.error(`[resolver-migration] refusing to run: missing ${missing.join(', ')} (no fallback to production)`);
    return 2;
  }
  if (!process.env[RESOLVER_MIGRATION_CACHE_URL_ENV]?.trim()) {
    console.error(
      `[resolver-migration] warning: ${RESOLVER_MIGRATION_CACHE_URL_ENV} not set; Workers KV execution cache ` +
        'is not invalidated and may serve migrated/archived versions for up to 1 hour',
    );
  }
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
  await getDb().$client.end({ timeout: 5 });
  return report.triage.infrastructure.length > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[resolver-migration] FAILED:', err);
    process.exit(2);
  });
