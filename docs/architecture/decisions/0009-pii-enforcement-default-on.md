---
last-reviewed-at: 2026-05-27
owner: '@aster/security-stewards @aster/lang-stewards'
---

# ADR-0009 — PII enforcement 默认启用（跨运行时一致）

**Status**: Accepted
**Date**: 2026-05-27
**Supersedes**: 渐进式启用 PII 检查策略（无版本号；本 ADR 之前的所有 PII 检查行为）
**Implementation**: 一次性切换，无 deprecation 窗口（无真实生产 PII 客户依赖）
**Plan reference**: P0-1 in the comprehensive Aster Lang improvement plan
（综合自 codex backend + frontend analysis 和 Claude 独立 PL 视角）

## Context

Aster Lang 把 PII（Personally Identifiable Information）作为**类型系统一等
公民**——`PiiType<level, category, baseType>` 内置于 Core IR，可以在
类型签名上标记字段为 `PiiType<'L3', 'identity', Text>`，然后通过 flow 分析
检测违规的 sink（HTTP、log、emit）和 downgrade（L3 → L1 赋值）。

这是 Aster 相对 OPA Rego / Cedar / Drools 的**核心差异化护城河**。

### 问题诊断

在 ADR-0009 之前，PII 检查是**opt-in**的：
- `aster-lang-ts/src/typecheck/utils.ts:103` — `shouldEnforcePii()` 依赖
  `globalThis.lspConfig.enforcePiiChecks` 或 `process.env.ENFORCE_PII`
- `aster-lang-ts/src/typecheck/browser.ts:184` — 浏览器路径**完全不实现**
  PII 检查，传 `enforcePii: true` 只发"unsupported"警告

这意味着 Aster 的核心差异化承诺**在生产部署形态下被静默禁用**：

| 部署形态 | PII 检查状态 | 用户体验 |
|---|---|---|
| Node CLI + ENFORCE_PII=true | ✅ 启用 | 与承诺一致 |
| LSP IDE（默认） | ❌ 禁用（除非显式启用） | 同一策略在 IDE 看不到 PII 诊断 |
| Browser Monaco editor | ❌ **完全禁用** | 用户写策略时看不到 PII 违规 |
| Cloudflare Workers (SaaS) | ❌ **完全禁用**（无 process.env） | 生产环境跑的策略没经 PII 检查 |

更糟糕的是，**同一策略在不同运行时报告不同的安全结论**：开发者在 CLI 测试
PII 通过，CI 上 ENFORCE_PII 没设也通过，部署到 Workers 也通过——但实际**没人
跑过 PII 检查**。Aster 的核心卖点变成营销话术。

### 根因分析

`typecheck-pii.ts`（PII flow 分析器本体）**本身环境无关**——它不读
`process.env` 或 `fs`，可以在任何 runtime 跑。可禁用性是历史包袱：早期为了
"避免破坏现有项目"而设的渐进式 opt-in 策略，已不再适用：
- 本质上是把"安全检查"做成可选 → 等同于"安全是 nice-to-have"
- 跨运行时的 drift 是结构性漏洞
- 没有真实生产客户依赖这个 opt-out 行为（核查过）

## Decision

**PII flow 分析永远启用，跨所有运行时一致。**

### 决定 1：删除所有 opt-in 配置

- `shouldEnforcePii()` 退化为 backwards-compat stub，总是返回 `true`
  （deprecated，下一个 major 移除）
- `module.ts` 移除 `if (shouldEnforcePii())` gate，PII 检查无条件运行
- `browser.ts` 删除 "unsupported in browser" 警告路径
- `BrowserTypecheckOptions.enforcePii` 字段保留但标记 `@deprecated`，无效
- `globalThis.lspConfig.enforcePiiChecks` 不再被读

### 决定 2：跨运行时 conformance 测试硬保障

新增 `aster-lang-ts/test/unit/typecheck/pii-cross-runtime-conformance.test.ts`：

- 对相同 Core IR 模块同时跑 `typecheckModule`（Node 路径）和
  `typecheckBrowser`（browser 路径）
- 断言两者返回的 PII 诊断**等价**：相同 codes + 相同 severities + 相同 count
- 覆盖 6 个场景：HTTPS L3 sink / HTTP L2 sink / L3→L1 降级赋值 /
  参数违规 / 无 PII baseline / 空模块
- 元测试保护 `PII_CODES` 集合的完整性（10 个 PII-related codes 全覆盖）

**"等价"的精确含义（P0-R 修订）**：诊断**消息字符串**可以因 locale 不同
而异，但**code + severity + count** 必须一致。这不是 byte-identical 字符串
比较——后者跨实现的等价是 P1 单 parser 真源议题，不在本 ADR 范围。

### 决定 3：Java 端 PII gate 同步移除（P0-R Critical 修复）

ADR-0009 原版漏了 Java 端的镜像问题。codex review 抓到后 P0-R 同步修复：

- `aster-lang-core/src/main/java/aster/core/typecheck/TypeChecker.java` —
  删除 `if (shouldEnforcePii())` gate；`shouldEnforcePii()` 改为 always-true
  stub（`@Deprecated(forRemoval = true)`）
- `aster-api/src/main/java/io/aster/policy/config/PIIConfig.java` —
  默认值从 `false` 改为 `true`，与 production properties 对齐；澄清注释：
  **运行时 PII 保护**（response 脱敏、日志脱敏）与编译时 PII flow 分析
  是两个独立关注点
- `aster-api/src/main/resources/application.properties` — 删除虚假对齐
  "与 ENFORCE_PII 保持一致" 的注释
- 新增 `aster-lang-core/src/test/java/aster/core/typecheck/PiiAlwaysOnConformanceTest.java`
  —— Java 端 PII always-on 合同测试

### 决定 4：分两层

- **编译时类型层 PII 检查**（PiiType 类型标记 + flow 分析）：永远启用，
  跨运行时 byte-identical
- **运行时 PII 保护**（aster-api response 脱敏 + 日志脱敏 + audit
  redaction）：仍可配置（`aster.pii.enforce=false`），默认启用。运行时
  保护有性能/可观察性 trade-off，某些环境（如纯内部 API、调试环境）
  可能合法选择禁用。
- **合规 policy pack**（HIPAA / GDPR / CCPA 具体规则集）：仍 opt-in，
  通过单独机制配置（不在本 ADR 范围；预计 ADR-0016+）

## Why not deprecation window?

需要明确区分**两个独立的 PII 关注点**——本节单独评估两者的 opt-out 依赖：

### 编译时 PII 类型检查（本 ADR 主要范围）

仓库内扫描（2026-05-27 P0-R2 重新验证；命令：
`grep -rn "ENFORCE_PII\|ASTER_ENFORCE_PII\|enforcePiiChecks\|enforcePii:\s*false"
/Users/rpang/IdeaProjects/aster-*`）：

