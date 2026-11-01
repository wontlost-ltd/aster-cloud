/**
 * Drizzle 适配器 for NextAuth
 * 基于 @auth/drizzle-adapter 的实现，但直接使用我们的 schema
 *
 * 支持两种模式：
 * 1. 静态 db 实例（本地开发）
 * 2. 动态 db 获取函数（Cloudflare Workers，每次请求获取新连接）
 */
import { and, eq } from 'drizzle-orm';
import type { Adapter, AdapterAccount, AdapterSession, AdapterUser, VerificationToken } from 'next-auth/adapters';
import type { Database } from './index';
import { users, accounts, sessions, verificationTokens } from './schema';

// 支持传入 db 实例或获取 db 的函数
type DbOrGetter = Database | (() => Database);

function resolveDb(dbOrGetter: DbOrGetter): Database {
  return typeof dbOrGetter === 'function' ? dbOrGetter() : dbOrGetter;
}

export function DrizzleAdapter(dbOrGetter: DbOrGetter): Adapter {
  return {
    async createUser(data: Omit<AdapterUser, 'id'>) {
      const db = resolveDb(dbOrGetter);
      const id = crypto.randomUUID();
      const now = new Date();
      const { normalizeEmail } = await import('@/lib/email-normalize');
      const emailNormalized = data.email ? normalizeEmail(data.email) : null;

      // 抓取注册 IP hash（用于反多重注册聚类检测）
      let signupIpHash: string | null = null;
      try {
        const { headers } = await import('next/headers');
        const { hashIp } = await import('@/lib/signup-rate-limit');
        const h = await headers();
        const ip =
          h.get('x-forwarded-for')?.split(',')[0]?.trim() ||
          h.get('x-real-ip') ||
          h.get('cf-connecting-ip');
        if (ip) signupIpHash = hashIp(ip);
      } catch {
        // headers() 可能在测试或非请求上下文中不可用
      }

      // 查 audit log 看该 emailNormalized 历史上 hard-purge 过几次
      // （cron 在 user-purge 时写过 'user.hard_purged' + metadata.emailNormalizedHistorical）
      // 用于反复活滥用：注册时把次数留在 priorPurgeCount 字段，下游可用作风控信号。
      let priorPurgeCount = 0;
      if (emailNormalized) {
        try {
          const past = await db.query.auditLogs.findMany({
            where: (a, { sql }) => sql`${a.action} = 'user.hard_purged' AND ${a.metadata}->>'emailNormalizedHistorical' = ${emailNormalized}`,
            columns: { id: true },
          });
          priorPurgeCount = past.length;
          if (priorPurgeCount > 0) {
            console.warn(`[adapter.createUser] emailNormalized=${emailNormalized} has ${priorPurgeCount} prior hard-purges`);
          }
        } catch {
          // audit 查询失败不阻塞注册
        }
      }

      // 评估注册风险层（一次性，写入后下游决策都读该字段）
      const { assessRegistrationRisk, policyForTier } = await import('@/lib/risk-tier');
      const assessment = await assessRegistrationRisk(db, {
        priorPurgeCount,
        signupIpHash,
        emailNormalized,
        email: data.email ?? null,
      });
      if (assessment.tier > 0) {
        console.warn(
          `[adapter.createUser] new user tier=${assessment.tier} reason=${assessment.reason} ` +
          `email_normalized=${emailNormalized}`,
        );
      }

      await db.insert(users).values({
        id,
        email: data.email,
        emailNormalized,
        emailVerified: data.emailVerified,
        name: data.name,
        image: data.image,
        signupIpHash,
        priorPurgeCount,
        riskTier: assessment.tier,
        riskTierReason: assessment.reason,
        createdAt: now,
        updatedAt: now,
      });

      // tier ≥ 2 触发 Slack 告警（fire-and-forget）
      const policy = policyForTier(assessment.tier);
      if (policy.alertOnRegistration) {
        try {
          const webhook = process.env.SLACK_RISK_WEBHOOK;
          if (webhook) {
            void fetch(webhook, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                text:
                  `:warning: High-risk registration tier=${assessment.tier} ` +
                  `(${assessment.reason}) — user=${id}, email_normalized=${emailNormalized}`,
              }),
            }).catch(() => undefined);
          }
        } catch {
          // never let slack error fail signup
        }
      }

      // 需求验证漏斗起点：OAuth 与邮箱密码注册都经由这里建号，只在这一处记 signup_completed。
      const { recordProductEventAfterResponse } = await import('@/lib/product-events/server');
      recordProductEventAfterResponse('signup_completed', { userId: id, tenantId: id });

      const user = await db.query.users.findFirst({
        where: eq(users.id, id),
      });

      if (!user) throw new Error('User not found after creation');
      return {
        id: user.id,
        email: user.email!,
        emailVerified: user.emailVerified,
        name: user.name,
        image: user.image,
      };
    },

    async getUser(id: string) {
      const db = resolveDb(dbOrGetter);
      const user = await db.query.users.findFirst({
        where: eq(users.id, id),
      });

      if (!user) return null;
      return {
        id: user.id,
        email: user.email!,
        emailVerified: user.emailVerified,
        name: user.name,
        image: user.image,
      };
    },

    async getUserByEmail(email: string) {
      const db = resolveDb(dbOrGetter);
      // 先精确匹配；如未命中再走 emailNormalized（处理大小写/gmail 别名等
      // 视为同一用户的情形，让 Auth.js 自动 linkAccount 到既有 user）。
      let user = await db.query.users.findFirst({
        where: eq(users.email, email),
      });
      if (!user) {
        const { normalizeEmail } = await import('@/lib/email-normalize');
        const normalized = normalizeEmail(email);
        user = await db.query.users.findFirst({
          where: eq(users.emailNormalized, normalized),
        });
      }

      if (!user) return null;
      return {
        id: user.id,
        email: user.email!,
        emailVerified: user.emailVerified,
        name: user.name,
        image: user.image,
      };
    },

    async getUserByAccount({ providerAccountId, provider }: Pick<AdapterAccount, 'provider' | 'providerAccountId'>) {
      const db = resolveDb(dbOrGetter);
      const account = await db.query.accounts.findFirst({
        where: and(
          eq(accounts.providerAccountId, providerAccountId),
          eq(accounts.provider, provider)
        ),
        with: {
          user: true,
        },
      });

      if (!account?.user) return null;
      return {
        id: account.user.id,
        email: account.user.email!,
        emailVerified: account.user.emailVerified,
        name: account.user.name,
        image: account.user.image,
      };
    },

    async updateUser(data: Partial<AdapterUser> & Pick<AdapterUser, 'id'>) {
      const db = resolveDb(dbOrGetter);
      if (!data.id) throw new Error('User ID is required');

      await db.update(users).set({
        name: data.name,
        email: data.email,
        emailVerified: data.emailVerified,
        image: data.image,
        updatedAt: new Date(),
      }).where(eq(users.id, data.id));

      const user = await db.query.users.findFirst({
        where: eq(users.id, data.id),
      });

      if (!user) throw new Error('User not found');
      return {
        id: user.id,
        email: user.email!,
        emailVerified: user.emailVerified,
        name: user.name,
        image: user.image,
      };
    },

    async deleteUser(userId: string) {
      const db = resolveDb(dbOrGetter);
      await db.delete(users).where(eq(users.id, userId));
    },

    async linkAccount(data: AdapterAccount) {
      const db = resolveDb(dbOrGetter);
      await db.insert(accounts).values({
        id: crypto.randomUUID(),
        userId: data.userId,
        type: data.type,
        provider: data.provider,
        providerAccountId: data.providerAccountId,
        refresh_token: data.refresh_token,
        access_token: data.access_token,
        expires_at: data.expires_at,
        token_type: data.token_type,
        scope: data.scope,
        id_token: data.id_token,
        session_state: data.session_state as string | null,
      });
    },

    async unlinkAccount({ providerAccountId, provider }: Pick<AdapterAccount, 'provider' | 'providerAccountId'>) {
      const db = resolveDb(dbOrGetter);
      await db.delete(accounts).where(
        and(
          eq(accounts.providerAccountId, providerAccountId),
          eq(accounts.provider, provider)
        )
      );
    },

    async createSession(data: { sessionToken: string; userId: string; expires: Date }) {
      const db = resolveDb(dbOrGetter);
      await db.insert(sessions).values({
        id: crypto.randomUUID(),
        sessionToken: data.sessionToken,
        userId: data.userId,
        expires: data.expires,
      });

      const session = await db.query.sessions.findFirst({
        where: eq(sessions.sessionToken, data.sessionToken),
      });

      if (!session) throw new Error('Session not found after creation');
      return {
        sessionToken: session.sessionToken,
        userId: session.userId,
        expires: session.expires,
      };
    },

    async getSessionAndUser(sessionToken: string) {
      const db = resolveDb(dbOrGetter);
      const session = await db.query.sessions.findFirst({
        where: eq(sessions.sessionToken, sessionToken),
        with: {
          user: true,
        },
      });

      if (!session?.user) return null;

      return {
        session: {
          sessionToken: session.sessionToken,
          userId: session.userId,
          expires: session.expires,
        },
        user: {
          id: session.user.id,
          email: session.user.email!,
          emailVerified: session.user.emailVerified,
          name: session.user.name,
          image: session.user.image,
        },
      };
    },

    async updateSession(data: Partial<AdapterSession> & Pick<AdapterSession, 'sessionToken'>) {
      const db = resolveDb(dbOrGetter);
      await db.update(sessions).set({
        expires: data.expires,
      }).where(eq(sessions.sessionToken, data.sessionToken));

      const session = await db.query.sessions.findFirst({
        where: eq(sessions.sessionToken, data.sessionToken),
      });

      if (!session) return null;
      return {
        sessionToken: session.sessionToken,
        userId: session.userId,
        expires: session.expires,
      };
    },

    async deleteSession(sessionToken: string) {
      const db = resolveDb(dbOrGetter);
      await db.delete(sessions).where(eq(sessions.sessionToken, sessionToken));
    },

    async createVerificationToken(data: VerificationToken) {
      const db = resolveDb(dbOrGetter);
      await db.insert(verificationTokens).values({
        identifier: data.identifier,
        token: data.token,
        expires: data.expires,
      });

      const token = await db.query.verificationTokens.findFirst({
        where: and(
          eq(verificationTokens.identifier, data.identifier),
          eq(verificationTokens.token, data.token)
        ),
      });

      if (!token) throw new Error('Verification token not found after creation');
      return {
        identifier: token.identifier,
        token: token.token,
        expires: token.expires,
      };
    },

    async useVerificationToken({ identifier, token }: { identifier: string; token: string }) {
      const db = resolveDb(dbOrGetter);
      const verificationToken = await db.query.verificationTokens.findFirst({
        where: and(
          eq(verificationTokens.identifier, identifier),
          eq(verificationTokens.token, token)
        ),
      });

      if (!verificationToken) return null;

      await db.delete(verificationTokens).where(
        and(
          eq(verificationTokens.identifier, identifier),
          eq(verificationTokens.token, token)
        )
      );

      return {
        identifier: verificationToken.identifier,
        token: verificationToken.token,
        expires: verificationToken.expires,
      };
    },
  };
}
