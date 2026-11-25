// aster-lang-ts 3.7.0（eco-1.0.55）对 cloud 可见的行为变化：随包引擎的接受 / 拒绝集合与
// cloud 的诊断呈现（词汇诊断链接）在这里钉住，升级时一眼看出哪条变了。
import { describe, it, expect } from 'vitest';
import { compileAndTypecheck, DE_DE, EN_US, ZH_CN, type Lexicon } from '@aster-cloud/aster-lang-ts/browser';
import { TS_VERSION } from '@aster-cloud/aster-lang-ts/package-check';
import { vocabularyDiagnosticHelp } from '@/lib/vocabulary-diagnostic';

interface Diagnostic {
  code?: string;
  message: string;
  data?: unknown;
}

function run(source: string, lexicon: Lexicon): { ok: boolean; codes: string[]; all: Diagnostic[] } {
  const r = compileAndTypecheck(source, { lexicon }) as {
    parseErrors?: Diagnostic[];
    resolutionDiagnostics?: Diagnostic[];
    typeErrors?: Array<Diagnostic & { severity?: string }>;
  };
  const errors = [
    ...(r.parseErrors ?? []),
    ...(r.resolutionDiagnostics ?? []),
    ...(r.typeErrors ?? []).filter((d) => d.severity === 'error'),
  ];
  return { ok: errors.length === 0, codes: errors.map((d) => d.code ?? ''), all: errors };
}

const enRule = (body: string) => `Module m.\n\nRule f given x as Int, produce Int:\n${body}`;

describe('aster-lang-ts 3.7.0 行为变化', () => {
  it('随包 aster-lang-ts 为 3.7.0', () => {
    expect(TS_VERSION).toBe('3.7.0');
  });

  it('en `The result is x.` 与 de `Ergebnis ist x.` 可编译（此前 E064）', () => {
    expect(run(enRule('  The result is x.\n'), EN_US).codes).toEqual([]);
    const de = 'Modul m.\n\nRegel f gegeben x als Ganzzahl, liefert Ganzzahl:\n  Ergebnis ist x.\n';
    expect(run(de, DE_DE).codes).toEqual([]);
  });

  it('`result is` 的分隔只认空格与 tab：换行不改写，按语法报错', () => {
    expect(run(enRule('  The result\tis x.\n'), EN_US).codes).toEqual([]);
    expect(run(enRule('  The result\n  is x.\n'), EN_US).ok).toBe(false);
  });

  it('缩进的顶层类型声明报 E063（此前编辑器接受）', () => {
    expect(run('Module m.\n\n  Type Email as Text.\n', EN_US).codes).toContain('E063');
    expect(run('模块 m。\n\n  类型 邮箱 作为 文本。\n', ZH_CN).codes).toContain('E063');
  });

  it('类型别名右侧查不到的类型报 E800，并带出词汇页链接所需的写法', () => {
    const { codes, all } = run('Modul m.\n\nTyp Betrag als Unbekannt.\n', DE_DE);
    expect(codes).toEqual(['E800']);
    expect(vocabularyDiagnosticHelp(all[0]!)?.written).toBe('Unbekannt');
  });

  it('类型别名之前的注解被拒绝', () => {
    expect(run('Module m.\n\n@pii(L1, email) Type Email as Text.\n', EN_US).ok).toBe(false);
  });

  it('块头之后可以先空行再写块', () => {
    const source = enRule('  Match x:\n\n    When 1, Return 2.\n');
    expect(run(source, EN_US).codes).toEqual([]);
  });
});
