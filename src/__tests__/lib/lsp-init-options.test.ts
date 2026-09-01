import { describe, it, expect } from 'vitest';
import { buildLspInitOptions, shouldApplyDiagnostics } from '@/lib/lsp-init-options';

/**
 * LSP initialize 下发的 initializationOptions。
 *
 * ★这组用例守的是**调用方传了什么**，不是服务端会不会用。
 *   aster-lang-ts#162 的教训：只锁 canonicalizer 契约时，把 LSP 侧的
 *   租户参数整个删掉，测试仍然全绿（第16种假绿）。契约测试证明的是
 *   「服务端会用租户词汇」，证明不了「客户端真的传了」。
 */
describe('LSP initializationOptions 构造', () => {
  const VOCAB = [{ domain: 'insurance.auto', terms: [] }];

  it('★租户与词汇齐全时成对下发', () => {
    const opts = buildLspInitOptions('zh-CN', 'tenant-1', VOCAB);
    expect(opts).toEqual({
      locale: 'zh-CN',
      tenantId: 'tenant-1',
      domainVocabularies: VOCAB,
    });
  });

  // 服务端判断是 `initOpts?.tenantId && Array.isArray(domainVocabularies)`，
  // 缺任一则整块忽略。故只有其一时不该下发——发了不生效，只会误导排查。
  it('★只有 tenantId 而无词汇时不下发租户信息', () => {
    const opts = buildLspInitOptions('en-US', 'tenant-1', undefined);
    expect(opts).toEqual({ locale: 'en-US' });
    expect(opts).not.toHaveProperty('tenantId');
  });

  it('★只有词汇而无 tenantId 时不下发租户信息', () => {
    const opts = buildLspInitOptions('en-US', undefined, VOCAB);
    expect(opts).toEqual({ locale: 'en-US' });
    expect(opts).not.toHaveProperty('domainVocabularies');
  });

  // 空数组等价于「没有词汇」：服务端 currentDomain 取 [0]，
  // 空数组会让它拿到 undefined，注册了也无从生效。
  it('空词汇数组按「无词汇」处理', () => {
    const opts = buildLspInitOptions('de-DE', 'tenant-1', []);
    expect(opts).toEqual({ locale: 'de-DE' });
  });

  it('locale 始终下发（与租户信息无关）', () => {
    for (const l of ['en-US', 'zh-CN', 'de-DE']) {
      expect(buildLspInitOptions(l, undefined, undefined).locale).toBe(l);
    }
  });

  // 服务端 currentDomain = domainVocabularies[0]，故顺序有意义：
  // 当前生效的 domain 必须在首位。这条锁住「不得重排」。
  it('★词汇顺序原样保留（服务端取第 0 项作 currentDomain）', () => {
    const many = [{ domain: 'a' }, { domain: 'b' }, { domain: 'c' }];
    const opts = buildLspInitOptions('en-US', 't', many);
    expect(opts.domainVocabularies).toEqual(many);
    expect((opts.domainVocabularies as { domain: string }[])[0].domain).toBe('a');
  });
});

/**
 * ★诊断归属：Monaco 的 marker 按 owner 分桶，`setModelMarkers` 只替换同名
 *   owner 那一桶。useAsterLSP 写 'aster-lsp'、useAsterCompiler 写
 *   'aster-compiler' —— owner 不同**恰恰保证两套同时渲染**（不是互相覆盖）。
 *
 *   我此前在 PR 里断言「两者不重叠，不会有双份红波浪线」，**那是错的**：
 *   hook 声明了 publishDiagnostics 能力、也发 didOpen/didChange，
 *   这条路径必然触发。调用方不关掉就是每个错误两条红波浪线。
 */
describe('LSP 诊断是否写入 Monaco', () => {
  it('★suppressDiagnostics=true 时不写（编辑器已有浏览器侧诊断）', () => {
    expect(shouldApplyDiagnostics(true)).toBe(false);
  });

  it('未指定时默认写入（独立使用 hook 的调用方不受影响）', () => {
    expect(shouldApplyDiagnostics(undefined)).toBe(true);
    expect(shouldApplyDiagnostics(false)).toBe(true);
  });
});
