/**
 * 代码里静态可解析的 `t('key')` 必须在运行时文案中存在。
 *
 * 运行时文案 = 内嵌 npm 包 `@aster-cloud/ui-messages`（en-US）∪ cloud 本地补充层
 * `src/i18n/demo-supplement.ts`（request.ts 用 deepMergeMessages 叠在包之上）。
 * 缺键不会报错——`getMessageFallback` 会把 key 路径原样显示给用户——所以只能靠
 * 静态核对兜住。扫描逻辑与 CI 的 `check:message-keys` 共用同一实现。
 *
 * 只核对字面量命名空间 + 字面量键（含 `t(\`前缀.${x}\`)` 的静态前缀）；
 * 完全动态的键无法静态判定，按设计跳过。
 */
import { describe, it, expect } from 'vitest';
import { scanMissingKeys } from '../../../scripts/check-message-keys.mjs';

describe('t() 键存在性', () => {
  const { missing, scanned, unboundFiles } = scanMissingKeys();

  it('所有可静态解析的 t() 键都存在于 en-US 文案或本地补充层', () => {
    const report = [...missing].map(([key, files]) => `${key}  ← ${[...files].join(', ')}`);
    expect(report).toEqual([]);
  });

  it('扫描覆盖面不倒退：服务端 getTranslations 与无参 useTranslations 均被纳入', () => {
    // 下限取当前实测（154 个文件、2 个无法解析）附近的保守值，防止解析器回退成「什么都不查」也全绿。
    expect(scanned).toBeGreaterThanOrEqual(140);
    expect(unboundFiles).toBeLessThanOrEqual(5);
  });
});
