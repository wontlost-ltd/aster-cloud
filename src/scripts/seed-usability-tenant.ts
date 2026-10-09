/**
 * F5 用研租户播种脚本
 *
 * 创建：
 *   - 1 个 Team：ut2026w3（slug=ut2026w3, owner=ut-pilot）
 *   - 6 个 User：ut-p1 / ut-p2 / ut-p3 / ut-p4 / ut-p5 / ut-pilot
 *     plan='pro'（用研覆盖审批流场景，详见 04-usability-test-plan.md 任务 3）
 *   - 6 条 TeamMember 记录
 *   - 3 条模板 Policy：blank / half / complete（贷款规则）
 *
 * 幂等：所有 upsert by id；多次运行不会重复创建
 *
 * 环境变量：
 *   DATABASE_URL          必须
 *   UT_SEED_PASSWORD      可选（默认 Aster2026!）
 *
 * 用法：pnpm seed:usability
 */

import 'dotenv/config';
import bcrypt from 'bcryptjs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import * as schema from '@/db/schema';

type Db = ReturnType<typeof drizzle<typeof schema>>;

const TENANT_ID = 'ut2026w3';
const TENANT_NAME = 'Usability Test 2026 W3';
const OWNER_ID = 'ut-pilot';
const ACCOUNT_IDS = ['ut-p1', 'ut-p2', 'ut-p3', 'ut-p4', 'ut-p5', 'ut-pilot'] as const;

interface TemplateSpec {
  id: string;
  name: string;
  description: string;
  content: string;
}

const TEMPLATES: TemplateSpec[] = [
  {
    id: 'tpl-blank-loan',
    name: '空白贷款模板',
    description: '仅含模块声明的最小起点（任务 1 用）',
    content: '模块 aster.finance.loan。\n',
  },
  {
    id: 'tpl-half-loan',
    name: '半成品贷款模板',
    description: '含违约判断与默认通过，缺负债、金额与分数分支',
    content: `模块 aster.finance.loan。

定义 Applicant 包含
  creditScore 作为 整数，
  monthlyIncome 作为 Decimal，
  monthlyDebt 作为 Decimal，
  requestedAmount 作为 Decimal，
  activeDefaults 作为 整数。

规则 evaluateLoanEligibility 给定 applicant 作为 Applicant 产出 Verdict：
  如果 applicant.activeDefaults 至少 1：
    返回 Verdict.deny("active_default")。
  返回 Verdict.allow()。
`,
  },
  {
    id: 'tpl-complete-loan',
    name: '完整贷款模板',
    description: 'Verdict 四态完整版（任务 3 修改基线）',
    content: `模块 aster.finance.loan。

定义 Applicant 包含
  creditScore 作为 整数，
  monthlyIncome 作为 Decimal，
  monthlyDebt 作为 Decimal，
  requestedAmount 作为 Decimal，
  activeDefaults 作为 整数。

规则 evaluateLoanEligibility 给定 applicant 作为 Applicant 产出 Verdict：
  如果 applicant.activeDefaults 至少 1：
    返回 Verdict.deny("active_default")。
  如果 applicant.monthlyDebt 大于 applicant.monthlyIncome 乘以 0.45m：
    返回 Verdict.deny("dti_exceeds_limit")。
  如果 applicant.requestedAmount 至少 50000m：
    返回 Verdict.require_approval("Credit Officer", "large_exposure")。
  如果 applicant.creditScore 至少 620 并且 applicant.creditScore 至多 679：
    返回 Verdict.escalate("borderline_credit_score")。
  返回 Verdict.allow()。
`,
  },
];

async function upsertUser(db: Db, id: string, passwordHash: string): Promise<void> {
  const existing = await db.query.users.findFirst({ where: eq(schema.users.id, id) });
  const baseValues = {
    name: id,
    email: `${id}@aster-internal.test`,
    passwordHash,
    plan: 'pro' as const,
    priceLockedAt: new Date(),
    legacyTier: null,
    updatedAt: new Date(),
  };
  if (existing) {
    await db.update(schema.users).set(baseValues).where(eq(schema.users.id, id));
  } else {
    await db.insert(schema.users).values({
      id,
      ...baseValues,
      emailVerified: new Date(),
      failedLoginAttempts: 0,
      lockoutCount: 0,
      createdAt: new Date(),
    });
  }
}

async function upsertTeam(db: Db): Promise<void> {
  const existing = await db.query.teams.findFirst({ where: eq(schema.teams.id, TENANT_ID) });
  const values = {
    name: TENANT_NAME,
    slug: TENANT_ID,
    ownerId: OWNER_ID,
    updatedAt: new Date(),
  };
  if (existing) {
    await db.update(schema.teams).set(values).where(eq(schema.teams.id, TENANT_ID));
  } else {
    await db.insert(schema.teams).values({
      id: TENANT_ID,
      ...values,
      createdAt: new Date(),
    });
  }
}

async function upsertTeamMember(db: Db, userId: string): Promise<void> {
  const memberId = `${TENANT_ID}-${userId}`;
  const existing = await db.query.teamMembers.findFirst({
    where: eq(schema.teamMembers.id, memberId),
  });
  if (existing) return;
  await db.insert(schema.teamMembers).values({
    id: memberId,
    teamId: TENANT_ID,
    userId,
    role: userId === OWNER_ID ? 'owner' : 'member',
    createdAt: new Date(),
  });
}

async function upsertTemplate(db: Db, tpl: TemplateSpec): Promise<void> {
  const existing = await db.query.policies.findFirst({
    where: eq(schema.policies.id, tpl.id),
  });
  const values = {
    userId: OWNER_ID,
    teamId: TENANT_ID,
    name: tpl.name,
    description: tpl.description,
    content: tpl.content,
    isPublic: false,
    updatedAt: new Date(),
  };
  if (existing) {
    await db.update(schema.policies).set(values).where(eq(schema.policies.id, tpl.id));
  } else {
    await db.insert(schema.policies).values({
      id: tpl.id,
      ...values,
      version: 1,
      createdAt: new Date(),
    });
  }
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }

  const password = process.env.UT_SEED_PASSWORD ?? 'Aster2026!';
  const passwordHash = await bcrypt.hash(password, 12);

  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  const db = drizzle(sql, { schema });

  console.log('[seed-usability] 创建 Team', TENANT_ID);
  await upsertTeam(db);

  console.log('[seed-usability] 创建', ACCOUNT_IDS.length, '个用户 (plan=pro)');
  for (const id of ACCOUNT_IDS) {
    await upsertUser(db, id, passwordHash);
    await upsertTeamMember(db, id);
  }

  console.log('[seed-usability] 创建', TEMPLATES.length, '个模板策略');
  for (const tpl of TEMPLATES) {
    await upsertTemplate(db, tpl);
  }

  await sql.end();
  console.log('[seed-usability] 完成');
  console.log(`  访问 staging.aster-lang.cloud`);
  console.log(`  账号 ${ACCOUNT_IDS.join(' / ')}@aster-internal.test`);
  console.log(`  密码 ${password}`);
}

main().catch((err) => {
  console.error('[seed-usability] 失败', err);
  process.exit(1);
});
