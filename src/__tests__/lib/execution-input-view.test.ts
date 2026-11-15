/**
 * 执行日志的输入打码视图（cloud#754，ADR 0042 §12 F9）。
 *
 * 分类（声明树 + `@pii` 标记）与 aster-api `InputClassifier` 同一推导：从被执行版本的 Core IR 取入口 Rule 的参数类型；
 * 打码与 aster-api `InputViewRenderer` 同一规则（§11 D2 表格 + §12 D4）。路径以参数名为前缀（执行输入就是
 * `{ 参数名: 值 }`），不带 `context.`。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  classifyExecutionInput,
  clearExecutionInputClassificationCache,
  INPUT_MASK_RULES,
  renderMaskedExecutionInput,
  resolveExecutionInputClassification,
  type InputClassification,
} from '@/lib/execution-input/input-view';

const SOURCE = [
  'Module demo.pii.',
  '',
  'Define LineItem has sku as Text, note as @pii(L1, note) Text.',
  'Define Applicant has amount as Decimal, email as @pii(L2, email) Text, items as List of LineItem, tags as List of Text, phones as List of @pii(L3, phone) Text, nick.',
  '',
  'Rule check given applicant as Applicant, score as Int, produce Bool:',
  '  Return applicant.amount greater than 10.',
  '',
].join('\n');

function classify(functionName = 'check'): InputClassification {
  const c = resolveExecutionInputClassification({ source: SOURCE, locale: 'en-US', aliasSet: null }, functionName);
  expect(c).not.toBeNull();
  return c!;
}

const UNKNOWN = { $pii: { level: 'unknown' } };

beforeEach(() => clearExecutionInputClassificationCache());

describe('classifyExecutionInput —— 与 aster-api InputClassifier 同一推导', () => {
  it('声明树：记录字段 `.`、记录列表 `[]`、标量列表是叶子；源码未标注类型的字段不进声明树', () => {
    const c = classify();
    expect(c.declared).toEqual([
      'applicant.amount',
      'applicant.email',
      'applicant.items[].note',
      'applicant.items[].sku',
      'applicant.phones',
      'applicant.tags',
      'score',
    ]);
  });

  it('@pii 标记带级别与类别，来源恒为 ir', () => {
    expect(classify().marks).toEqual([
      { path: 'applicant.email', level: 'L2', category: 'email', source: 'ir' },
      { path: 'applicant.items[].note', level: 'L1', category: 'note', source: 'ir' },
      { path: 'applicant.phones', level: 'L3', category: 'phone', source: 'ir' },
    ]);
  });

  it('入口函数不存在、源码解析失败时返回 null（fail-closed）', () => {
    expect(resolveExecutionInputClassification({ source: SOURCE, locale: 'en-US', aliasSet: null }, 'nope')).toBeNull();
    expect(resolveExecutionInputClassification({ source: 'Module broken.\nRule x given', locale: 'en-US', aliasSet: null }, 'x')).toBeNull();
    expect(resolveExecutionInputClassification({ source: SOURCE, locale: 'en-US', aliasSet: null }, null)).toBeNull();
  });

  it('参数名含点或方括号时无法无歧义拆回路径，该参数不产生路径', () => {
    const coreModule = {
      kind: 'Module', schemaVersion: 2, name: 'm', profile: null, origin: {},
      decls: [{
        kind: 'Func', name: 'f', typeParams: [], ret: { kind: 'TypeName', name: 'Bool' }, retTypeInferred: false,
        annotations: [], retAnnotations: [], effects: [],
        params: [
          { name: 'a.b', type: { kind: 'TypeName', name: 'Int' }, annotations: [], constraints: [], typeInferred: false },
          { name: 'ok', type: { kind: 'TypeName', name: 'Int' }, annotations: [], constraints: [], typeInferred: false },
        ],
      }],
    } as unknown as Parameters<typeof classifyExecutionInput>[0];
    expect(classifyExecutionInput(coreModule, 'f')).toEqual({ declared: ['ok'], marks: [] });
  });
});

describe('renderMaskedExecutionInput —— 与 aster-api InputViewRenderer 同一打码规则（ADR 0042 §11 D2 正反例）', () => {
  it('已声明无 @pii 明文；@pii 替换为 $pii{level, category}，不给长度与前后缀', () => {
    const view = renderMaskedExecutionInput(
      { applicant: { amount: 250000, email: 'a@b.cc' }, score: 7 },
      classify(),
    );
    expect(view).toEqual({
      applicant: { amount: 250000, email: { $pii: { level: 'L2', category: 'email' } } },
      score: 7,
    });
  });

  it('记录列表保留结构：长度可见，每项按字段判定', () => {
    const view = renderMaskedExecutionInput(
      { applicant: { items: [{ sku: 'SKU-1', note: 'secret' }, { sku: 'SKU-2', note: 'x' }] } },
      classify(),
    ) as { applicant: { items: unknown[] } };
    expect(view.applicant.items).toEqual([
      { sku: 'SKU-1', note: { $pii: { level: 'L1', category: 'note' } } },
      { sku: 'SKU-2', note: { $pii: { level: 'L1', category: 'note' } } },
    ]);
  });

  it('记录列表里出现非对象元素 → 该元素整体 unknown', () => {
    const view = renderMaskedExecutionInput({ applicant: { items: [{ sku: 'A' }, 'not-an-object'] } }, classify()) as {
      applicant: { items: unknown[] };
    };
    expect(view.applicant.items).toEqual([{ sku: 'A' }, UNKNOWN]);
  });

  it('未声明的键（含源码未标注类型的字段、未知参数）整个子树 unknown，子树里的键名不展示', () => {
    const view = renderMaskedExecutionInput(
      { applicant: { extra: { 'k@x.io': 1 }, nick: 'Bob' }, stranger: { email: 'a@b.cc' } },
      classify(),
    );
    expect(view).toEqual({ applicant: { extra: UNKNOWN, nick: UNKNOWN }, stranger: UNKNOWN });
    expect(JSON.stringify(view)).not.toContain('k@x.io');
  });

  it('标量列表是一个叶子：@pii 列表整体打码（不暴露长度），无 @pii 列表明文', () => {
    const view = renderMaskedExecutionInput(
      { applicant: { tags: ['vip', 'new'], phones: ['+86 138 0013 8000', '+1 555 010 0100'] } },
      classify(),
    );
    expect(view).toEqual({
      applicant: { tags: ['vip', 'new'], phones: { $pii: { level: 'L3', category: 'phone' } } },
    });
  });

  it('形状与声明不符（声明为标量却传对象）→ unknown；值缺失不补；null 的 @pii 字段仍打码', () => {
    const view = renderMaskedExecutionInput({ applicant: { amount: { v: 1 }, email: null } }, classify());
    expect(view).toEqual({ applicant: { amount: UNKNOWN, email: { $pii: { level: 'L2', category: 'email' } } } });
  });

  it('第二层正则：明文字符串里的邮箱 / 电话被脱敏；规范 UUID 整串豁免', () => {
    const uuid = '123e4567-e89b-12d3-a456-426614174000';
    const view = renderMaskedExecutionInput(
      { applicant: { items: [{ sku: 'mail a@b.cc now' }, { sku: uuid }], tags: ['call +86 138 0013 8000'] } },
      classify(),
    ) as { applicant: { items: Array<{ sku: string }>; tags: string[] } };
    expect(view.applicant.items[0].sku).toBe('mail [REDACTED:EMAIL] now');
    expect(view.applicant.items[1].sku).toBe(uuid);
    expect(view.applicant.tags[0]).not.toContain('138');
  });

  it('无分类（marksSource = none）：参数名可见，值全部 unknown', () => {
    expect(renderMaskedExecutionInput({ applicant: { email: 'a@b.cc' }, score: 1 }, null)).toEqual({
      applicant: UNKNOWN,
      score: UNKNOWN,
    });
  });

  it('输入不是对象（数组、标量、null）→ 整体 unknown', () => {
    expect(renderMaskedExecutionInput(['a@b.cc'], classify())).toEqual(UNKNOWN);
    expect(renderMaskedExecutionInput('a@b.cc', classify())).toEqual(UNKNOWN);
    expect(renderMaskedExecutionInput(null, classify())).toEqual(UNKNOWN);
  });

  it('嵌套超过 8 层 → unknown', () => {
    const declared = ['a.b.c.d.e.f.g.h.i'];
    const deep = { a: { b: { c: { d: { e: { f: { g: { h: { i: 'x' } } } } } } } } };
    const view = JSON.stringify(renderMaskedExecutionInput(deep, { declared, marks: [] }));
    expect(view).toContain('"unknown"');
    expect(view).not.toContain('"x"');
  });

  it('打码规则版本与 aster-api 一致', () => {
    expect(INPUT_MASK_RULES).toBe('v1');
  });
});
