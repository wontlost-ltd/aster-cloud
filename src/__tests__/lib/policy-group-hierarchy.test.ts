/**
 * 策略分组父子关系防环 / 容环（#478）。
 */
import { describe, it, expect, vi } from 'vitest';
import {
  MAX_GROUP_DEPTH,
  buildGroupTree,
  resolveTreeParents,
  wouldCreateParentCycle,
} from '@/lib/policy-group-hierarchy';

/** 用一张「分组 → 当前 parentId」表模拟库，并记录查询次数。 */
function dbOf(parents: Record<string, string | null>) {
  const lookup = vi.fn(async (id: string) => (id in parents ? parents[id] : undefined));
  return lookup;
}
const edits = (pairs: Array<[string, string | null]>) => new Map(pairs);

describe('wouldCreateParentCycle', () => {
  it('★一批改动里 A→B、B→A：成环', async () => {
    const lookup = dbOf({ A: null, B: null });
    expect(await wouldCreateParentCycle(edits([['A', 'B'], ['B', 'A']]), lookup)).toBe(true);
  });

  it('★挂到自己下面：成环', async () => {
    expect(await wouldCreateParentCycle(edits([['A', 'A']]), dbOf({ A: null }))).toBe(true);
  });

  it('★挂到自己的孙子下（库里 C→B→A）：成环', async () => {
    const lookup = dbOf({ A: null, B: 'A', C: 'B' });
    expect(await wouldCreateParentCycle(edits([['A', 'C']]), lookup)).toBe(true);
  });

  it('正常移动与移到顶层：不成环', async () => {
    const lookup = dbOf({ A: null, B: 'A', C: null });
    expect(await wouldCreateParentCycle(edits([['B', 'C']]), lookup)).toBe(false);
    expect(await wouldCreateParentCycle(edits([['B', null]]), lookup)).toBe(false);
    expect(await wouldCreateParentCycle(edits([]), lookup)).toBe(false);
  });

  it('一批改动互相配合（先把 B 移走，再把 A 挂到 B 下）：不成环', async () => {
    const lookup = dbOf({ A: null, B: 'A' });
    expect(await wouldCreateParentCycle(edits([['B', null], ['A', 'B']]), lookup)).toBe(false);
  });

  it('★库里已有环 X↔Y，把 A 挂到 X 下：判定成环并停下（不死循环）', async () => {
    const lookup = dbOf({ A: null, X: 'Y', Y: 'X' });
    expect(await wouldCreateParentCycle(edits([['A', 'X']]), lookup)).toBe(true);
    // 每个分组至多查一次
    expect(lookup.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('库里已有环但不在父链上：不影响正常移动', async () => {
    const lookup = dbOf({ A: null, B: null, X: 'Y', Y: 'X' });
    expect(await wouldCreateParentCycle(edits([['A', 'B']]), lookup)).toBe(false);
  });

  it('父分组不存在（查不到）视为顶层', async () => {
    expect(await wouldCreateParentCycle(edits([['A', 'ghost']]), dbOf({ A: null }))).toBe(false);
  });

  it('父链超过深度上限时按成环处理（损坏数据兜底）', async () => {
    const parents: Record<string, string | null> = { n0: null };
    for (let i = 1; i <= MAX_GROUP_DEPTH + 5; i++) parents[`n${i}`] = `n${i - 1}`;
    const deepest = `n${MAX_GROUP_DEPTH + 5}`;
    expect(await wouldCreateParentCycle(edits([['A', deepest]]), dbOf({ ...parents, A: null }))).toBe(true);
    // 正常深度不受影响
    expect(await wouldCreateParentCycle(edits([['A', 'n10']]), dbOf({ ...parents, A: null }))).toBe(false);
  });
});

describe('resolveTreeParents', () => {
  it('★环上的分组、挂在环下的分组都按顶层处理；正常分组保留父分组', () => {
    const resolved = resolveTreeParents([
      { id: 'root', parentId: null },
      { id: 'child', parentId: 'root' },
      { id: 'X', parentId: 'Y' },
      { id: 'Y', parentId: 'X' },
      { id: 'underCycle', parentId: 'X' },
      { id: 'self', parentId: 'self' },
    ]);
    expect(resolved.get('root')).toBeNull();
    expect(resolved.get('child')).toBe('root');
    expect(resolved.get('X')).toBeNull();
    expect(resolved.get('Y')).toBeNull();
    expect(resolved.get('underCycle')).toBeNull();
    expect(resolved.get('self')).toBeNull();
  });

  it('父分组不在列表里时保留声明值（由调用方按「父不在列表」处理为顶层）', () => {
    expect(resolveTreeParents([{ id: 'a', parentId: 'elsewhere' }]).get('a')).toBe('elsewhere');
  });
});

describe('buildGroupTree', () => {
  type Node = { id: string; children: Node[] };
  const toNode = (g: { id: string }): Node => ({ id: g.id, children: [] });

  it('按父分组挂载，保持输入顺序', () => {
    const tree = buildGroupTree(
      [
        { id: 'a', parentId: null },
        { id: 'a1', parentId: 'a' },
        { id: 'b', parentId: null },
        { id: 'a2', parentId: 'a' },
      ],
      toNode,
    );
    expect(tree.map((n) => n.id)).toEqual(['a', 'b']);
    expect(tree[0].children.map((n) => n.id)).toEqual(['a1', 'a2']);
  });

  it('★有环时环上分组落在顶层，结果可以 JSON 序列化', () => {
    const tree = buildGroupTree(
      [
        { id: 'X', parentId: 'Y' },
        { id: 'Y', parentId: 'X' },
        { id: 'Z', parentId: 'X' },
      ],
      toNode,
    );
    expect(tree.map((n) => n.id).sort()).toEqual(['X', 'Y', 'Z']);
    expect(() => JSON.stringify(tree)).not.toThrow();
  });

  it('父分组不在列表里时落在顶层', () => {
    expect(buildGroupTree([{ id: 'a', parentId: 'elsewhere' }], toNode).map((n) => n.id)).toEqual(['a']);
  });
});
