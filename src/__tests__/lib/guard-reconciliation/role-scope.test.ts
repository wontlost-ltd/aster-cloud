// @vitest-environment node
/**
 * 角色签名范围钉（ADR 0061 §3.2 第 4 条）：cloud 只有对账客户端工厂以非 `member` 角色签 aster-api 请求。
 *
 * 遍历 src 下全部 .ts / .tsx（不含测试文件），找出：
 * - 以 ≥ 3 个实参调用 `createPolicyApiClientForUser(` / `createPolicyApiClient(` 的位置（第三参即角色）；
 * - 第三实参不是字面量 `'member'` 的 `new PolicyApiClient(`。
 * 前者只允许出现在 `src/lib/guard-reconciliation/access.ts`；后者只允许是两个转发工厂的定义体（原样转发自己的
 * `userRole` 形参），且它们的缺省角色仍是 member。扫描前先在已知调用点上校验实参计数，防止解析失效而假通过。
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '../../../..');
const SRC = join(ROOT, 'src');
const ACCESS = 'src/lib/guard-reconciliation/access.ts';
const IDENTITY = 'src/lib/policy-api-identity.ts';
const POLICY_API = 'src/services/policy/policy-api.ts';

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      out.push(...sourceFiles(p));
    } else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) && !name.endsWith('.d.ts')) {
      out.push(p);
    }
  }
  return out;
}

/** 把注释替换为空格（保留字符串与模板），使注释里的示例调用不被计入。 */
function stripComments(src: string): string {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i++;
      out += ' ';
    } else if (c === "'" || c === '"' || c === '`') {
      const start = i;
      i++;
      while (i < src.length && src[i] !== c) i += src[i] === '\\' ? 2 : 1;
      out += src.slice(start, i + 1);
    } else {
      out += c;
    }
  }
  return out;
}

/** 从 `(` 之后切出顶层实参（跳过字符串、模板与嵌套括号）；返回去空白的实参文本。 */
function argsAt(src: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = open + 1; i < src.length; i++) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') {
      const start = i;
      i++;
      while (i < src.length && src[i] !== c) i += src[i] === '\\' ? 2 : 1;
      cur += src.slice(start, i + 1);
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) {
        if (cur.trim()) args.push(cur.trim());
        return args;
      }
      depth--;
    }
    if (c === ',' && depth === 0) {
      args.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  throw new Error('unbalanced call');
}

interface Call {
  file: string;
  callee: string;
  args: string[];
  isDefinition: boolean;
}

function scan(file: string): Call[] {
  const src = stripComments(readFileSync(file, 'utf8'));
  const calls: Call[] = [];
  const re = /(new\s+PolicyApiClient|\bcreatePolicyApiClientForUser|\bcreatePolicyApiClient)\s*(?:<[^>]*>)?\(/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const isDefinition = /function\s+$/.test(src.slice(Math.max(0, m.index - 20), m.index));
    calls.push({
      file: relative(ROOT, file),
      callee: m[1].replace(/\s+/g, ' '),
      args: argsAt(src, m.index + m[0].length - 1),
      isDefinition,
    });
  }
  return calls;
}

const ALL = sourceFiles(SRC).flatMap(scan);

describe('非 member 角色签名的范围（ADR 0061 §3.2）', () => {
  it('解析自检：已知调用点的实参个数与第三实参', () => {
    const inbox = ALL.filter((c) => c.file === 'src/lib/approvals-inbox.ts' && c.callee === 'new PolicyApiClient');
    expect(inbox.map((c) => c.args)).toEqual([['tenant.id', 'userId', "'member'", "'unknown'", 'roles']]);
    const issuers = ALL.filter((c) => c.file === 'src/app/api/fact-issuers/[tenantId]/route.ts');
    expect(issuers.map((c) => [c.callee, c.args.length])).toEqual([['createPolicyApiClientForUser', 2]]);
    const access = ALL.filter((c) => c.file === ACCESS);
    expect(access.map((c) => [c.callee, c.args])).toEqual([
      ['createPolicyApiClientForUser', ['tenantId', 'userId', 'access.role']],
    ]);
    expect(ALL.length).toBeGreaterThan(20);
  });

  it('以第三实参（角色）调用 createPolicyApiClientForUser / createPolicyApiClient 的只有 access.ts', () => {
    const offenders = ALL.filter(
      (c) => !c.isDefinition && c.callee !== 'new PolicyApiClient' && c.args.length >= 3,
    );
    expect([...new Set(offenders.map((c) => c.file))]).toEqual([ACCESS]);
  });

  it("new PolicyApiClient 的第三实参不是 'member' 的，只有两个转发工厂原样转发自己的 userRole 形参", () => {
    const offenders = ALL.filter(
      (c) => c.callee === 'new PolicyApiClient' && c.args.length >= 3 && c.args[2] !== "'member'",
    );
    expect(offenders.map((c) => [c.file, c.args[2]]).sort()).toEqual([
      [IDENTITY, 'userRole'],
      [POLICY_API, 'userRole'],
    ]);
  });

  it('转发工厂与客户端构造器的缺省角色仍是 member', () => {
    const identity = ALL.find((c) => c.file === IDENTITY && c.isDefinition && c.callee === 'createPolicyApiClientForUser');
    expect(identity?.args[2]).toBe("userRole = 'member'");
    const factory = ALL.find((c) => c.file === POLICY_API && c.isDefinition && c.callee === 'createPolicyApiClient');
    expect(factory?.args[2]).toBe('userRole?: string');
    const policyApi = readFileSync(join(ROOT, POLICY_API), 'utf8');
    expect(policyApi).toMatch(/private readonly userRole: string = 'member'/);
  });
});
