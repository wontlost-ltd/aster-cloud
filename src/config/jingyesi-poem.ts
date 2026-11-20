/**
 * 《静夜思》（李白，公有领域）的规范源码与显示排版：演示页 /demos/poem 与「静夜思」特色模板共用这一份，
 * 不各自复制（ADR 0060 §8：模板源码与演示 `POEM_ZH.source` 逐字节相同）。
 *
 * 源码即原诗词序。zh 词法把相邻汉字连成一个 token，四个领字（床前 / 疑是 / 举头 / 低头）要当关键词别名
 * 识别，后面必须带一个空格，诗句的部分标点也要换成语法所需的结构标点。排版把这些空格隐去、把结构标点换回
 * 原诗标点，读者看到的是一字不差的原诗；编译的仍是 toCanonical(JINGYESI_LAYOUT) === JINGYESI_SOURCE。
 *
 * 结构 span 只含空格与标点（满足 ADR 0058 §7.5 的全部规则）；领字与诗句名字都是内容 span，原样可见。
 * 本模块只依赖类型，浏览器与服务端都可引入，不带入演示页的词法表。
 */
import type { LayoutSpan, PolicyLayout } from '@aster-cloud/aster-lang-ts/layout';

/**
 * 规范源码：带空格与结构标点的可编译写法，以换行结尾。
 * 末尾换行是编译输入的一部分（Core IR 保留行号，末行换行改变末尾 span），与 ts / core / aster-api 三侧证明
 * 所用源码逐字节相同，positionFreeSha256 因而一致。
 */
export const JINGYESI_SOURCE = `床前 明月光。
疑是 地上霜，举头 望明月：
  低头 思故乡。
`;

/** 原诗：toDisplay(JINGYESI_LAYOUT) 的结果，四句各占一行。 */
export const JINGYESI_POEM = '床前明月光，\n疑是地上霜。\n举头望明月，\n低头思故乡。';

const SP: LayoutSpan = { canonical: ' ', display: '' };

export const JINGYESI_LAYOUT: PolicyLayout = {
  v: 1,
  spans: [
    { text: '床前' }, SP, { text: '明月光' }, { canonical: '。\n', display: '，\n' },
    { text: '疑是' }, SP, { text: '地上霜' }, { canonical: '，', display: '。\n' },
    { text: '举头' }, SP, { text: '望明月' }, { canonical: '：\n  ', display: '，\n' },
    { text: '低头' }, SP, { text: '思故乡' }, { canonical: '。\n', display: '。' },
  ],
};
