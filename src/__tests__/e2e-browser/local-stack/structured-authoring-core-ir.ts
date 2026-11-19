/**
 * structured-authoring.spec.ts 的忠实性比对子进程（ADR 0058 §8.2 验收）：
 * 「带词汇编译源码」与「不带词汇编译预览文本」的 Core IR（去掉 origin）是否相同。
 *
 * 词汇按编辑器同一规则组装（resolvePolicyVocabularyFromRows，作用域 = 源码引用的分组），
 * 编译器与页面同一版本（cloud 依赖的 @aster-cloud/aster-lang-ts）。
 *
 * 为什么是子进程：aster-lang-ts 的 `./browser` 子路径只声明 `import` 条件，Playwright 以 CJS 加载用例时
 * 解析不到；这里由用例以 `NODE_OPTIONS=--conditions=import tsx` 运行本文件。
 * 输入：stdin JSON `{ source, preview, locale, rows }`；输出：stdout JSON `{ sourceOk, previewOk, equal, diagnostics }`。
 */
import { compile } from '@aster-cloud/aster-lang-ts/browser';
import { getLexicon } from '@/lib/aster-lexicon';
import { resolvePolicyVocabularyFromRows } from '@/lib/domain-vocabulary-scope';
import type { TermLikeRow } from '@/lib/domain-vocabulary-assemble';

interface Input {
  source: string;
  preview: string;
  locale: string;
  rows: TermLikeRow[];
}

function stripOrigin(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripOrigin);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== 'origin')
      .map(([key, v]) => [key, stripOrigin(v)]),
  );
}

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Input;
  const lexicon = getLexicon(input.locale);
  const vocabulary = resolvePolicyVocabularyFromRows(input.rows, { source: input.source, locale: input.locale }) ?? undefined;
  const withVocabulary = compile(input.source, { lexicon, vocabulary });
  const withoutVocabulary = compile(input.preview, { lexicon });
  process.stdout.write(
    JSON.stringify({
      vocabularyInScope: vocabulary !== undefined,
      sourceOk: withVocabulary.success,
      previewOk: withoutVocabulary.success,
      equal: JSON.stringify(stripOrigin(withVocabulary.core)) === JSON.stringify(stripOrigin(withoutVocabulary.core)),
      diagnostics: [withVocabulary.parseErrors, withoutVocabulary.parseErrors],
    }),
  );
}

void main();
