/**
 * 执行入口的 CNL 识别要认版本冻结的声明别名（ADR 0060 §8）：《静夜思》源码以「床前」声明模块、「疑是」起规则，
 * 不含任何规范关键词；只看规范关键词时它被判为本地简单规则，执行报「Policy could not be parsed」而不经 aster-api。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { executePolicyUnified, isAsterCNL } from '@/services/policy/cnl-executor';
import type { Policy } from '@/lib/prisma';
import { jingyesiShowcaseExample } from '@/data/policy-example-showcase';

const POEM = jingyesiShowcaseExample.sources['zh-CN'];
const POEM_ALIASES = { FUNC_PRODUCE: ['举头'], FUNC_TO: ['疑是'], MODULE_DECL: ['床前'], RETURN: ['低头'] };
const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

describe('isAsterCNL with the version alias set', () => {
  it('the poem is CNL only together with its frozen aliases', () => {
    expect(isAsterCNL(POEM)).toBe(false);
    expect(isAsterCNL(POEM, null)).toBe(false);
    expect(isAsterCNL(POEM, POEM_ALIASES)).toBe(true);
  });

  it('a module or rule alias counts only at the start of a line and followed by a name', () => {
    expect(isAsterCNL('床前 明月光。', { MODULE_DECL: ['床前'] })).toBe(true);
    expect(isAsterCNL('  疑是 地上霜，', { FUNC_TO: ['疑是'] })).toBe(true);
    expect(isAsterCNL('if x then 床前 y', { MODULE_DECL: ['床前'] })).toBe(false);
    expect(isAsterCNL('床前', { MODULE_DECL: ['床前'] })).toBe(false);
    // 其他 kind 的别名（返回 / 产出）不起声明
    expect(isAsterCNL('低头 思故乡。', { RETURN: ['低头'] })).toBe(false);
  });

  it('multi-word aliases match case-insensitively and regex characters are literal', () => {
    expect(isAsterCNL('Du bist mein ich bin dein.', { MODULE_DECL: ['du bist mein ich bin'] })).toBe(true);
    expect(isAsterCNL('a+b x', { MODULE_DECL: ['a+b'] })).toBe(true);
    expect(isAsterCNL('aab x', { MODULE_DECL: ['a+b'] })).toBe(false);
  });

  it('canonical-keyword detection and simple rules are unchanged', () => {
    expect(isAsterCNL('模块 金融.贷款。\n\n规则 r 给定 x 作为 整数，产出 整数：\n  返回 x。')).toBe(true);
    expect(isAsterCNL('if amount > 100 then deny', POEM_ALIASES)).toBe(false);
    expect(isAsterCNL('', POEM_ALIASES)).toBe(false);
  });
});

describe('executePolicyUnified routes the poem to aster-api', () => {
  it('posts evaluate-source with the aliases instead of the simple engine', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ result: '静夜思', executionTimeMs: 1, error: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    const result = await executePolicyUnified({
      policy: { id: 'p1', name: 'jys', content: POEM, userId: 'u1' } as Policy,
      input: {},
      userId: 'u1',
      tenantId: 't1',
      functionName: '地上霜',
      aliasSet: POEM_ALIASES,
      locale: 'zh-CN',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('/evaluate-source');
    const body = JSON.parse(String(init.body)) as { source: string; locale: string; aliasSet?: unknown };
    expect(body.source).toBe(POEM);
    expect(body.locale).toBe('zh-CN');
    expect(body.aliasSet).toEqual(POEM_ALIASES);
    expect(result.metadata.engine).toBe('aster-cnl');
  });
});
