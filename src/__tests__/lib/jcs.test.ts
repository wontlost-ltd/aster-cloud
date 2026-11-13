// @vitest-environment node
/**
 * RFC 8785（JCS）规范化（ADR 0040 §12 D2）：逐条跑 aster-api 的共享向量 `jcs-sha256-v1-vectors.json`，
 * 与 aster-api `JcsCanonicalizer` 逐字节一致；向量文件本身须与 aster-api 的副本逐字节相同。
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JcsError, jcsCanonicalize } from '@/lib/jcs';

interface Vector {
  name: string;
  input: string;
  canonical?: string;
  sha256?: string;
  error?: 'unsafe_integer' | 'invalid_string' | 'duplicate_key';
}

const VECTORS_PATH = join(__dirname, '..', 'fixtures', 'jcs-sha256-v1-vectors.json');
const raw = readFileSync(VECTORS_PATH);
const vectors = JSON.parse(raw.toString('utf8')) as Vector[];
/** aster-api origin/main `src/test/resources/guard/jcs-sha256-v1-vectors.json` 的 sha256。 */
const API_VECTORS_SHA256 = 'cfef20a2761165d09b1af4cbdbc74e65cf7778d9d26a90c1226acb90f52c998e';

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof JcsError ? e.code : `not JcsError: ${String(e)}`;
  }
  return undefined;
}

describe('jcsCanonicalize — aster-api 共享向量', () => {
  it('vectorFileIsByteIdenticalToApi', () => {
    expect(createHash('sha256').update(raw).digest('hex')).toBe(API_VECTORS_SHA256);
    expect(vectors.length).toBe(48);
  });

  for (const v of vectors) {
    if (v.error === 'duplicate_key') {
      it.skip(`${v.name}：JS 值不可能含重复键；cloud 只规范化自己构造的值`, () => {});
      continue;
    }
    if (v.error) {
      it(`${v.name} → ${v.error}`, () => {
        expect(codeOf(() => jcsCanonicalize(JSON.parse(v.input)))).toBe(v.error);
      });
      continue;
    }
    it(`${v.name}`, () => {
      const canonical = jcsCanonicalize(JSON.parse(v.input));
      expect(canonical).toBe(v.canonical);
      expect(sha256(canonical)).toBe(v.sha256);
    });
  }
});

describe('jcsCanonicalize — JS 值专有情形', () => {
  it('undefined / 函数 / bigint / symbol → unsupported_value', () => {
    expect(codeOf(() => jcsCanonicalize(undefined))).toBe('unsupported_value');
    expect(codeOf(() => jcsCanonicalize({ a: undefined }))).toBe('unsupported_value');
    expect(codeOf(() => jcsCanonicalize([() => 1]))).toBe('unsupported_value');
    expect(codeOf(() => jcsCanonicalize(BigInt(1)))).toBe('unsupported_value');
    expect(codeOf(() => jcsCanonicalize(Symbol('x')))).toBe('unsupported_value');
  });

  it('非有限数 → unsafe_integer', () => {
    expect(codeOf(() => jcsCanonicalize(Number.NaN))).toBe('unsafe_integer');
    expect(codeOf(() => jcsCanonicalize({ n: Number.POSITIVE_INFINITY }))).toBe('unsafe_integer');
  });

  it('键里的孤立代理项 → invalid_string', () => {
    expect(codeOf(() => jcsCanonicalize({ '\ud800': 1 }))).toBe('invalid_string');
  });

  it('非普通对象（Date、Map）→ unsupported_value，不按 toJSON 隐式转换', () => {
    expect(codeOf(() => jcsCanonicalize(new Date(0)))).toBe('unsupported_value');
    expect(codeOf(() => jcsCanonicalize(new Map()))).toBe('unsupported_value');
  });

  it('稀疏数组的空位 → unsupported_value', () => {
    expect(codeOf(() => jcsCanonicalize([1, , 2]))).toBe('unsupported_value');
  });

  it('嵌套对象按 UTF-16 码元序排序、无空白，null 与布尔原样', () => {
    expect(jcsCanonicalize({ b: [true, null, { d: 1, c: 'x' }], a: false })).toBe(
      '{"a":false,"b":[true,null,{"c":"x","d":1}]}',
    );
  });
});
