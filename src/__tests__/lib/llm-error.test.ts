import { describe, it, expect } from 'vitest';
import { parseLlmError, denialMessageKey, denialMessage } from '@/lib/llm-error';

/**
 * ★这些用例锁的是「用户看到的原因是否准确」。
 * 真实事故：新注册未验证邮箱的用户点 AI 生成 → 服务端正确返回
 * `403 {"error":"ai_email_unverified", ...}`，但前端把整个 body 当纯文本拼进
 * 错误串，用户看到一行原始 JSON，只能去开浏览器控制台才知道真实原因。
 */
describe('parseLlmError', () => {
  it('★邮箱未验证：从 body 解析出精确原因（真实事故场景）', () => {
    const r = parseLlmError(
      403,
      JSON.stringify({ error: 'ai_email_unverified', message: '请先完成邮箱验证以解锁 AI 功能。' }),
    );
    expect(r.reason).toBe('ai_email_unverified');
    expect(r.status).toBe(403);
    expect(r.serverMessage).toContain('邮箱验证');
  });

  it('★同为 403 的封禁必须与邮箱未验证区分开', () => {
    const r = parseLlmError(403, JSON.stringify({ error: 'ai_banned', message: 'x' }));
    expect(r.reason).toBe('ai_banned');
  });

  it('★403 但拿不到原因码 → unknown，绝不猜', () => {
    // 猜错会给出错误的行动指引：让已验证邮箱的被封用户去"验证邮箱"。
    const r = parseLlmError(403, 'Forbidden');
    expect(r.reason).toBe('unknown');
    expect(denialMessageKey(r.reason)).toBeNull();
  });

  it('402/429/401 无 body 时按状态码推断', () => {
    expect(parseLlmError(402, '').reason).toBe('ai_quota_exhausted');
    expect(parseLlmError(429, '').reason).toBe('ai_rate_limited');
    expect(parseLlmError(401, '').reason).toBe('unauthorized');
  });

  it("401 的字面量 'Unauthorized' 被归一（非 snake_case）", () => {
    const r = parseLlmError(401, JSON.stringify({ error: 'Unauthorized' }));
    expect(r.reason).toBe('unauthorized');
  });

  it('★body 非 JSON（上游透传 HTML/纯文本）不得抛异常', () => {
    // llm-sse-proxy 在上游非 2xx 时原样透传上游响应体，可能是 HTML 错误页。
    const r = parseLlmError(502, '<html><body>Bad Gateway</body></html>');
    expect(r.reason).toBe('unknown');
    expect(r.status).toBe(502);
  });

  it('★body 是合法 JSON 但不是对象（如 "null"/数字）也不得崩', () => {
    expect(parseLlmError(403, 'null').reason).toBe('unknown');
    expect(parseLlmError(403, '42').reason).toBe('unknown');
  });

  it('★CSRF 网关的**嵌套** error 对象不得误判（线上实测的第四种 403）', () => {
    // 实测 POST /api/llm/generate 无 Origin/Referer 时，CSRF 网关先于业务逻辑
    // 返回 403，且 body 形状不同：{error: {code, message, reason}} —— error 是
    // **对象**不是字符串。此时 obj.error 不是 string → 落 unknown → 回落通用文案。
    // 若这里误判成某个具体原因，就会给出错误的行动指引。
    const body = JSON.stringify({
      error: { code: 'csrf_forbidden', message: 'CSRF check failed', reason: 'Missing Origin and Referer headers' },
    });
    const r = parseLlmError(403, body);
    expect(r.reason).toBe('unknown');
    expect(r.serverMessage).toBeUndefined(); // message 在嵌套层，不应被当成顶层 message
  });

  it('★未知的 error 码不被当成已知原因（防新增码静默错配）', () => {
    const r = parseLlmError(403, JSON.stringify({ error: 'some_future_reason' }));
    expect(r.reason).toBe('unknown');
  });

  it('Retry-After 只接受非负整数秒', () => {
    expect(parseLlmError(429, '', '30').retryAfterSec).toBe(30);
    expect(parseLlmError(429, '', '0').retryAfterSec).toBe(0);
    // HTTP-date 形式与非法值一律忽略，不能变成 NaN 传给 UI
    expect(parseLlmError(429, '', 'Wed, 21 Oct 2026 07:28:00 GMT').retryAfterSec).toBeUndefined();
    expect(parseLlmError(429, '', '-5').retryAfterSec).toBeUndefined();
    expect(parseLlmError(429, '', null).retryAfterSec).toBeUndefined();
  });
});

describe('denialMessageKey / denialMessage', () => {
  it('每个已知原因都有对应文案 key', () => {
    for (const r of [
      'ai_email_unverified',
      'ai_banned',
      'ai_quota_exhausted',
      'ai_rate_limited',
      'byok_unavailable',
      'cloud_misconfigured',
      'unauthorized',
    ] as const) {
      expect(denialMessageKey(r)).toBeTruthy();
    }
  });

  it('★unknown 返回 null（由调用方回落到服务端 message）', () => {
    expect(denialMessageKey('unknown')).toBeNull();
  });

  it('denial 为空（流内 error 事件）返回 null，不误伤既有展示', () => {
    expect(denialMessage(null, (k) => k)).toBeNull();
  });

  it('★不同原因给出不同文案 key（防全部塌成同一句）', () => {
    const t = (k: string) => k;
    const a = denialMessage({ reason: 'ai_email_unverified', status: 403 }, t);
    const b = denialMessage({ reason: 'ai_banned', status: 403 }, t);
    expect(a).not.toBe(b);
  });
});
