import { describe, it, expect } from 'vitest';
import { defaultControlRegistry } from '@/services/evidence/control-registry';
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
