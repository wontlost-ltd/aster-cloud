#!/usr/bin/env node

import process from 'node:process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const allowlisted = (file) => file === 'src/db/schema.ts'
  || file.startsWith('src/__tests__/')
  || file.startsWith('drizzle/meta/');

export function checkMigrationSplit({ files, labels, body }) {
  const hasMigration = files.some((file) => /^drizzle\/.*\.sql$/.test(file));
  const hasCode = files.some((file) => file.startsWith('src/') && !allowlisted(file));
  if (!hasMigration || !hasCode) return { ok: true };
  if (!labels.includes('migration-and-code')) return { ok: false, reason: 'split-required' };
  if (!body.includes('## 迁移窗口容错')) return { ok: false, reason: 'tolerance-section-missing' };
  return { ok: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = checkMigrationSplit({
    files: (process.env.PR_FILES ?? '').split('\n').filter(Boolean),
    labels: (process.env.PR_LABELS ?? '').split(',').map((label) => label.trim()).filter(Boolean),
    body: process.env.PR_BODY ?? '',
  });
  if (!result.ok) {
    console.error(`::error::${result.reason === 'split-required' ? '迁移与业务代码需拆分 PR 或添加 migration-and-code 标签' : '缺少 ## 迁移窗口容错 小节'}`);
    process.exit(1);
  }
}
