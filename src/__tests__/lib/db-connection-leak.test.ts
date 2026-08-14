// createDb/getDb 的连接泄漏防护（issue #383）。
//
// ## 被修复的 bug
//
// 本地 dev 跑 UI 测试跑到一半，页面开始大面积 500，界面表现为「无法加载版本源码」
// + diff 显示 +0/-0——**看起来像版本详情接口的 bug**，实际是 postgres 连接被打满，
// 任何 query 都失败。真实根因有两条，缺一条都堵不住：
//
// 1. `let localDevDb` 是**模块级变量**。注释写着「避免热重载时连接泄漏」，但
//    Next.js 的 HMR 会丢弃并重新求值整个模块，模块级变量随之复位成 null，
//    于是每次热重载新建一个 pool，旧 pool 无人 .end()。
//    实测：12 次热重载 = +12 条常驻连接，线性且无上限，直到 max_connections。
//    → 修法：挂 globalThis，跨模块重新求值存活。
//
// 2. `postgres()` 未设 `idle_timeout`，空闲连接永不归还。
//    → 修法：idle_timeout: 20，把「漏掉 end()」从永久泄漏降级为短暂占用。
//
// ## 测试边界（诚实声明）
//
// 本文件断言的是**配置不变量**，不是真实连接数——真实连接数需要一个活的
// postgres，而单测不应依赖外部服务（本仓 vitest 无 DB fixture）。
// 真实泄漏与修复由本地 Podman 全栈实测证明，数据记录在 issue #383：
//   修复前：12 次模拟热重载 → 连接 10→22，增量 12，永不回落
//   修复后：同样 12 次 → 峰值 22，等过 idle_timeout 后回到 10，残留增量 0
//
// 所以这里守的是「**别把这两个配置改回去**」，而不是「连接不会泄漏」——
// 后者本测试无力证明，写成那样就是名不副实的假绿。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';

const SOURCE = readFileSync(join(process.cwd(), 'src/db/index.ts'), 'utf8');

describe('createDb 连接泄漏防护（issue #383）', () => {
  it('postgres() 必须设 idle_timeout——否则空闲连接永不归还', () => {
    expect(SOURCE).toMatch(/idle_timeout:\s*\d+/);
  });

  it('本地 dev 单例必须挂在 globalThis 上——模块级 let 撑不过 HMR', () => {
    // ★这条是本 issue 的**主**修法。只加 idle_timeout 不够：
    //   idle_timeout 让泄漏的连接 20s 后归还，但热重载频繁时仍会持续堆积。
    expect(SOURCE).toMatch(/globalThis as unknown as/);
    expect(SOURCE).toMatch(/__asterLocalDevDb/);
  });

  it('不得退回模块级 let localDevDb', () => {
    // 断言的是**声明**本身消失，而不是「文件里不出现这个词」——
    // 注释里正在解释为什么不能用它，按裸词断言会被自己的注释判负。
    expect(SOURCE).not.toMatch(/^\s*let\s+localDevDb/m);
  });
});
