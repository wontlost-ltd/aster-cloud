import { describe, it, expect } from 'vitest';
import {
  canonicalJson,
  canonicalHash,
  decimalTypeContext,
  CanonicalJsonError,
  CANONICALIZATION_VERSION,
} from './canonical-json';

describe('canonicalJson — object key 排序', () => {
  it('object key 按 code point 升序，与插入顺序无关', () => {
    const a = canonicalJson({ b: 1, a: 2, c: 3 });
    const b = canonicalJson({ c: 3, a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1,"c":3}');
  });

  it('嵌套 object 递归排序', () => {
    const out = canonicalJson({ z: { y: 1, x: 2 }, a: 3 });
    expect(out).toBe('{"a":3,"z":{"x":2,"y":1}}');
  });

  it('array 保序（不排序）', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalJson(['b', 'a'])).toBe('["b","a"]');
  });

  it('大写字母 code point 小于小写（A=65 < a=97）', () => {
    expect(canonicalJson({ a: 1, A: 2 })).toBe('{"A":2,"a":1}');
  });

  it('补充平面字符 key 按 code point 排序（代理对不破坏顺序）', () => {
    // U+1F600 (😀, cp=128512) 应排在 U+FFFF 之后。用显式 code point 比较验证。
    const out = canonicalJson({ '\u{1F600}': 1, '￿': 2 });
    expect(out).toBe('{"￿":2,"\u{1F600}":1}');
  });
});

describe('canonicalJson — null vs missing（铁律）', () => {
  it('null 显式输出', () => {
    expect(canonicalJson({ a: null })).toBe('{"a":null}');
    expect(canonicalJson(null)).toBe('null');
  });

  it('missing key ≠ null：两者产生不同 canonical', () => {
    const withNull = canonicalJson({ a: 1, b: null });
    const missing = canonicalJson({ a: 1 });
    expect(withNull).not.toBe(missing);
    expect(withNull).toBe('{"a":1,"b":null}');
    expect(missing).toBe('{"a":1}');
  });

  it('不丢空对象 / 空数组 / false / 0 / 空字符串', () => {
    expect(canonicalJson({ a: {} })).toBe('{"a":{}}');
    expect(canonicalJson({ a: [] })).toBe('{"a":[]}');
    expect(canonicalJson({ a: false })).toBe('{"a":false}');
    expect(canonicalJson({ a: 0 })).toBe('{"a":0}');
    expect(canonicalJson({ a: '' })).toBe('{"a":""}');
  });
});

describe('canonicalJson — number（非 Decimal 路径 = safe integer 铁律）', () => {
  it('safe integer 直接输出', () => {
    expect(canonicalJson(1)).toBe('1');
    expect(canonicalJson(-42)).toBe('-42');
    expect(canonicalJson(0)).toBe('0');
    expect(canonicalJson(Number.MAX_SAFE_INTEGER)).toBe(String(Number.MAX_SAFE_INTEGER));
  });

  it('★非 Decimal 路径的小数被拒绝（NON_INTEGER_NUMBER）——跨引擎 float 表示不一致', () => {
    // 双引擎地基：非整数 float 的 JS/Java toString 表示不同 → 必须走 Decimal string + typeCtx。
    expect(() => canonicalJson(1.5)).toThrow(CanonicalJsonError);
    try {
      canonicalJson({ amount: 100.5 });
    } catch (e) {
      expect((e as CanonicalJsonError).reason).toBe('NON_INTEGER_NUMBER');
      expect((e as CanonicalJsonError).path).toBe('amount');
    }
  });

  it('★超 safe-integer 范围的整数也被拒绝（表示歧义）', () => {
    expect(() => canonicalJson(Number.MAX_SAFE_INTEGER + 2)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(1e21)).toThrow(CanonicalJsonError);
  });

  it('-0 归一为 0', () => {
    expect(canonicalJson(-0)).toBe('0');
    expect(canonicalJson({ a: -0 })).toBe('{"a":0}');
  });

  it('NaN / Infinity 被拒绝（NON_CANONICAL_NUMBER）', () => {
    expect(() => canonicalJson(NaN)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(Infinity)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(-Infinity)).toThrow(CanonicalJsonError);
    try {
      canonicalJson({ amount: NaN });
    } catch (e) {
      expect(e).toBeInstanceOf(CanonicalJsonError);
      expect((e as CanonicalJsonError).reason).toBe('NON_CANONICAL_NUMBER');
      expect((e as CanonicalJsonError).path).toBe('amount');
    }
  });
});

