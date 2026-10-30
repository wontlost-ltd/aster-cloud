// 执行页预填模板的 defaultInputs（2026-10-30 生产复测 G：由内置模板创建的策略，执行页预填的是
// 按参数类型生成的空字符串示例 {"driver":{"id":"","age":"",…}}，而不是模板自带的 defaultInputs）。
import { describe, it, expect } from 'vitest';
import { POLICY_EXAMPLES, findExampleDefaultInput, type SupportedLocale } from '@/data/policy-examples';

describe('findExampleDefaultInput', () => {
  for (const example of POLICY_EXAMPLES) {
    for (const locale of Object.keys(example.sources) as SupportedLocale[]) {
      it(`${example.id} [${locale}]：源码一致且参数名对得上 → 返回该语种的 defaultInputs`, () => {
        const input = example.defaultInputs[locale];
        expect(findExampleDefaultInput(example.sources[locale], Object.keys(input))).toEqual(input);
      });
    }
  }

  const auto = POLICY_EXAMPLES.find((e) => e.id === 'auto-insurance-quote')!;
  const src = auto.sources['en-US'];

  it('只差换行风格与行尾空白也算同一模板', () => {
    const crlf = `\n${src.replace(/\n/g, '  \r\n')}\n\n`;
    expect(findExampleDefaultInput(crlf, ['driver', 'vehicle'])).toEqual(auto.defaultInputs['en-US']);
  });

  it('源码被改过 → null（不能把模板输入套到用户自己的策略上）', () => {
    expect(findExampleDefaultInput(src.replace('Module insurance.auto.', 'Module my.auto.'), ['driver', 'vehicle'])).toBeNull();
  });

  it('参数名对不上（如选中了模板里的另一条规则）→ null', () => {
    expect(findExampleDefaultInput(src, ['driver'])).toBeNull();
    expect(findExampleDefaultInput(src, ['driver', 'vehicle', 'extra'])).toBeNull();
  });

  it('返回副本，修改不影响模板数据', () => {
    const input = findExampleDefaultInput(src, ['driver', 'vehicle'])!;
    (input.driver as Record<string, unknown>).age = 99;
    expect((auto.defaultInputs['en-US'].driver as Record<string, unknown>).age).toBe(35);
  });
});
