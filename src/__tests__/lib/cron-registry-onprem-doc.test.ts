// on-prem 没有 Workers scheduler，cron-registry 里的每个任务都要由运维按部署指南建 CronJob（#625）。
// 指南漏列的任务在 on-prem 永远不会执行（如异步批量导入停在 queued、回收站从不清理），
// 故这里要求指南的 cron 清单与 CRON_REGISTRY 逐项一致。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { CRON_REGISTRY } from '@/lib/cron-registry';

const guide = readFileSync(resolve(process.cwd(), 'docs/on-prem/enterprise-deployment-guide.md'), 'utf8');

/** 指南 cron 清单表格中的行：| `<cron>` | `<route>` | … */
function listedCrons(): Map<string, string> {
  const rows = [...guide.matchAll(/^\|\s*`([^`]+)`\s*\|\s*`(\/api\/cron\/[^`]+)`\s*\|/gm)];
  return new Map(rows.map((m) => [m[2]!, m[1]!]));
}

describe('on-prem 部署指南的 cron 清单 ↔ CRON_REGISTRY（#625）', () => {
  it('每个已登记的 cron 都在指南里列出，且调度表达式一致', () => {
    const listed = listedCrons();
    for (const job of CRON_REGISTRY) {
      expect(listed.get(job.routePath), `指南缺少 ${job.routePath}`).toBe(job.cron);
    }
  });

  it('指南不列未登记的 cron', () => {
    const registered = new Set(CRON_REGISTRY.map((c) => c.routePath));
    for (const route of listedCrons().keys()) {
      expect(registered.has(route), `${route} 不在 CRON_REGISTRY`).toBe(true);
    }
  });
});
