// 模型大纲（ADR 0058 §8.3）：结构体（含字段）、类型别名、导入别名，位置取自 AST span。
import { describe, it, expect } from 'vitest';
import { EN_US, ZH_CN } from '@aster-cloud/aster-lang-ts/browser';
import { buildModelOutline } from '@/lib/structured-authoring/outline';

const EN_SOURCE = [
  'Module demo.',
  '',
  'Use lib as L.',
  '',
  'Use plain.',
  '',
  'Define Person with',
  '  name as Text and',
  '  age as maybe Int.',
  '',
  'Type Score as Int.',
  '',
].join('\n');

describe('buildModelOutline', () => {
  it('导入别名：Use lib as L. → alias L、module lib；无别名的导入不列出', () => {
    const outline = buildModelOutline(EN_SOURCE, EN_US)!;
    expect(outline.imports).toHaveLength(1);
    expect(outline.imports[0].alias).toBe('L');
    expect(outline.imports[0].module).toBe('lib');
    expect(outline.imports[0].span.start).toEqual({ line: 3, col: 1 });
  });

  it('结构体字段带 span，类型按源码原文', () => {
    const outline = buildModelOutline(EN_SOURCE, EN_US)!;
    expect(outline.structs).toHaveLength(1);
    const person = outline.structs[0];
    expect(person.name).toBe('Person');
    expect(person.span.start).toEqual({ line: 7, col: 1 });
    expect(person.fields.map((f) => [f.name, f.type])).toEqual([
      ['name', 'Text'],
      ['age', 'maybe Int'],
    ]);
    expect(person.fields[1].span.start).toEqual({ line: 9, col: 3 });
    expect(person.fields[1].span.end).toEqual({ line: 9, col: 19 });
  });

  it('类型别名：名字、目标与声明位置', () => {
    const outline = buildModelOutline(EN_SOURCE, EN_US)!;
    expect(outline.typeAliases).toEqual([
      { name: 'Score', target: 'Int', span: { start: { line: 11, col: 1 }, end: { line: 11, col: 19 } } },
    ]);
  });

  it('推断类型的字段显示本地化内置类型名', () => {
    const outline = buildModelOutline('模块 demo。\n\n定义 人员 包含 年龄。\n', ZH_CN)!;
    expect(outline.structs[0].fields.map((f) => [f.name, f.type])).toEqual([['年龄', '整数']]);
  });

  it('中文源码的导入别名', () => {
    const outline = buildModelOutline('模块 demo。\n\n引用 库 作为 甲。\n', ZH_CN)!;
    expect(outline.imports.map((i) => [i.alias, i.module])).toEqual([['甲', '库']]);
  });

  it('语法错误返回 null', () => {
    expect(buildModelOutline('Module demo.\n\nDefine Person with name: Text.\n', EN_US)).toBeNull();
  });

  it('空源码返回空大纲', () => {
    expect(buildModelOutline('', EN_US)).toEqual({ structs: [], enums: [], typeAliases: [], imports: [] });
  });

  it('收集枚举声明（供类型下拉使用）', () => {
    const outline = buildModelOutline('Module demo.\n\nDefine Level as one of Low, High.\n', EN_US);
    expect(outline?.enums.map((e) => e.name)).toEqual(['Level']);
  });
});