| 入口 | 扫描范围 | 命中数 | 命中位置 |
|---|---|---|---|
| `ENFORCE_PII=false` env | aster-cloud + aster-api + aster-lang-* + aster-deploy | **0** | — |
| `ASTER_ENFORCE_PII=false` env | 同上 | **0** | — |
| `--no-enforce-pii` LSP flag | 所有 launch config / .vscode / IDE settings | **0** | — |
| `enforcePii: false` JS API 调用 | aster-cloud + aster-api + aster-lang-* | **0**（除 fixture/test） | — |
| `globalThis.lspConfig.enforcePiiChecks=false` | 所有仓库 | **0** | — |

**结论（编译时）**：硬切换零生产风险。

### 运行时 PII 保护（aster-api PIIConfig，独立关注点）

这是**与本 ADR 编译时检查不同的层**，但 codex review 抓出 ADR 原版扫描表
没区分。P0-R2 重新扫描：

| 入口 | 命中位置 | 影响 |
|---|---|---|
| `ASTER_PII_ENFORCE=false` env | `aster-deploy/.env.example:59` (注释行)；`aster-deploy/compose/podman-compose.test.yml:15` (测试 compose)；`aster-deploy/docs/local-debug.md:80` (本地调试文档) | 仅测试/调试用途；生产 properties (`src/main/resources/application.properties:74`) 默认 `${ASTER_PII_ENFORCE:true}` |
| `aster.pii.enforce=false` properties | `aster-api/src/test/resources/application.properties:55`；`aster-api/src/test/resources/application-prisma.properties:37` | 仅测试 |

**结论（运行时）**：生产环境不依赖 opt-out。本 ADR 把 PIIConfig default
从 `false` 改为 `true` 仅修正了"properties 未设时回退到不安全默认值"这个
独立 bug——不影响实际生产部署（生产 properties 已显式 `:true`）。

硬切换比保留兼容路径更安全：opt-out 路径长期存在反而会重新引入 drift。
保留为 stub + `@deprecated` 标记一个 major 周期足够给外部依赖时间响应。

## Implementation

### TypeScript 端

- `aster-lang-ts/src/typecheck/utils.ts` — `shouldEnforcePii()` 改为
  no-op stub，always returns `true`
- `aster-lang-ts/src/typecheck/module.ts:115` — 删除 `if (shouldEnforcePii())`
  gate；PII 检查无条件运行
- `aster-lang-ts/src/typecheck/browser.ts` — 模块注释更新；删除 "unsupported
  in browser" 路径；调用 `checkModulePII` 替代
- `aster-lang-ts/src/typecheck-pii.ts` — **无改动**（本来就环境无关）

### 测试（P0-R 修订后实际覆盖）

- `aster-lang-ts/test/unit/typecheck/pii-cross-runtime-conformance.test.ts`
  — 7 个用例：HTTPS L3 sink / HTTP L2 sink / L3→L1 降级赋值 / 参数违规 /
  无 PII baseline / 空模块 / PII_CODES 集合元测试。断言完整 diagnostic
  shape（code + severity）等价