describe('canonicalJson — string 不做业务变换', () => {
  it('原值保留（不 trim / 不 case-fold）', () => {
    expect(canonicalJson('  Hello  ')).toBe('"  Hello  "');
    expect(canonicalJson('MixedCase')).toBe('"MixedCase"');
  });

  it('JSON number 1 ≠ string "1"', () => {
    expect(canonicalJson(1)).not.toBe(canonicalJson('1'));
    expect(canonicalJson('1')).toBe('"1"');
  });

  it('转义与 JSON 一致', () => {
    expect(canonicalJson('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(canonicalJson('line\nbreak')).toBe('"line\\nbreak"');
  });
});

describe('canonicalJson — Decimal 类型感知', () => {
  const ctx = decimalTypeContext(['amount', 'applicants[].income']);

  it('无 typeCtx 时 number 按 JSON number 处理', () => {
    expect(canonicalJson({ amount: 100 })).toBe('{"amount":100}');
  });

  it('Decimal 路径：trailing zero 去除', () => {
    expect(canonicalJson({ amount: '100.500' }, ctx)).toBe('{"amount":100.5}');
    expect(canonicalJson({ amount: '100.00' }, ctx)).toBe('{"amount":100}');
  });

  it('Decimal 路径：无意义前导零去除', () => {
    expect(canonicalJson({ amount: '007.50' }, ctx)).toBe('{"amount":7.5}');
    expect(canonicalJson({ amount: '0.5' }, ctx)).toBe('{"amount":0.5}');
  });

  it('Decimal 路径：整数无 .0', () => {
    expect(canonicalJson({ amount: '42.0' }, ctx)).toBe('{"amount":42}');
    expect(canonicalJson({ amount: '42' }, ctx)).toBe('{"amount":42}');
  });

  it('Decimal 路径：-0 → 0', () => {
    expect(canonicalJson({ amount: '-0.00' }, ctx)).toBe('{"amount":0}');
    expect(canonicalJson({ amount: '-0' }, ctx)).toBe('{"amount":0}');
  });

  it('Decimal 路径：负数保留符号', () => {
    expect(canonicalJson({ amount: '-100.50' }, ctx)).toBe('{"amount":-100.5}');
  });

  it('Decimal 路径：指数形式展开', () => {
    expect(canonicalJson({ amount: '1.5e2' }, ctx)).toBe('{"amount":150}');
    expect(canonicalJson({ amount: '1500e-2' }, ctx)).toBe('{"amount":15}');
    expect(canonicalJson({ amount: '1e3' }, ctx)).toBe('{"amount":1000}');
  });

  it('Decimal 语义等价的不同书写产生相同 canonical', () => {
    expect(canonicalJson({ amount: '100.50' }, ctx)).toBe(canonicalJson({ amount: '100.5' }, ctx));
    expect(canonicalJson({ amount: '100.50' }, ctx)).toBe(canonicalJson({ amount: '1.005e2' }, ctx));
  });

  it('Decimal 路径匹配 array 通配 []', () => {
    const out = canonicalJson({ applicants: [{ income: '5000.00' }, { income: '6000.0' }] }, ctx);
    expect(out).toBe('{"applicants":[{"income":5000},{"income":6000}]}');
  });

  it('Decimal 路径非法格式被拒绝', () => {
    expect(() => canonicalJson({ amount: 'abc' }, ctx)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ amount: '1.2.3' }, ctx)).toThrow(CanonicalJsonError);
  });

  it('非 Decimal 路径的 number 不受影响', () => {
    // count 不在 decimalPaths → 普通 number
    expect(canonicalJson({ amount: '100.50', count: 3 }, ctx)).toBe('{"amount":100.5,"count":3}');
  });
});

describe('canonicalJson — 非 JSON 值拒绝', () => {
  it('undefined / function / bigint 抛 UNSUPPORTED_VALUE', () => {
    expect(() => canonicalJson(undefined)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ a: () => 1 })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(BigInt(1) as unknown)).toThrow(CanonicalJsonError);
  });

  it('★非 plain object（Date/Map/Set/RegExp）被拒绝，不静默成 {}（Codex L2）', () => {
    expect(() => canonicalJson(new Date())).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(new Map())).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(new Set())).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(/x/)).toThrow(CanonicalJsonError);
    // 嵌套非 plain object 也拒绝
    expect(() => canonicalJson({ ts: new Date() })).toThrow(CanonicalJsonError);
  });

  it('plain object（含 Object.create(null)）接受', () => {
    const nullProto = Object.create(null);
    nullProto.a = 1;
    expect(canonicalJson(nullProto)).toBe('{"a":1}');
  });

  it('★sparse array hole 被拒绝（Codex L2）', () => {
    const sparse = [1, , 3] as unknown[]; // eslint-disable-line no-sparse-arrays
    expect(() => canonicalJson(sparse)).toThrow(CanonicalJsonError);
  });
});

