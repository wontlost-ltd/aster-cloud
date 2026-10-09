/**
 * 本地栈浏览器 E2E 会话夹具：用 Auth.js v5 的 encode 伪造 JWT 会话 cookie，
 * 为每个种子用户写出 Playwright storageState 文件。
 *
 * 必须在 aster-cloud 容器内运行（需要 process.env.NEXTAUTH_SECRET）：
 *   podman exec -w /app aster-cloud sh -c 'npx tsx scripts/e2e-local-session.ts'
 * 输出目录默认 .superpowers/e2e-local（已被 git 忽略），可用 E2E_STATE_DIR 覆盖。
 * 仅用于本地开发栈，切勿指向生产密钥。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SESSION_COOKIE_NAME as COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS as MAX_AGE_SECONDS,
  sessionCookie,
  type SessionUser as SeedUser,
} from './lib/session-cookie';

// 与本地栈种子数据保持一致
const USERS: SeedUser[] = [
  { id: 'm-free', email: 'm-free@stack.test', plan: 'pro' },
  { id: 'm-dpo', email: 'm-dpo@stack.test', plan: 'free' },
  { id: 'owner1', email: 'owner1@stack.test', plan: 'team' },
  { id: 't1', email: 't1@stack.test', plan: 'pro' },
];

async function main(): Promise<void> {
  const secret = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error('缺少 AUTH_SECRET / NEXTAUTH_SECRET');
  const outDir = process.env.E2E_STATE_DIR || '.superpowers/e2e-local';
  mkdirSync(outDir, { recursive: true });
  const expires = Math.floor(Date.now() / 1000) + MAX_AGE_SECONDS;

  for (const user of USERS) {
    const value = await sessionCookie(user, secret);
    const state = {
      cookies: [
        { name: COOKIE_NAME, value, domain: 'localhost', path: '/', httpOnly: true, secure: false, sameSite: 'Lax', expires },
      ],
      origins: [],
    };
    const file = join(outDir, `state-${user.id}.json`);
    writeFileSync(file, JSON.stringify(state, null, 2));
    console.log(`已写出 ${file}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
