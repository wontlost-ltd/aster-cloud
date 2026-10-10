/**
 * 用 Auth.js v5 的 encode 伪造本地栈 JWT 会话 cookie 值。仅限本地开发密钥。
 */
import { encode } from 'next-auth/jwt';

// http 环境下 Auth.js v5 的会话 cookie 名，同时作为 JWE 派生盐
export const SESSION_COOKIE_NAME = 'authjs.session-token';
export const SESSION_MAX_AGE_SECONDS = 24 * 60 * 60;

export interface SessionUser {
  id: string;
  email: string;
  plan: string;
}

export function sessionCookie(user: SessionUser, secret: string): Promise<string> {
  return encode({
    token: { sub: user.id, id: user.id, email: user.email, name: user.id, plan: user.plan, isAdmin: false },
    secret,
    salt: SESSION_COOKIE_NAME,
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}
