/**
 * /api/llm/* 的调用方解析（ADR 0049 §2.2）。
 *
 * <p>两种调用方：
 * <ul>
 *   <li>浏览器会话：NextAuth `auth()`，用户 id 即租户。</li>
 *   <li>AI 工作台服务：以 HMAC 服务签名代表某个用户调用，签名覆盖
 *       `[METHOD, path, ts, nonce, sha256hex(body), userId]`，300 秒窗口，nonce 一次性。</li>
 * </ul>
 *
 * <p>★一旦请求带了 `X-Internal-Caller: ai-workspace`，就必须验签成功——失败一律 401，
 * 绝不回落到 cookie 会话（否则签名坏了的请求会被同浏览器里的会话悄悄兜住，身份来源变得不可审计）。
 *
 * <p>解析结果只给出「代表哪个用户」；BYOK、配额、记账、错误分类在调用方照旧按该用户进行。
 */
import { auth } from '@/auth';
import { hmacVerify, sha256Hex } from '@/lib/api-signing';
import { safeEnv } from '@/lib/runtime/safe-env';
import { claimNonce } from '@/services/security/nonce-service';

/** AI 工作台服务调用时携带的 `X-Internal-Caller` 取值。 */
export const AI_WORKSPACE_CALLER = 'ai-workspace';

/** 签名时间戳可接受窗口（秒）。 */
const WINDOW_SEC = 300;
/** nonce 记录比签名窗口多活一分钟，保证窗口内必能查到重放。 */
const NONCE_GRACE_SEC = 60;

export type LlmCaller = { userId: string; via: 'session' | 'ai-workspace' };
export type LlmCallerError = { error: string; status: 401 | 503 };

/** 服务签名的 canonical 串；Java 侧（AI 工作台）按同一规则拼接。 */
export function canonicalAiWorkspace(
  method: string,
  path: string,
  ts: string,
  nonce: string,
  bodySha256Hex: string,
  userId: string,
): string {
  return [method.toUpperCase(), path, ts, nonce, bodySha256Hex, userId].join('\n');
}

/** 区分成功与失败的类型守卫。 */
export function isLlmCallerError(r: LlmCaller | LlmCallerError): r is LlmCallerError {
  return 'status' in r;
}

/**
 * 解析调用方。`rawBody` 必须是调用方实际发送（并签名）的原始 body——Request body 只能读一次，
 * 由路由先读出再传进来。
 */
export async function resolveLlmCaller(req: Request, rawBody: string): Promise<LlmCaller | LlmCallerError> {
  if (req.headers.get('x-internal-caller') !== AI_WORKSPACE_CALLER) {
    return resolveSessionCaller();
  }
  return verifyWorkspaceCaller(req, rawBody);
}

/** 会话路径：未登录时的错误体与此前各 /api/llm 路由一致（`{ error: 'Unauthorized' }`）。 */
async function resolveSessionCaller(): Promise<LlmCaller | LlmCallerError> {
  const session = await auth();
  const userId = session?.user?.id;
  return userId ? { userId, via: 'session' } : { error: 'Unauthorized', status: 401 };
}

/** 服务路径：先验格式与时间窗，再验签名，最后认领 nonce（签名通过才写库，防止伪造请求耗用 nonce）。 */
async function verifyWorkspaceCaller(req: Request, rawBody: string): Promise<LlmCaller | LlmCallerError> {
  const key = safeEnv('AI_WORKSPACE_HMAC_KEY');
  if (!key) return { error: 'ai_workspace_unconfigured', status: 503 };

  const header = (name: string) => req.headers.get(name) ?? '';
  const ts = header('x-aster-timestamp');
  const nonce = header('x-aster-nonce');
  const userId = header('x-aster-user-id');
  if (!userId || !/^[0-9a-f]{32}$/.test(nonce) || !/^\d{1,12}$/.test(ts)) {
    return { error: 'bad_signature', status: 401 };
  }
  const tsSec = Number(ts);
  if (Math.abs(Date.now() / 1000 - tsSec) > WINDOW_SEC) {
    return { error: 'stale_signature', status: 401 };
  }

  const bodySha = await sha256Hex(new TextEncoder().encode(rawBody).buffer as ArrayBuffer);
  const canonical = canonicalAiWorkspace(req.method, new URL(req.url).pathname, ts, nonce, bodySha, userId);
  if (!(await hmacVerify(key, canonical, header('x-internal-signature')))) {
    return { error: 'bad_signature', status: 401 };
  }

  const expiresAt = new Date((tsSec + WINDOW_SEC + NONCE_GRACE_SEC) * 1000);
  if (!(await claimNonce(nonce, expiresAt))) {
    return { error: 'replayed_nonce', status: 401 };
  }
  return { userId, via: 'ai-workspace' };
}
