/**
 * 一次性修复脚本：把已存策略里的 `is <` / `is >=` 等**非法组合**改写成合法 CNL。
 *
 * <h2>为什么需要它</h2>
 *
 * CNL 里 `is` 是可选连接词，只能接**文字**比较词：
 *   合法：`is less than 18` / `less than 18` / `< 18`
 *   非法：`is < 18`（`is` 后直接跟符号）
 *
 * 早期由 AI 生成的策略把两种风格拼在了一起（系统提示词并列列出文字与符号
 * 两组运算符、却从不提 `is`，示例自身也混用——已在 aster-api#241 修复）。
 * 这类源码**存进了库**，直到执行时才报语法错：
 *
 *   行 15 第 25 列：`is` 后面不能直接跟符号（如 `is < 18`）…
 *
 * 提示词与编译门禁的修复只能**阻止新增**，无法修复**存量行**——本脚本补这一刀。
 *
 * <h2>行为</h2>
 *
 * 1. 扫 Policy.content 与 PolicyVersion.source 里匹配 `is\s*[<>!]=?` 的行
 * 2. 按符号改写成等价文字形式（见 REWRITES）
 * 3. **默认 dry-run**：只打印将要改动的行，不写库
 *    加 `--apply` 才真正写入
 *
 * ★为什么默认不写：这是在改**用户自己写的业务源码**，
 *   必须先让人看过 diff 再决定。
 *
 * 调用：
 *   DATABASE_URL=postgresql://user:pwd@host:5432/aster_cloud \
 *     pnpm tsx scripts/repair-is-symbol-policies.ts            # 预演
 *   DATABASE_URL=... pnpm tsx scripts/repair-is-symbol-policies.ts --apply
 *   DATABASE_URL=... pnpm tsx scripts/repair-is-symbol-policies.ts --apply --id <policyId>
 */
import postgres from 'postgres';

/** 符号 → 文字。★顺序重要：先长后短，否则 `<=` 会被 `<` 先吃掉。 */
const REWRITES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bis\s*<=\s*/g, 'is at most '],
  [/\bis\s*>=\s*/g, 'is at least '],
  [/\bis\s*!=\s*/g, 'is not equal to '],
  [/\bis\s*<\s*/g, 'is less than '],
  [/\bis\s*>\s*/g, 'is greater than '],
];

/** `is` 后紧跟符号的检测式（与 REWRITES 覆盖范围一致）。 */
const DETECT = /\bis\s*[<>!]=?/;

export function repairSource(src: string): string {
  return REWRITES.reduce((acc, [re, to]) => acc.replace(re, to), src);
}

function diffLines(before: string, after: string): string[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const out: string[] = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) out.push(`      ${i + 1}: - ${a[i]}\n      ${i + 1}: + ${b[i]}`);
  }
  return out;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  const apply = process.argv.includes('--apply');
  const idIdx = process.argv.indexOf('--id');
  const onlyId = idIdx >= 0 ? process.argv[idIdx + 1] : null;

  const sql = postgres(url, { max: 1, idle_timeout: 5, connect_timeout: 10 });
  let policyHits = 0;
  let versionHits = 0;

  try {
    const policies = onlyId
      ? await sql`SELECT id, name, content FROM "Policy" WHERE id = ${onlyId}`
      : await sql`SELECT id, name, content FROM "Policy" WHERE content ~ 'is[[:space:]]*[<>!]=?'`;

    console.log(`\n== Policy: 命中 ${policies.length} 行 ==`);
    for (const p of policies) {
      if (!p.content || !DETECT.test(p.content)) continue;
      const fixed = repairSource(p.content);
      if (fixed === p.content) continue;
      policyHits++;
      console.log(`\n  [${p.id}] ${p.name}`);
      diffLines(p.content, fixed).forEach((l) => console.log(l));
      if (apply) {
        await sql`UPDATE "Policy" SET content = ${fixed} WHERE id = ${p.id}`;
        console.log('      → 已写入');
      }
    }

    // 版本表同修：执行读的是 Policy.content，但回滚/对比会读 PolicyVersion.source，
    // 只修一边会让「回滚到上一版」重新引入坏源码。
    const versions = onlyId
      ? await sql`SELECT id, "policyId", version, source FROM "PolicyVersion" WHERE "policyId" = ${onlyId}`
      : await sql`SELECT id, "policyId", version, source FROM "PolicyVersion" WHERE source ~ 'is[[:space:]]*[<>!]=?'`;

    console.log(`\n== PolicyVersion: 命中 ${versions.length} 行 ==`);
    for (const v of versions) {
      if (!v.source || !DETECT.test(v.source)) continue;
      const fixed = repairSource(v.source);
      if (fixed === v.source) continue;
      versionHits++;
      console.log(`  [${v.policyId}] v${v.version}  (${diffLines(v.source, fixed).length} 行)`);
      if (apply) {
        await sql`UPDATE "PolicyVersion" SET source = ${fixed} WHERE id = ${v.id}`;
      }
    }

    console.log(
      `\n  合计: Policy ${policyHits} 条 / PolicyVersion ${versionHits} 条` +
        (apply ? ' —— 已写入' : ' —— 预演（加 --apply 才写库）'),
    );
  } finally {
    await sql.end();
  }
}

// 作为脚本运行时才执行 main（被测试 import 时不连库）
if (process.argv[1]?.endsWith('repair-is-symbol-policies.ts')) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
