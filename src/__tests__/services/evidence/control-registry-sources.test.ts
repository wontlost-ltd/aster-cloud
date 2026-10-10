import { describe, it, expect } from 'vitest';
import { defaultControlRegistry, localizedTitle, profileTitle } from '@/services/evidence/control-registry';
import { isEvidenceSource } from '@/services/evidence/regulatory-mapping';

// 不依赖兄弟仓、在 CI 中必跑：类型断言 `raw as ControlRegistryData` 会掩盖副本里的未知来源，
// 一旦出现未知来源，mapRegulatory 会在每次导出时抛错，故在此对内置副本做结构自检
describe('内置控制注册表副本', () => {
  const { controls, clauses } = defaultControlRegistry;

  it('每个条款的 evidenced / partial 来源都是映射引擎的已知来源', () => {
    const unknown = clauses.flatMap((cl) =>
      [...cl.evidenced, ...cl.partial].filter((s) => !isEvidenceSource(s)).map((s) => `${cl.control} ${cl.clause}: ${s}`),
    );
    expect(unknown).toEqual([]);
  });

  it('每个条款引用的控制键都已登记', () => {
    const keys = new Set(controls.map((c) => c.key));
    expect(clauses.filter((cl) => !keys.has(cl.control)).map((cl) => cl.control)).toEqual([]);
  });

  it('同一控制键下条款 id 唯一', () => {
    const ids = clauses.map((cl) => `${cl.control} ${cl.clause}`);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  });

  it('isEvidenceSource 拒绝未知名与原型链上的名字', () => {
    expect(isEvidenceSource('reviewers.guard.two')).toBe(true);
    expect(isEvidenceSource('reviewers.guard.three')).toBe(false);
    expect(isEvidenceSource('toString')).toBe(false);
  });
});

describe('内置注册表的治理档案（ADR 0046 §3）', () => {
  const { frameworks, profiles } = defaultControlRegistry;

  it('档案 id 唯一，且 frameworks 要求均为已登记框架', () => {
    const ids = profiles.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    const known = new Set(frameworks.map((f) => f.id));
    expect(profiles.flatMap((p) => p.requires.frameworks).filter((f) => !known.has(f))).toEqual([]);
  });

  it('profileTitle：已登记取注册表标题，未登记三语均为 id', () => {
    expect(profileTitle('governed').zh).toBe('受治理规则');
    expect(profileTitle('local-x')).toEqual({ en: 'local-x', zh: 'local-x', de: 'local-x' });
  });

  it('localizedTitle：hi 等未覆盖 locale 回退英文', () => {
    const title = { en: 'E', zh: 'Z', de: 'D' };
    expect([localizedTitle(title, 'zh'), localizedTitle(title, 'de'), localizedTitle(title, 'hi')]).toEqual(['Z', 'D', 'E']);
  });
});
