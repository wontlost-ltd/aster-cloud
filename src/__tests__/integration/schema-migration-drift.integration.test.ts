// #646 防回归：drizzle/*.sql 迁移链重放出的库必须与 schema.ts 声明一致。
//
// 为什么不够用 `pnpm db:generate` 的漂移检查：它只比 schema.ts 与 drizzle/meta 快照，而迁移 SQL 是手写的，
// 快照"有"的索引在 SQL 里可以从未建过（PolicyVersion 唯一索引就是这样在生产缺失的）。这里直接比两个真库：
//   A = 空库按 drizzle/ 迁移链 migrate；B = 空库执行 schema.ts 的全量建库 SQL（drizzle-kit generateMigration）。
// 逐项比对列（类型 / 非空 / 默认值）、索引定义、约束定义（唯一 / CHECK / 外键）、enum 取值顺序。
// 迁移链额外建的触发器 / 函数不在 schema.ts 表达范围内，不比对。
//
// Run: LICENSE_E2E=1 DATABASE_URL=<可建库的 Postgres> pnpm exec vitest run --config vitest.integration.config.ts schema-migration-drift

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import * as schema from '@/db/schema';

const CATALOG_SQL = `
SELECT 'COL|' || c.relname || '|' || a.attname || '|' || format_type(a.atttypid, a.atttypmod) || '|'
       || CASE WHEN a.attnotnull THEN 'NN' ELSE 'NULL' END || '|' || coalesce(pg_get_expr(d.adbin, d.adrelid), '') AS line
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
UNION ALL
SELECT 'IDX|' || tablename || '|' || indexname || '|' || indexdef FROM pg_indexes WHERE schemaname = 'public'
UNION ALL
SELECT 'CON|' || c.relname || '|' || co.conname || '|' || co.contype::text || '|' || pg_get_constraintdef(co.oid)
FROM pg_constraint co
JOIN pg_class c ON c.oid = co.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
UNION ALL
SELECT 'ENUM|' || t.typname || '|' || string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder)
FROM pg_type t
JOIN pg_enum e ON e.enumtypid = t.oid
JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname = 'public'
GROUP BY t.typname
UNION ALL
SELECT 'TBL|' || c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> '__drizzle_migrations'
`;

function databaseUrl(base: string, name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

async function catalog(url: string): Promise<string[]> {
  const client = postgres(url, { max: 1, prepare: false, onnotice: () => undefined });
  try {
    const rows = await client.unsafe<Array<{ line: string }>>(CATALOG_SQL);
    // pg_indexes / pg_get_constraintdef 会按 search_path 决定是否带 public. 前缀，统一去掉
    return rows.map((r) => r.line.replaceAll('public.', '')).sort();
  } finally {
    await client.end({ timeout: 5 });
  }
}

describe.skipIf(process.env.LICENSE_E2E !== '1')('迁移链与 schema.ts 一致（#646）', () => {
  const suffix = `${process.pid}_${Date.now()}`;
  const migratedDb = `drift_migrated_${suffix}`;
  const pushedDb = `drift_pushed_${suffix}`;
  let admin: ReturnType<typeof postgres>;

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error('DATABASE_URL 未设置：本测试需要可 CREATE DATABASE 的 Postgres');
    admin = postgres(base, { max: 1, prepare: false, onnotice: () => undefined });
    await admin.unsafe(`CREATE DATABASE "${migratedDb}"`);
    await admin.unsafe(`CREATE DATABASE "${pushedDb}"`);

    const migratedClient = postgres(databaseUrl(base, migratedDb), { max: 1, prepare: false, onnotice: () => undefined });
    try {
      await migrate(drizzle(migratedClient), { migrationsFolder: './drizzle' });
    } finally {
      await migratedClient.end({ timeout: 5 });
    }

    // 从空快照生成 schema.ts 的全量建库 SQL（与 drizzle-kit push 对空库所做相同，但不做交互式内省）
    const statements = await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema));
    const pushedClient = postgres(databaseUrl(base, pushedDb), { max: 1, prepare: false, onnotice: () => undefined });
    try {
      for (const statement of statements) await pushedClient.unsafe(statement);
    } finally {
      await pushedClient.end({ timeout: 5 });
    }
  }, 180_000);

  afterAll(async () => {
    if (!admin) return;
    await admin.unsafe(`DROP DATABASE IF EXISTS "${migratedDb}" WITH (FORCE)`);
    await admin.unsafe(`DROP DATABASE IF EXISTS "${pushedDb}" WITH (FORCE)`);
    await admin.end({ timeout: 5 });
  });

  it('列 / 索引 / 约束 / enum 逐项相同', async () => {
    const base = process.env.DATABASE_URL!;
    const [migrated, pushed] = await Promise.all([
      catalog(databaseUrl(base, migratedDb)),
      catalog(databaseUrl(base, pushedDb)),
    ]);
    const pushedSet = new Set(pushed);
    const migratedSet = new Set(migrated);
    // 分两侧列出差异，失败信息直接给出要补的迁移 / 要改的 schema.ts 项
    expect({
      missingFromMigrations: pushed.filter((l) => !migratedSet.has(l)),
      undeclaredInSchema: migrated.filter((l) => !pushedSet.has(l)),
    }).toEqual({ missingFromMigrations: [], undeclaredInSchema: [] });
    expect(migrated.length).toBeGreaterThan(500);
  });

  it('PolicyVersion 的 (policyId, version) 唯一索引由迁移链建出', async () => {
    const migrated = await catalog(databaseUrl(process.env.DATABASE_URL!, migratedDb));
    expect(migrated).toContain(
      'IDX|PolicyVersion|PolicyVersion_policyId_version_key|CREATE UNIQUE INDEX "PolicyVersion_policyId_version_key" ON "PolicyVersion" USING btree ("policyId", version)',
    );
  });
});
