/**
 * evaluate-json 文档页（en/de/zh）的示例必须是 aster-api 能严格读入的 Core IR v2（ADR 0055）：
 * 旧示例是一种手写的、两个引擎都不认的形状，读者照抄只会得到 400。这里锁定三件事：
 * 1. curl 示例里的 `policy` 字符串逐字节等于引擎对页面源码 `compile()` 产出的 `coreJson`；
 * 2. 它能被 `readCoreIr` 严格读入（版本预检 → schema → 不变式），且规范序列化后字节不变；
 * 3. 「格式」一节的排版版 JSON 与 coreJson 语义相同，且按示例上下文求值得到文档写的结果。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { readCoreIr, serializeCoreIr } from '@aster-cloud/aster-lang-ts';
import { compile, evaluate } from '@aster-cloud/aster-lang-ts/browser';

const DIR = join(process.cwd(), 'src/app/[locale]/docs/api/policies/evaluate-json');

function blocks(mdx: string, lang: string): string[] {
  const fence = new RegExp('```' + lang + '\\n([\\s\\S]*?)```', 'g');
  return [...mdx.matchAll(fence)].map((m) => m[1]!);
}

function page(locale: string) {
  const mdx = readFileSync(join(DIR, `${locale}.mdx`), 'utf8');
  const source = blocks(mdx, 'text').find((b) => b.startsWith('Module '));
  const pretty = blocks(mdx, 'json').find((b) => b.includes('"schemaVersion"'));
  const curl = blocks(mdx, 'bash \\[curl\\]')[0];
  const policy = curl?.match(/"policy": ("(?:[^"\\]|\\.)*")/)?.[1];
  if (!source || !pretty || !policy) throw new Error(`${locale}.mdx 缺少源码、IR 或 curl 示例`);
  return { source, pretty, policy: JSON.parse(policy) as string };
}

describe('evaluate-json 文档示例是 Core IR v2', () => {
  it.each(['en', 'de', 'zh'])('%s：curl 的 policy 即 compile().coreJson，可严格读入并按示例求值', (locale) => {
    const { source, pretty, policy } = page(locale);

    const compiled = compile(source);
    expect(compiled.success, JSON.stringify(compiled.parseErrors)).toBe(true);
    expect(policy).toBe(compiled.coreJson);

    const core = readCoreIr(policy);
    expect(core.schemaVersion).toBe(2);
    expect(serializeCoreIr(core)).toBe(policy);
    expect(JSON.parse(pretty)).toEqual(JSON.parse(policy));

    expect(evaluate(core, 'calculate', { order: { total: 150 } })).toMatchObject({ success: true, value: 10 });
    expect(evaluate(core, 'calculate', { order: { total: 50 } })).toMatchObject({ success: true, value: 0 });
  });

  it('旧示例形状（无 schemaVersion）被严格读方拒收', () => {
    const legacy = '{"moduleName":"Discount","functions":[]}';
    expect(() => readCoreIr(legacy)).toThrow();
  });
});
