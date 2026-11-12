import { describe, it, expect } from 'vitest';
import { defaultControlRegistry, localizedTitle, profileTitle, type ControlRegistryData } from '@/services/evidence/control-registry';
import { isEvidenceSource, mapRegulatory } from '@/services/evidence/regulatory-mapping';
import { collectProfiles } from '@/services/evidence/bundle';
import type { EvidenceEntry } from '@/services/evidence/types';

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

// ADR 0046 §11 D1（R62 X1）：注册表 1.2.0 起 requires 会多出 verifiedInputs 等新键。
// cloud 读取注册表的路径（档案标题、证据导出的档案清单与法规映射）必须忽略未知键：不抛错、结果不变。
describe('注册表 requires 含未知键时读取结果不变（R62 X1）', () => {
  const withUnknownKeys = {
    ...defaultControlRegistry,
    profiles: defaultControlRegistry.profiles.map((p) => ({
      ...p,
      requires: { ...p.requires, verifiedInputs: true, futureKey: {} },
    })),
  } as unknown as ControlRegistryData;
  const profileIds = [...defaultControlRegistry.profiles.map((p) => p.id), 'local-x'];

  function entry(profile: string | null): EvidenceEntry {
    return {
      executionId: 'x', policyId: 'p', policyVersion: 1, policyVersionRowId: 'pv', decision: 'approved',
      canonicalInputHash: 'i', canonicalOutputHash: 'o', traceHash: 't', canonicalizationVersion: 'v',
      toolchain: { source: null, runtime: null }, replayabilityStatus: null, replayabilityReasons: null,
      reasonCodes: null, source: 'api', durationMs: 1, createdAt: '2026-10-09T00:00:00.000Z',
      outcome: 'ALLOW', ruleId: 'r1', controls: ['EU_AI_ACT:ART14'], agent: null, evidenceCorrelationId: null,
      receipt: { status: 'legacy' }, reviewers: [], whatIf: null, profile,
    };
  }
  const entries = [...profileIds.map(entry), entry(null)];

  it('内置副本至少有一个档案，用例才有意义', () => {
    expect(defaultControlRegistry.profiles.length).toBeGreaterThan(0);
  });

  it('profileTitle 经注入的注册表读取，标题与内置副本相同', () => {
    for (const id of profileIds) {
      expect(profileTitle(id, withUnknownKeys), id).toEqual(profileTitle(id));
    }
  });

  it('证据导出：collectProfiles 与 mapRegulatory 结果不变', () => {
    expect(collectProfiles(entries, withUnknownKeys)).toEqual(collectProfiles(entries));
    expect(mapRegulatory(entries, withUnknownKeys)).toEqual(mapRegulatory(entries));
    expect(mapRegulatory([], withUnknownKeys)).toEqual(mapRegulatory([]));
  });
});
