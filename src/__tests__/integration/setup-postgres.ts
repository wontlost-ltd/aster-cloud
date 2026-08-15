// Integration Postgres fixture（testcontainers）。
//
// 设计意图：
//   - 优先使用外部 DATABASE_URL（CI / 开发者本地）
//   - 未设置时启动一次性 Postgres 16-alpine 容器
//   - drizzle migrate 应用所有迁移
//   - cleanupTestDb 在测试间 TRUNCATE 关键表

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import * as schema from '@/db/schema';

let container: StartedTestContainer | null = null;
let sqlClient: ReturnType<typeof postgres> | null = null;

export async function setupTestDb(): Promise<string> {
  if (!process.env.DATABASE_URL) {
    container = await new GenericContainer('postgres:16-alpine')
      .withEnvironment({
        POSTGRES_DB: 'aster_cloud_test',
        POSTGRES_USER: 'aster',
        POSTGRES_PASSWORD: 'aster',
      })
      .withExposedPorts(5432)
      .start();
    process.env.DATABASE_URL = `postgres://aster:aster@${container.getHost()}:${container.getMappedPort(5432)}/aster_cloud_test`;
  }

  sqlClient = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  // Skip migration if DATABASE_URL is set externally — caller (CI / dev) is
  // responsible for applying schema. testcontainers self-managed flow falls
  // through to migrate() below.
  if (!container) {
    // 外部 DB：假定 schema 已就绪（pnpm db:push 或 migrate 已跑过）
    return process.env.DATABASE_URL;
  }
  const db = drizzle(sqlClient, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  return process.env.DATABASE_URL;
}

export async function cleanupTestDb(): Promise<void> {
  if (!sqlClient) return;
  const t = Date.now();
  // 加 timeout 防止 hang
  await Promise.race([
    sqlClient`
      TRUNCATE TABLE
        "LicenseCache",
        "RevokedLicense",
        "RevocationPublication",
        "RenewalToken",
        "IssuedLicense",
        "LicenseTelemetry",
        "TelemetryAccessAudit",
        "CronJobLease",
        -- 登录二次验证（issue #400）。★必须列在这里：两个套件都写这两张表，
        -- 不清理会跨文件泄漏行——实测表现为「单跑 14/14 绿、与可信设备套件
        -- 同跑就有 1 条红」这种看起来像 flaky、实为污染的现象。
        "TwoFactorCode",
        "TrustedDevice",
        -- Strategy Replay（Phase 1/3/4）。CASCADE 已处理外键依赖，
        -- 这里按 ExecutionOutcome → Execution → Policy 顺序列出便于阅读。
        "ExecutionOutcome",
        "Execution",
        "Policy"
      RESTART IDENTITY CASCADE
    `,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('cleanup TRUNCATE timeout 5s')), 5000),
    ),
  ]);
  console.log(`[cleanup] TRUNCATE in ${Date.now() - t}ms`);
}

export async function teardownTestDb(): Promise<void> {
  await sqlClient?.end({ timeout: 5 });
  sqlClient = null;
  await container?.stop();
  container = null;
}