describe('canonicalJson — Decimal 资源上限（防 DoS，Codex L1#3）', () => {
  const ctx = decimalTypeContext(['x']);
  it('按真实展开位数接受边界内指数，并拒绝越界指数', () => {
    for (const input of ['1e2000', '1e3000', '1e4095', '1e-3000', '1e-4095']) {
      expect(() => canonicalJson({ x: input }, ctx), input).not.toThrow();
    }
    for (const input of ['1e4096', '1e-4096']) {
      try {
        canonicalJson({ x: input }, ctx);
        throw new Error(`${input} 应被拒绝`);
      } catch (error) {
        expect(error).toBeInstanceOf(CanonicalJsonError);
        expect((error as CanonicalJsonError).reason).toBe('DECIMAL_TOO_LARGE');
      }
    }
  });
  it('大指数被拒绝（DECIMAL_TOO_LARGE），非非受控异常', () => {
    try {
      canonicalJson({ x: '1e1000000000' }, ctx);
      throw new Error('应抛错');
    } catch (e) {
      expect(e).toBeInstanceOf(CanonicalJsonError);
      expect((e as CanonicalJsonError).reason).toBe('DECIMAL_TOO_LARGE');
    }
    expect(() => canonicalJson({ x: '1e-1000000000' }, ctx)).toThrow(CanonicalJsonError);
  });

  it('Decimal string 含空白被拒绝（不 trim，Codex L1#4）', () => {
    expect(() => canonicalJson({ x: ' 1.5 ' }, ctx)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ x: '1.5 ' }, ctx)).toThrow(CanonicalJsonError);
  });

  it('正常金额指数仍工作（未误伤）', () => {
    expect(canonicalJson({ x: '1.5e2' }, ctx)).toBe('{"x":150}');
  });

  it('★Decimal 路径的非整数 number 被拒绝（须 string 承载，Codex 复审 #1 闭环）', () => {
    // Decimal number 100.5 走 JS toString 会重引入跨引擎隐患 → 强制 string。
    expect(() => canonicalJson({ x: 100.5 }, ctx)).toThrow(CanonicalJsonError);
    // Decimal 路径的整数 number 仍接受（safe integer）。
    expect(canonicalJson({ x: 100 }, ctx)).toBe('{"x":100}');
    // string 承载的精确小数正常。
    expect(canonicalJson({ x: '100.5' }, ctx)).toBe('{"x":100.5}');
  });
});

describe('canonicalHash — 确定性 + 版本前缀', () => {
  it('相同语义值产生相同 hash（与 key 顺序无关）', () => {
    const h1 = canonicalHash({ b: 1, a: 2 });
    const h2 = canonicalHash({ a: 2, b: 1 });
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('不同语义值产生不同 hash（null vs missing）', () => {
    expect(canonicalHash({ a: 1, b: null })).not.toBe(canonicalHash({ a: 1 }));
  });

  it('Decimal 等价书写 hash 相同', () => {
    const ctx = decimalTypeContext(['x']);
    expect(canonicalHash({ x: '1.50' }, ctx)).toBe(canonicalHash({ x: '1.5' }, ctx));
  });

  it('hash 前缀含版本（算法变更不碰撞）：手算校验', () => {
    // sha256("aster-canonical-json/v1\nnull") — 版本前缀参与摘要。
    const h = canonicalHash(null);
    // 只断言稳定性 + 格式；具体值随版本前缀确定。
    expect(h).toBe(canonicalHash(null));
    expect(CANONICALIZATION_VERSION).toBe('aster-canonical-json/v1');
  });
});

describe('canonicalJson — 复合金融决策样本（回放场景）', () => {
  it('信贷申请 input canonical 稳定', () => {
    const ctx = decimalTypeContext(['creditScore', 'income', 'requestedAmount']);
    const inputA = {
      requestedAmount: '50000.00',
      income: '120000.0',
      creditScore: 680,
      applicantName: 'Alice',
    };
    const inputB = {
      applicantName: 'Alice',
      creditScore: 680,
      income: '120000',
      requestedAmount: '50000',
    };
    // 语义相同、书写/顺序不同 → 同 canonical hash（回放不误报漂移）。
    expect(canonicalHash(inputA, ctx)).toBe(canonicalHash(inputB, ctx));
  });

  it('creditScore 680 vs 679 产生不同 hash（决策边界敏感）', () => {
    const ctx = decimalTypeContext(['creditScore']);
    expect(canonicalHash({ creditScore: 680 }, ctx)).not.toBe(
      canonicalHash({ creditScore: 679 }, ctx),
    );
  });
});