- `aster-lang-ts/test/type-checker/pii-propagation.test.ts` — 两个测试翻转
  ("默认禁用 → 默认启用"）
- `aster-lang-ts/test/unit/browser/typecheck-browser-unsupported.test.ts` —
  两个测试翻转（"browser 警告 unsupported → browser 永远跑 PII"）
- `aster-lang-ts/test/unit/typecheck/should-enforce-pii.test.ts` — 完整重写，
  验证 stub 在所有配置下都返回 true
- `aster-lang-ts/test/unit/browser/typecheck-browser-pii-failure.test.ts` —
  新增（P0-R）：验证 PII_ANALYZER_FAILED 错误码 + severity=error 合同
- `aster-cloud/src/__tests__/app/execute-policy-content.integration.test.tsx`
  — 新增（P0-R）：集成回归测试，验证 ExecutePolicyContent 把 fetch 到的
  policy source 正确传给 DecisionTracePanel
- `aster-lang-core/src/test/java/aster/core/typecheck/PiiAlwaysOnConformanceTest.java`
  — 新增（P0-R）：Java 端 PII always-on 合同（无 env 时 TypeChecker 仍报
  PII 诊断）

## Consequences

### Positive

- **核心差异化承诺成立**：PII 检查在所有运行时一致生效——Aster vs
  Rego/Cedar 的护城河变硬
- **跨 runtime 等价**：同一策略 → 同一 PII 诊断；CI / IDE / Workers 不会
  drift
- **代码路径简化**：删除一整套配置注入机制（env / globalThis / option）
- **新增防御层**：browser conformance test 防止未来回归

### Negative

- **可能的诊断噪声**：原先依赖 opt-out 静默 PII 诊断的项目会突然看到 PII
  warning/error。Mitigation：核查显示无真实依赖（仅 fixture 测试代码）
- **`enforcePii` 选项保留但无效**：API 表面有 cosmetic dead code（标记
  `@deprecated`，下个 major 移除）
- **合规 policy pack 仍 opt-in**：保留可配置性的同时承担"双层"复杂度——
  本 ADR 接受这个取舍

### Neutral

- aster-lang-runtime / aster-lang-truffle 不受影响（Core IR 类型不变）
- aster-cloud Monaco editor 现在会显示 PII 诊断——这正是产品价值的体现

## P0-R Review Findings (codex independent reviews)

### Round 1 (2026-05-27)

ADR 原版（pre-P0-R）有几处粉饰和遗漏，已在本修订修正：

| Finding | 原版问题 | 修订 |
|---|---|---|
| Critical: Java 端 PII gate | 写 "aster-api 不受影响"，实际 aster-lang-core TypeChecker.shouldEnforcePii() 仍读 env | 决定 3 加入 Java 端同步修复 + PiiConfig 默认值修正 |
| High #1: 集成回归测试 | 原 P0-2 测试只测组件，bug 在 caller | 新增 ExecutePolicyContent 集成测试 |
| High #2: conformance 范围 | PII_CODES 集合只有 3 个，漏 W071/W074/E400 等 | 扩展到 10 个 codes |
| High #3: 测试覆盖说明 | 写 "降级赋值" 实际未实现 | 实现 4 个新场景；本节准确反映 |
| High #4: 跨仓库 grep | "aster-api 不受影响" 未经验证 | 决定 4 + "Why not deprecation window?" 加入实际扫描结果 |
| Medium: ADR 证据 | "no real users" 无来源 | "Why not deprecation window?" 加入实际仓库扫描表 |

### Round 2 (P0-R2, 2026-05-27)

第二轮 codex review 又抓出 12 个问题，含 1 Critical（aster-cloud 锁
0.2.0 不消费修复）+ 4 High + 5 Medium + 2 Low。P0-R2 修订：

| Finding | 修订 |
|---|---|
| Critical: aster-cloud 未消费 P0-R 修复 | aster-lang-ts bump 0.2.1 + aster-cloud package.json 改 `link:../aster-lang-ts`；CI 待 publish 后切回版本号 |
| High: Java 端无 E404 镜像 | aster-lang-core ErrorCode 加 PII_ANALYZER_FAILED (E404) + PII_MISSING_CONSENT_CHECK (E403) |
| High: Java conformance 无 env clear | build.gradle.kts test task 显式 `environment("ENFORCE_PII", "")` 隔离父进程 env |
| High: ADR 残留 "aster-api 不受影响" | 本次修订删除残留 bullet，移到 P0-R Findings 表 |
| High: ADR 扫描漏 aster-deploy | "Why not deprecation window?" 节拆分编译时 vs 运行时，诚实列出 aster-deploy 的 3 处 ASTER_PII_ENFORCE=false 命中（均为 test/debug 用途） |
| High: E404 帮助文本不可执行 | error_codes.ts E404 metadata help 改成浏览器用户可执行建议 |
| Medium: schemaError 直接渲染原始字符串 | 改为 `{messageKey, detail}` 结构化，主文案走 i18n |
| Medium: E404 测试用 regex 读 dist | 加入真实 fault injection：把 checkModulePII 改为可注入依赖 |
| Medium: PII_CODES 集合无自动派生 | 改为从 ERROR_METADATA category==='pii' 自动派生 |
| Medium: 集成测试 mock DecisionTracePanel | 新增不 mock 的 React integration test |
| Medium: locale 检测丢弃 confidence | 改用 detectCNLLanguage 完整结果，低置信度 fallback page locale |
| Low: import 位置 + aster-api 残留注释 + 版本统一 | 逐项清理（见对应 commits） |

## Open questions

无。本 ADR 决策已完整实现（P0-R2 后）：
- aster-lang-ts unit: 1042+ pass / 0 fail
- aster-lang-ts integration: 87/87 pass
- aster-lang-ts conformance: 7 个 PII 跨运行时用例 pass，含完整 diagnostic
  shape (code + severity) 等价 + 自动派生的 PII codes 集合元测试
- aster-lang-core Java test: 5+ 个新增 conformance tests pass，含 env clear
  forked JVM + analyzer failure contract
- aster-cloud: 14+ tests pass，含真实 DecisionTracePanel integration
- 浏览器路径成功调用 `checkModulePII`，捕获了原先静默的 HTTP sink violation

## Related

- ADR-0008 — zh-CN v2 keywords + CJK punctuation soft boundary（同期 v2/v3
  清理工作）
- Codex backend P0 #5 — "PII is a 亮点 but should not depend on env"（本
  ADR 提级到 P0 并加重）
- Codex frontend report — 暗示 "PII 一等公民" 是 Aster 真正护城河
- 未来 ADR：合规 policy pack 的可配置启用机制（HIPAA / GDPR / CCPA）

## Verification (P0-R2 后)

注意：跨实现等价不是 byte-identical 字符串比较——而是 **normalized PII
diagnostic shape equivalence**（相同 codes + 相同 severities + 相同 count）。
完整的源码 byte-identical 是 P1 单 parser 真源议题，不在本 ADR 范围。

```bash
# 1. aster-lang-ts unit + integration tests
cd aster-lang-ts && pnpm run test:unit:run
# 期望：1042+ pass / 0 fail / 2 skipped

cd aster-lang-ts && pnpm run test:integration:run
# 期望：87/87 pass

# 2. 验证跨运行时等价（Node vs browser 路径）
node --test 'aster-lang-ts/dist/test/unit/typecheck/pii-cross-runtime-conformance.test.js'
# 期望：7/7 pass，含完整 diagnostic shape 比较 + PII_CODES 元测试

# 3. 验证 Java 端 PII always-on 合同 + forked JVM env clear
cd aster-lang-core && ./gradlew test --tests "aster.core.typecheck.PiiAlwaysOnConformanceTest"
# 期望：5+ tests pass，含 isPiiCode 集合元测试 + E404 镜像验证

# 4. 验证 aster-cloud 集成回归（含 P0-R2 新增 real-trace 测试，P0-R3 补遗）
cd aster-cloud && pnpm vitest run \
  src/__tests__/app/execute-policy-content.integration.test.tsx \
  src/__tests__/app/execute-policy-content.real-trace.integration.test.tsx \
  src/__tests__/components/decision-trace-panel.test.tsx
# 期望：18+ pass（含不 mock DecisionTracePanel 的真实集成回归）
```

## aster-cloud 消费 aster-lang-ts 0.2.1（P0-R4 修复）

**当前状态**：aster-cloud 通过 commit 进 repo 的 tarball 消费 0.2.1。

- `aster-cloud/package.json` 引用 `file:vendor/aster-cloud-aster-lang-ts-0.2.1.tgz`
- tarball 由 `cd aster-lang-ts && pnpm pack --pack-destination ../aster-cloud/vendor` 生成
- CI 安装直接读 vendor 目录，无需 sibling repo / npm registry
- 浏览器端**完整应用** P0-R + P0-R2 + P0-R3 修复（含 PII_ANALYZER_FAILED catch、业务友好消息、production guard 等）

**长期 TODO（npm publish 凭证可用后）**：
1. `cd aster-lang-ts && npm publish` 发布 0.2.1 到 npm registry
2. `aster-cloud/package.json` 改 `file:vendor/...` → `^0.2.1`
3. 删除 `vendor/aster-cloud-aster-lang-ts-0.2.1.tgz`
4. `pnpm install && pnpm test` 验证

## Round 8 修复（P0-R8，2026-05-26）

**Round 8 codex 评分**：92/100 Block。剩余 Critical：

> 在无 `process` 全局的 runtime 中，`validateEnvOrWarn(env = process.env, mode?)`
> 默认参数会在函数体执行前求值 `process.env`，直接抛 `ReferenceError`。
> 同时 `src/lib/deployment-mode.ts` 模块顶部裸读 `process.env.NODE_ENV /
> NEXT_PHASE / VITEST / DEPLOYMENT_MODE`，被 env-validation transitively
> import 时同样在模块加载阶段抛 ReferenceError。

### 修复路径

| 文件 | 修复 |
|------|------|
| `src/lib/env-validation.ts` | 新增 `getProcessEnv()` 安全读取器（`typeof process !== 'undefined'` + try/catch）。`checkEnv / validateEnvOrThrow / validateEnvOrWarn` 三个函数的默认参数从 `= process.env` 改为 `= getProcessEnv()` —— 求值不再在调用点直接 ReferenceError |
| `src/lib/deployment-mode.ts` | 新增 `safeEnv(key)` 安全读取器。模块顶部 `_IS_RUNTIME_PRODUCTION` 与 `_RUNTIME` 中所有 `process.env.X` 改用 `safeEnv('X')` |
| `src/__tests__/lib/env-validation.test.ts` | 新增 "no-process runtime safety (P0-R8)" describe block，2 个测试：临时 `Object.defineProperty(globalThis, 'process', { value: undefined })` 模拟无 process 全局，验证 `checkEnv()` 与 `validateEnvOrWarn()` 默认参数不抛 ReferenceError（走真模块路径，不是 vm 内联字符串） |

### 验证

```bash
cd aster-cloud
pnpm exec tsc --noEmit           # 0 errors
pnpm test:run                    # 2548 passed | 8 skipped（4 个新 no-process assertion）
pnpm lint                        # 0 errors（1 个无关 warning）
```

### 设计理由

- **edge runtime 无 `process` 全局**（Cloudflare Workers、严格的 browser bundle、Edge functions）：模块加载阶段裸读 `process.env` 即 ReferenceError，**整个应用拒绝启动**——而非降级到无 env 的 warning 路径。
- **默认参数求值时机**：JS 默认参数在每次调用时（参数未传时）求值，不是函数定义时。`= process.env` 等价于 `if (env === undefined) env = process.env;` 在函数体之前执行，命中前述异常。
- **`getProcessEnv()` / `safeEnv()` 双重保险**：`typeof process !== 'undefined'` 是 V8 的静态判定，不会触发 ReferenceError；外层 try/catch 防御 sandbox 把 `process` 设成 throwing getter 的极端场景。
- **空 env fallback 行为**：无 process 时返回 `{}`，所有 env 校验视为"全部缺失"——进入 warning 路径而非崩溃。Cloudflare Workers 的 secret 通过 binding 注入到全局，不走 `process.env`，因此 `validateEnvOrWarn()` 在 Workers 看到的就是空 env，行为符合预期（只 console.error，不阻断启动）。

## Round 9 修复（P0-R9，2026-05-26）

**Round 9 codex 评分**：91/100 退回。剩余 Critical + High：

> [Critical] `src/lib/security/csp.ts:40` middleware import 链
> module-load 时仍裸读 `process.env.NEXT_PUBLIC_ASTER_POLICY_API_URL`，
> 等于 Round 8 修复留下的等价盲点。
>
> [High] `next.config.ts` / `turnstile.ts` / `resend.ts` / `plan-gate-client.ts` /
> （`secure-executor.ts` 已下线，2026-10-30，cloud#655。）
> `snapshot-pusher.ts` / `secure-executor.ts` 模块顶部仍有裸 `process.env` 初始化。
>
> [Medium] no-process regression test 用 `Object.defineProperty(globalThis,
> 'process', { value: undefined })` 模拟，会让 `process.env.X` 抛
> **TypeError** 而非真实 edge runtime 的 **ReferenceError**。

### 修复路径

| 文件 | 修复 |
|------|------|
| `src/lib/runtime/safe-env.ts` **(新)** | 抽出共享 `safeEnv(key)` / `safeProcessEnv()` / `hasProcessGlobal()` helper，供所有需要 cross-runtime safe env 读取的模块统一引用 |
| `src/lib/security/csp.ts` | **Critical**：`computeAsterApiDomains` + `buildCspHeader` 从 `process.env.X` 改为 `safeEnv('X')`，middleware import 链不再 module-load 抛 ReferenceError |
| `next.config.ts` | DEPLOYMENT_MODE / NEXT_PHASE 改 safeEnv（Node-only 路径但统一规范，避免 OpenNext cold start 偶发触碰配置加载） |
| `src/lib/turnstile.ts` | 4 处裸 process.env 全改 safeEnv |
| `src/lib/resend.ts` | RESEND_API_KEY / RESEND_FROM_EMAIL / NEXT_PUBLIC_APP_URL 改 safeEnv |
| `src/lib/plan-gate-client.ts` | ASTER_API_INTERNAL_URL / ASTER_PLAN_GATE_HMAC_KEY 改 safeEnv |
| `src/lib/snapshot-pusher.ts` | 同 plan-gate-client |
| `src/services/security/secure-executor.ts` | POLICY_SIGNING_SECRET 改 safeEnv（已下线，2026-10-30，cloud#655：文件与该变量均已移除） |
| `src/lib/env-validation.ts` | `getProcessEnv` 改为 alias `safeProcessEnv`（去重） |
| `src/lib/deployment-mode.ts` | 局部 `safeEnv` 改为 import 自共享 helper |
| `src/__tests__/lib/env-validation.test.ts` | 改用 `delete globalThis.process` 真正移除 binding，**精确模拟 edge runtime 的 ReferenceError**；新增"验证模拟手法"测试用 `eval('process.env.X')` 确认裸引用真的抛 ReferenceError |
| `src/__tests__/lib/csp-no-process.test.ts` **(新)** | 静态契约检查：csp.ts 源码不得含 module-load 阶段裸 process.env；必须 import + 使用 safeEnv。规避 `delete globalThis.process` + `await import()` 导致 vitest worker IPC 崩溃的问题 |

### 验证

```bash
cd aster-cloud
pnpm exec tsc --noEmit  # 0 errors
pnpm test:run           # 2556 passed | 8 skipped（+8 from R8：no-process 真实 ReferenceError 验证 + csp 静态契约）
pnpm lint               # 0 errors（1 pre-existing 无关 warning）
```

### 设计理由

- **共享 safe-env helper 优于复制**：R8 把 helper 内联到每个文件难免漂移；R9 抽到 `@/lib/runtime/safe-env`，未来新模块直接 import 即可，避免再次出现"漏一个文件就炸"的盲点。
- **静态契约测试胜过动态模拟**：`csp.ts` 静态检查（grep 源码 + AST 粗扫）能精准抓住"是否有 module-load 阶段裸读"，而 `delete globalThis.process` 动态模拟在 vitest 主进程里会因为 `process.nextTick` 依赖而炸 worker IPC。两层互补：env-validation.test 走真实 delete（同步路径安全），csp-no-process.test 走静态契约（覆盖 await import 场景）。
- **regression test 真实性**：R8 测试用 `value: undefined` → `process` binding 仍在，`process.env.X` 抛 TypeError（读 `undefined.env`），不是 edge runtime 真实的 ReferenceError。R9 用 `delete g.process` 真删 binding，并新增第三个测试用 `eval` 验证"裸引用确实 ReferenceError"——锁定 simulation 的正确性。
- **defense in depth**：turnstile / resend / plan-gate-client 等当前只在 Node route handler 路径，不会进 middleware bundle。但统一规范后，未来若任何 helper 被 transitively 拉入 edge bundle 不会再炸——standards beat heroics。

## Round 10 修复（P0-R10，2026-05-26）

**Round 10 codex 评分**：88/100 退回。剩余 Critical + High：

> [Critical] `middleware.ts → @/lib/lexicon-availability` 链 module-load
> 阶段仍裸读 `process.env.NEXT_PUBLIC_ASTER_POLICY_API_URL`（line 53）。
> Round 9 修了 csp.ts 同样问题，但同条 import graph 上还有一个洞。
>
> [High] `csp-no-process.test.ts` 注释说用 vm.Module 隔离，实际只是
> 普通 `await import()`，没有真正测"无 process 下 import"，所以才没抓住
> lexicon-availability 这个 Critical。
>
> [Medium] 静态契约测试只覆盖 csp.ts，没扫整个 middleware transitive closure。
>
> [Low] `lexicon-availability.__TEST_ONLY__resetCache()` 函数体内也裸读
> `process.env.NODE_ENV`（非 module-load，但应当统一）。

### 修复路径

| 文件 | 修复 |
|------|------|
| `src/lib/lexicon-availability.ts` | **Critical**：`ASTER_API_BASE = process.env.NEXT_PUBLIC_ASTER_POLICY_API_URL` → `safeEnv('NEXT_PUBLIC_ASTER_POLICY_API_URL')`。`__TEST_ONLY__resetCache()` 内 `process.env.NODE_ENV` → `safeEnv('NODE_ENV')`（Low 一并清理） |
| `src/__tests__/lib/middleware-no-process.test.ts` **(rename + 扩展)** | 从 `csp-no-process.test.ts` 重命名扩展。新增 BFS 依赖图扫描：从 `middleware.ts` 入口出发，遍历所有本地 transitive imports（@/ + 相对路径），对每个文件用 brace-depth tracker + 字符串字面量净化 + 注释剥离做静态扫描，禁止 module-load 阶段裸 `process.env`。能在 PR 时静态抓住未来新加的模块加载裸读 |

测试输出（失败时）会列出违规文件 + 行号 + 完整源码行，定位精准。

### 验证

```bash
cd aster-cloud
pnpm exec tsc --noEmit  # 0 errors
pnpm test:run           # 2558 passed | 8 skipped（+2 from R9：transitive closure scan）
pnpm lint               # 0 errors（1 pre-existing 无关 warning）
```

### 设计理由

- **入口驱动的依赖图扫描** > 文件级 grep：lexicon-availability 案例证明 helper-by-helper 修复永远会漏。把"middleware bundle 不得有 module-load 裸 process.env"做成 transitive closure 契约，未来任何新模块或新 import 都会被 PR-time CI 抓住——standards beat heroics 的真正落地。
- **brace-depth tracker 的精度边界**：当前实现做了字符串/注释净化 + 多行注释跟踪，能处理常见模式（`const FOO = process.env.X`、`if (process.env.X)` 顶层、template literal 里的伪造 `process.env`）。它**不是**完美 AST 分析；如果有人写出超怪异的代码（class field initializer、IIFE 顶层等），可能误判。Trade-off：保守地报告偏多（不会漏报真实 module-load 裸读），值得手工 review。完美 AST 升级是 P2。
- **测试命名与实现一致性**：R9 的 `csp-no-process.test.ts` 注释承诺 vm.Module 隔离，实现却没做——这种"测试名 vs 实现脱节"是 R10 codex 抓到的 High。R10 重命名为 `middleware-no-process.test.ts` 并移除虚假声明，描述与实现现在 1:1 对齐。

## Round 11 修复（P0-R11，2026-05-26）

**Round 11 codex 评分**：93/100 退回。剩余 High + Medium：

> [High] R10 的 BFS regex import 解析漏 `import('...')` 动态导入、
> `export ... from '...'` / `export * from '...'` re-export，未来 middleware
> 闭包通过 barrel re-export 拉入新模块时扫描会漏。
>
> [Medium] brace-depth 顶层判定漏多行对象字面量 `{...}` 拆行场景、class
> static field initializer、class static block、IIFE。文档承诺"保守地报告偏多
> 不会漏报"不成立。
>
> [Medium] vendor tarball SLA 只验证文档，没验证 tarball 内容确实包含 R6 修复。
>
> [Low] ADR 表述"未来任何新模块或新 import 都会被 PR-time CI 抓住"过强。

### 修复路径

| 文件 | 修复 |
|------|------|
| `src/__tests__/lib/middleware-no-process.test.ts` | **核心升级**：从 regex + brace-depth 改为 **TypeScript compiler API**。Import 解析：用 `ts.ImportDeclaration` / `ts.ExportDeclaration moduleSpecifier` / `CallExpression(ImportKeyword)` 覆盖 static / re-export / dynamic 全部场景，type-only 也算。顶层执行扫描：遍历 `sourceFile.statements`，对每个 statement 用 `scanForViolations` visit，跳过函数体 (`FunctionDeclaration` / `FunctionExpression` / `ArrowFunction` / `MethodDeclaration` / `Constructor` / `GetAccessor` / `SetAccessor`)，命中 `process.env.X` 的 PropertyAccessExpression 即报。`ClassDeclaration` 的 `static` 字段 initializer 和 `static {}` block 单独扫描。 |
| `src/__tests__/lib/middleware-no-process.test.ts` (scanner self-test) | 9 个 fixture 测试证明 scanner 能抓住：简单 const、多行对象、class static field、class static block、顶层 if；不误报：函数体、箭头函数、method body。**文档化已知 false-negative**：IIFE 即时调用（升级 control-flow analysis 是 P2）。 |
| `src/__tests__/lib/middleware-no-process.test.ts` (import parser self-test) | 4 个 fixture 测试证明 parser 能抓住：static import、dynamic `import()`、re-export `export ... from` / `export * from`、type-only import。 |
| `.github/workflows/ci.yml` | **tarball 内容合同**：`vendor/aster-cloud-aster-lang-ts-*.tgz` 必须含 R6 跨运行时 PII 修复的 4 个关键符号 (`isProductionRuntime` / `__setPiiCheckerForTest` / `__isProductionRuntimeForTest` / `PII_ANALYZER_FAILED`)。防止 tarball 被替换/降级回退到无 PII guard 的旧版本。 |

### 验证

```bash
cd aster-cloud
pnpm exec tsc --noEmit  # 0 errors
pnpm test:run           # 2584 passed | 8 skipped（+26 from R10：9 scanner + 4 parser self-tests × 2 projects）
pnpm lint               # 0 errors（1 pre-existing 无关 warning）
```

scanner self-test 输出（saas project）：

```
✓ scanner self-test > 抓住简单 const = process.env.X
✓ scanner self-test > 抓住多行对象字面量
✓ scanner self-test > 抓住 class static field initializer
✓ scanner self-test > 抓住 class static block
✓ scanner self-test > 抓住顶层 if 控制流
✓ scanner self-test > 不误报：函数体内的 process.env
✓ scanner self-test > 不误报：箭头函数赋值给 const
✓ scanner self-test > 不误报：method body
✓ scanner self-test > 已知 false-negative: IIFE 内 process.env（文档化）
```

### 设计理由

- **AST > regex 永久赢**：R9/R10 用 regex + brace-depth 是 expedient 而非正确。R11 codex 用 `import('./foo')` / `export * from './foo'` 反例证明 regex 解析有真实漏洞。TS compiler API 一次升级覆盖所有合法 ES module 语法形态，且未来不需要为新语法（top-level await / decorator）打补丁。
- **fixture 驱动 self-test 是"未来 PR 时拦截力"的唯一证明**：单纯说"scanner 升级了 AST"没意义；只有通过 9 个 scanner fixture + 4 个 parser fixture 直接证明各种 module-load 模式都能被抓住（且不误报合法模式），才是有约束力的合同。失败时 vitest 输出违规列表 + 行号，可直接定位。
- **已知 false-negative 必须文档化**：IIFE `(() => { process.env.X })()` 模式 scanner 跳过函数体所以漏报。当前 trade-off：跳过函数体减少误报（业务代码大量箭头函数）值得，IIFE 模式在 repo 全文 grep 不存在，未来若有人写 IIFE 顶层求值需要靠 control-flow analysis（ts-morph 或 control flow graph）才能精准。这是 P2 升级，不阻塞当前 GA。
- **tarball 内容合同关闭 supply chain 风险**：单纯的 vendor README SLA 防止"忘记记录"，但不防止"tarball 被替换为旧版本"。R11 加 CI 解压 + grep 4 个关键符号，确保每次 build 都验证 PII 修复在场。这是 ADR-0009 "always-on across all runtimes" 契约的最后一公里。

## Round 12 修复（P0-R12，2026-05-26）

**Round 12 codex 评分**：94/100 退回。剩余 High + Medium：

> [High] AST scanner 只覆盖 TS 源码闭包，不证明编译后 OpenNext middleware
> bundle artifact 无 module-load process.env（artifact 里仍有 Next/OpenNext
> 自身注入的 process.env，靠 nodejs_compat + wrapper 注入 process 兜底）。
>
> [High] scanner 漏 class heritage 表达式 `class X extends f(process.env.X) {}`、
> decorator `@dec(process.env.X)`、computed property key `class X { [process.env.Y]() {} }`。
> 这些都是 class 定义时求值，不是 P2 怪招。
>
> [Medium] import parser 漏 CommonJS `require('./x')`。
>
> [Medium] scanner 只匹配 `process.env.X` PropertyAccessExpression，漏
> `process['env'].X` (ElementAccessExpression)、`process?.env?.X` (optional chain)、
> `const { env } = process` destructuring。
>
> [Medium] tarball SLA grep 4 符号能证明"看起来像 R6"，不证明"执行 R6"。

### 修复路径

| 文件 | 修复 |
|------|------|
| `src/__tests__/lib/middleware-no-process.test.ts` (scanner) | **R12 升级 scanner 语义边界**：抽出 `isProcessEnvAccess()` 共享判定，覆盖 PropertyAccessExpression（`process.env.X` + `process?.env?.X` optional chain）+ ElementAccessExpression（`process['env'].X` / `process['env']['X']`）。新增 `isProcessEnvDestructuring()` 处理 `const { env } = process` / `const { env: alias } = process` ObjectBindingPattern。Class 扫描升级为 `scanClassForViolations()`：heritage clauses（`extends`/`implements` 表达式）、decorator expressions（class + member）、computed property keys（`[expr]`）、static field initializer + static block。 |
| `src/__tests__/lib/middleware-no-process.test.ts` (parser) | extractImports 增加 CommonJS `require('./x')` 抽取（CallExpression with identifier `require`） |
| `src/__tests__/lib/middleware-no-process.test.ts` (self-test) | 共享 `scanString()` helper 写入 tmp 文件复用 `findModuleLoadProcessEnv()` 真实实现——避免主代码/测试代码漂移。新增 10 个 R12 fixture：class heritage / class decorator / member decorator / computed key / element access / element access nested / optional chain / destructuring / destructuring alias / 不误报 destructuring with different init。新增 1 个 parser fixture：`require()`。 |
| `.github/workflows/ci.yml` (tarball SLA) | **从"符号在场"升级为"call site + 错误码 + 入口都在场"**：(a) 函数定义在场，(b) `isProductionRuntime()` 真正在 `__setPiiCheckerForTest` 被调用，(c) `PII_ANALYZER_FAILED` + `"E404"` 字面量在场（说明 catch 路径编译进 bundle），(d) `checkModulePII` / `defaultCheckModulePII` / `PiiTypeChecker` 入口在场（说明 PII 流程没被注释为 no-op） |

### 收窄表述：ADR 契约范围

R12 codex 提的 High 第一条（artifact-level）是文档准确性问题，不是 runtime bug。本 ADR 的"no-process runtime safety"契约**严格限定在源码层**：

| 层级 | 契约 | 验证手段 |
|------|------|---------|
| **TS 源码闭包**（本 ADR 主战场） | middleware.ts transitive imports 不得有 module-load 阶段任何形式的 `process.env` 访问（PropertyAccessExpression / ElementAccessExpression / optional chain / 解构）。bare `process` access（`process.cwd()` / `process.version`）不在 scanner 范围 — 业务代码当前不需要这类调用，但若未来加 P2 升级以禁止 module-load bare process | `middleware-no-process.test.ts` AST scanner，PR-time 拦截 |
| **运行时入口**（next-intl / OpenNext / Cloudflare workerd） | 由 Cloudflare 的 `nodejs_compat` flag + OpenNext wrapper 提供 process polyfill | 不在本 ADR 范围；属 Cloudflare/OpenNext platform layer |
| **编译产物 .open-next/middleware/handler.mjs** | 含 Next.js DefinePlugin 注入的 process.env.X 字面量替换 — 这是 Next.js 编译机制本身，靠平台 polyfill 兜底 | 不在本 ADR 范围 |

本轮的 scanner / parser / tarball SLA 升级**只针对源码层**，不外推到 artifact level。ADR-0009 §"Round 9 修复" 中"未来任何新模块或新 import 都会被 PR-time CI 抓住"应理解为"源码层任何新模块"。

### 验证

```bash
cd aster-cloud
pnpm exec tsc --noEmit  # 0 errors
pnpm test:run           # 2606 passed | 8 skipped（+22 from R11：10 scanner + 1 parser self-tests × 2 projects）
pnpm lint               # 0 errors（1 pre-existing 无关 warning）

# 手工验证 tarball 内容合同
ASTER_TARBALL=vendor/aster-cloud-aster-lang-ts-0.2.1.tgz
tar -xzOf "$ASTER_TARBALL" package/dist/src/typecheck/browser.js | \
  grep -E "isProductionRuntime\(\)|PII_ANALYZER_FAILED|\"E404\"|checkModulePII"
# 期望：所有模式都有命中
```

### 设计理由

- **共享 helper 消除测试漂移**：R11 self-test 用了自己的 inline `scanString()`，与生产 scanner `findModuleLoadProcessEnv()` 有两份实现。R12 codex 没明说，但这是典型"测试逻辑漂移"风险。R12 修：self-test 写入 tmp 文件 + 调用真实 `findModuleLoadProcessEnv()`，单一来源。
- **class 求值表面比想象的多**：scanner 一直围绕"function body skip vs everything else scan"二元化思考，遇到 class 就 `continue`。R12 codex 提醒：class declaration 的 heritage、decorator、computed key 都是 **class 定义时（即 module-load）** 求值的，不是方法体。修：把 class 拆成 `scanClassForViolations()` 显式枚举求值点。
- **process.env 不止 `process.env`**：optional chain / element access / destructuring 都能触碰 process binding 并触发 ReferenceError。修 scanner 时一并覆盖。
- **tarball SLA 不止"在场"**：单纯 grep 函数名能被"代码注释掉但 export 仍在"绕过。R12 加 call site grep（`isProductionRuntime()` 形态）+ 错误码字面量 + 入口函数，让"看起来像 R6"和"真的执行 R6"对齐。
- **ADR 范围收窄是必须**：R12 codex 提醒 artifact-level process.env 实际存在但有 platform polyfill 兜底。继续外推会误导支持矩阵。明确"本 ADR 只覆盖 TS 源码层"避免无谓争议。

## Round 13 微调（P0-R13，2026-05-26）

**Round 13 codex 评分**：95/100 通过 ✓。剩余仅 Medium / Low 边角问题，不阻塞 GA：

> [Medium] tarball SLA grep `isProductionRuntime()` 是全文件级，不证明 call site 在 `__setPiiCheckerForTest` 函数体内（可能"setter 定义但 body 被注释为 no-op"）
>
> [Medium] scanner 对 class expression `const C = class { ... }` 没有平行处理：method body skip 会漏掉 class expression 的 computed key / member decorator / static field
>
> [Medium] ADR 表述"任何形式的 process / process.env 访问"过宽，scanner 实际只覆盖 process.env 家族

由于已通过，趁势把 codex 提的 Medium 一并清理（成本低、durability 提升大），作为同 PR 内的 polish：

### 修复路径

| 文件 | 修复 |
|------|------|
| `.github/workflows/ci.yml` (tarball SLA) | tarball SLA (b) 升级：用 awk 提取 `function __setPiiCheckerForTest(...) { ... }` 函数体的实际范围，再 grep `isProductionRuntime()` —— 挡住"setter 定义了但 body 被注释/简化"的退步 |
| `src/__tests__/lib/middleware-no-process.test.ts` (scanner) | `scanForViolations()` 顶部加 ClassExpression 平行处理：遇到 class expression 走 `scanClassForViolations()` 而不是默认 skip method body。覆盖 `const C = class { ... }` 模式 |
| `src/__tests__/lib/middleware-no-process.test.ts` (self-test) | 新增 3 个 R13 fixture：class expression heritage / class expression computed key / class expression static field |
| `docs/architecture/decisions/0009-pii-enforcement-default-on.md` (表格) | 修正"任何形式的 process / process.env 访问"为精确范围：`process.env` 访问（PropertyAccessExpression / ElementAccessExpression / optional chain / 解构）；bare `process` access 不在 scanner 范围 |

### 验证

```bash
cd aster-cloud
pnpm exec tsc --noEmit  # 0 errors
pnpm test:run           # 2612 passed | 8 skipped（+6 from R12：3 class expression × 2 projects）
pnpm lint               # 0 errors

# tarball SLA call-site 提取手工验证
awk '
  /function __setPiiCheckerForTest/ { in_fn=1; depth=0 }
  in_fn { print; for (i=1; i<=length($0); i++) {
    c=substr($0, i, 1);
    if (c=="{") depth++;
    else if (c=="}") { depth--; if (depth==0) { in_fn=0; exit } }
  }}
' <(tar -xzOf vendor/aster-cloud-aster-lang-ts-0.2.1.tgz package/dist/src/typecheck/browser.js) \
  | grep "isProductionRuntime()"
# 期望输出：if (isProductionRuntime() && fn !== null) {
```

### GA 决策

ADR-0009 跨运行时 PII flow analysis 经过 13 轮 codex review 迭代（72 → 88 → 82 → 90 → 94 → 92 → 92 → 92 → 91 → 88 → 93 → 94 → 95），从纯 Java 后端契约扩展到 TS 源码 + tarball + CI 三层契约：

| Layer | Round 引入 | 状态 |
|-------|----------|------|
| Java backend (E403/E404 + Category.PII + forked JVM ENFORCE_PII clear) | R2/R3 | ✓ |
| TS browser entry (isProductionRuntime + __setPiiCheckerForTest + __ASTER_PRODUCTION__) | R5/R6 | ✓ |
| aster-cloud instrumentation (safeEnv helper + worker.js fail-closed) | R6/R7 | ✓ |
| env-validation / deployment-mode no-process safe | R8 | ✓ |
| Shared safe-env helper + middleware chain (csp + lexicon) | R9/R10 | ✓ |
| AST-based middleware transitive scanner + self-test fixtures | R11/R12/R13 | ✓ |
| Tarball content contract (call site + error code + entry point) | R11/R12/R13 | ✓ |

**结论**：达到 GA-ready 标准。剩余 Low（IIFE false-negative / top-level await 缺 fixture）作为 P2 hardening backlog，不阻塞上线。

## Round 14 + 15 Postmortem (P0-R14/R15, 2026-05-27)

**R13 给出 95/100 通过, 但提交后 CI 立刻暴露 critical build regression**:

```
Module build failed: UnhandledSchemeError:
  Reading from "node:fs" is not handled by plugins
Import trace:
  node:fs ← dist/src/lsp/module_cache.js ← typecheck/module.js
        ← typecheck/index.js ← typecheck.js
        ← typecheck-pii.js ← typecheck/browser.js
        ← browser.js ← execute-policy-content.tsx
```

R13 评分实际是**虚假高分**: 所有审计都基于"本地 pnpm test:run 通过"，但
vitest 不走 webpack edge build, **artifact 层依赖闭包**完全没被检验。

### 审计方法学反思

| 层级 | R1-R13 覆盖 | R13 评分时盲点 |
|------|------------|---------------|
| 源码 AST (TS PropertyAccess/ElementAccess) | ✓ (middleware-no-process scanner) | — |
| 单元测试 (vitest, node:test) | ✓ | — |
| 集成测试 (Java forked JVM, vitest jsdom) | ✓ | — |
| **真实 bundler build (Next.js webpack edge target)** | ✗ | **关键盲点** |
| **vendor tarball 的 transitive import 闭包** | △ (只 grep 符号在场) | **关键盲点** |
| 编译产物层 module graph 分析 | ✗ | **关键盲点** |

R13 之前每轮都把 "本地 pnpm test:run 全绿" 当作 GA 决策依据, 但忽略了
**消费者 build pipeline** 才是真实的 cross-runtime 验证现场。

### R14 修复 (已爆 regression)

| 文件 | 修复 |
|------|------|
| `aster-lang-ts/src/typecheck-pii.ts` | `import resolveAlias from './typecheck.js'` → `'./typecheck/utils.js'` (leaf, 不再 transitively 拉 module.ts → node:perf_hooks) |
| `aster-cloud/vendor/aster-cloud-aster-lang-ts-0.2.1.tgz` | 重新 pack 含 R14 fix |
| `aster-cloud/.github/workflows/ci.yml` | tarball SLA (e): grep typecheck-pii.js 必须 import `./typecheck/utils.js` 而非 `./typecheck.js` |
| `aster-lang-ts` vendor pattern (mirrors aster-cloud) | `file:vendor/aster-cloud-aster-lang-test-0.0.3.tgz` + `.gitignore !vendor/*.tgz` + Vendor SLA enforcement |

### R15 修复 (codex round 14 提的深层 transitive risk)

R14 fix 改 import 到 `typecheck/utils.ts` —— 但 codex round 14 指出
utils.ts 自身**仍然不是干净 leaf**:
- 模块加载时调用 `loadPrefixes()` → `require('node:module')`
- 其他函数 `require('node:path')` / `process.cwd()`
- 当前 Next.js webpack `nodejs_compat` 兜底没炸, 但任何更严格 bundler 会卡

**Critical split**: 拆纯 leaf 模块, browser-reachable 路径不再触碰 utils.ts:

| 模块 | 角色 |
|------|------|
| `typecheck/pure.ts` (NEW) | browser-safe leaf, 纯类型助手 + IO/CPU DEFAULT 前缀。所有 browser-reachable typecheck/* 文件 import from here |
| `typecheck/alias.ts` (NEW) | 纯 resolveAlias leaf, 无任何运行时依赖 |
| `typecheck/utils.ts` | re-export pure.ts + 保留 Node-only paths (getIOPrefixesCompat 含 createRequire('node:module'), defaultModuleSearchPaths 含 process.cwd()). 仅 server-side 模块 import |

**重写**: 11 个 browser-reachable 文件的 import 路径从 `./utils.js` → `./pure.js`:
typecheck/{context,statement,effects,generics,expression,pattern,workflow}.ts +
typecheck-pii.ts + typecheck/browser.ts + effects/effect_inference_browser.ts

**Artifact-level CI verification** (codex round 14 提的方法学修复):

`aster-lang-ts/scripts/verify-browser-entry.mjs` (NEW): 从 `dist/src/browser.js`
做 BFS transitive closure 扫描, 禁止任何 `node:*` import 出现在闭包. 在
aster-lang-ts CI workflow 集成为阻断步骤 (PR-time 拦截).

### 修复后的契约边界 (R15 更新)

| 层级 | 契约 | 验证手段 |
|------|------|---------|
| **TS 源码闭包** (middleware) | middleware.ts transitive 不得 module-load 触及 process.env | `middleware-no-process.test.ts` AST scanner |
| **TS 源码闭包** (browser entry) | browser.ts transitive 不得有任何 `node:*` import | `scripts/verify-browser-entry.mjs` BFS artifact scan (R15 新增) |
| **运行时入口** (next-intl / OpenNext / CF workerd) | 由 platform 的 `nodejs_compat` flag 提供 process polyfill | 不在本 ADR 范围 |
| **vendor tarball 内容** | 含 R6 PII 修复的关键符号 + call site + 错误码 | `aster-cloud/.github/workflows/ci.yml` tarball SLA (a-e) |
| **消费者 build** | `pnpm run build:next` (SaaS + on-prem) 必须 success | `aster-cloud` CI build job |

### 验证

```bash
# aster-lang-ts:
pnpm build && node scripts/verify-browser-entry.mjs  # OK 70 files, 0 node:* imports
pnpm run test:unit:run                              # 1055 passed | 2 skipped
pnpm run test:integration                           # all passed

# aster-cloud (consumer):
pnpm install                          # tarball 解析
pnpm exec tsc --noEmit                # 0 errors
pnpm run build:next                   # success (saas)
DEPLOYMENT_MODE=on-prem pnpm run build:next  # success (on-prem)
pnpm test:run                         # 2612 passed | 8 skipped
```

### 设计理由 (R15)

- **leaf 模块分层**: 不混合 "browser-safe helpers" 与 "Node-only helpers" 在同一文件. 物理分离 (pure.ts vs utils.ts) 比靠 try/catch wrap 更可靠 —— 任何 `require('node:X')` 在 utils.ts 都不会被 browser 路径 transitively 看到.
- **artifact-level smoke 不可替代源码 AST scanner**: 源码 scanner 抓 module-load 时的 `process.env`, artifact smoke 抓编译后闭包的 `node:*` import. 两层互补, 缺一不可. R13 仅有前者所以漏了后者.
- **修订 ADR GA-ready 评分**: R13 评分回调到 88-90 区间 (artifact 验证空缺). R15 通过 artifact-level CI 闭环后真正达到 ≥95.

### GA Re-decision

R15 之后才是真正的 GA-ready: 三层契约 (源码 AST + tarball 内容 + artifact 闭包)
+ 三个独立 CI 阻断 (middleware-no-process / tarball SLA / verify-browser-entry)
共同保证未来 PR 任何 transitive Node 依赖都会被 PR-time 抓住。


## Round 19 — vendor tarball 退役（2026-06-29）

§"迁移路径"（R12 时代）的三条件已全部满足并执行：
1. ✅ `@aster-cloud/aster-lang-ts` npm publish 成功（**1.0.6** 含 PII 跨运行时守卫全部符号 +
   typecheck-pii.js 走纯 leaf alias.js，实测确认）。
2. ✅ `aster-cloud/package.json` 改 `file:vendor/...` → npm 精确 pin `"1.0.6"`；pnpm-lock 零 vendor 引用。
3. ✅ 测试绿（lint/typecheck/e2e）。

**变更**：
- 删除 `vendor/aster-cloud-aster-lang-ts-0.2.2.tgz` + `vendor/README.md`（应急 file:vendor 方案彻底退役）。
- 删除 ci.yml「Vendor tarball SLA enforcement」step（其两段都 existence-gated，删 tarball 后全 no-op）。
- **不丢消费侧 artifact 合同**：把原 tarball 内容契约（PII 守卫符号 + call-site + E404 catch 路径 +
  typecheck-pii alias edge-safe）**retarget 到安装的 npm 包**，与原 consumer 闭包扫描（browser entry
  无 node:* builtin）**合并成单脚本** `scripts/verify-aster-lang-browser-artifact.mjs`。
- 旧 `scripts/verify-vendor-browser-entry.mjs` 删除。

**为何保留消费侧检查（不只信 aster-lang-ts CI）**：信任边界不同——lang-ts CI 证明「发布源构建
当时合格」，消费侧证明「aster-cloud 实际装进 node_modules 的包合格」。精确 pin + lockfile 防无意
漂移，但挡不住 PR 把依赖改/回退到不含 ADR-0009 修复的旧版本——消费侧 fail-closed 挡这一类
（Codex round 19 复核：删 tarball 但保留 retargeted 合同 = 清债不牺牲供应链防御）。三层契约不变：
源码 AST 层（lang-ts）+ 发布前 dist 扫描（lang-ts pre-pack）+ 消费侧安装 artifact 合同（本脚本）。
