/**
 * 回填 Guard 策略部署（aster-api ADR 0054 §11 D1）：上线后对每个未删除、有已批准默认版本但从未部署的策略部署一次。
 * 实际工作在应用运行时内的 cron 路由完成（`/api/cron/guard-deploy-sync?backfill=…`，cron 鉴权），本脚本只负责调用与打印。
 *
 *   GUARD_BACKFILL_BASE_URL=https://cloud.example CRON_SECRET=… pnpm guard:backfill           # dry-run：只列出
 *   GUARD_BACKFILL_BASE_URL=https://cloud.example CRON_SECRET=… pnpm guard:backfill --apply   # 实际部署
 */
interface BackfillRow {
  policyId: string;
  versionId: string;
  result: 'dry-run' | { ok: boolean; status?: number; error?: string };
}

async function main(): Promise<void> {
  const base = process.env.GUARD_BACKFILL_BASE_URL;
  if (!base) throw new Error('缺少 GUARD_BACKFILL_BASE_URL（aster-cloud 根地址）');
  const mode = process.argv.includes('--apply') ? 'apply' : 'dry-run';
  const res = await fetch(`${base.replace(/\/+$/, '')}/api/cron/guard-deploy-sync?backfill=${mode}`, {
    method: 'POST',
    headers: process.env.CRON_SECRET ? { Authorization: `Bearer ${process.env.CRON_SECRET}` } : {},
  });
  const body = (await res.json()) as { ok: boolean; failed: number; results: BackfillRow[] };
  if (!res.ok && !Array.isArray(body.results)) throw new Error(`HTTP ${res.status}: ${JSON.stringify(body)}`);
  for (const r of body.results) {
    const outcome = r.result === 'dry-run' ? 'dry-run' : r.result.ok ? 'ok' : `failed ${r.result.status} ${r.result.error}`;
    console.log(`${r.policyId}\t${r.versionId}\t${outcome}`);
  }
  console.log(`${mode === 'apply' ? '已处理' : '待部署（dry-run）'} ${body.results.length} 条，失败 ${body.failed} 条`);
  process.exitCode = body.failed > 0 ? 1 : 0;
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
