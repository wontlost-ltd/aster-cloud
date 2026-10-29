# Truffle 安全架构 - 操作日志

> **已下线（2026-10-30，cloud#655）**：下文涉及的 `secure-execute` 路由、`secure-executor.ts` 与 `POLICY_SIGNING_SECRET` 均已移除，仅作历史记录。

## 概述

本工作流设计 Aster Policy 的安全执行架构，基于 GraalVM Truffle 运行时，实现纵深防御策略。

## 日志记录

### 2026-01-14

#### 架构设计完成

**背景分析**：

用户提出关于策略执行安全的关键问题：

1. aster-lang-ts 前端解析旨在实时反馈编译问题
2. 如果集成 Truffle，是否存在功能重复
3. 如果源码在传输中被 MITM 篡改怎么办

**设计决策**：

1. **保留 aster-lang-ts**：用于前端实时 UX 反馈，但不信任其结果
2. **Truffle 作为二次验证**：后端独立解析，不依赖前端编译结果
3. **哈希锁定机制**：执行时不传递源码，只传递 `policyId + hash`
4. **从数据库读取源码**：MITM 无法篡改已批准的策略

**安全架构层次**：

| 层 | 防护措施 | 防护目标 |
|---|---------|---------| 
| 第 1 层 | TLS 1.3 + 证书固定 | 网络层 MITM |
| 第 2 层 | 请求签名 (HMAC-SHA256) | 请求篡改 |
| 第 3 层 | 策略版本控制 + 链式哈希 | 版本完整性 |
| 第 4 层 | 哈希锁定执行 | 源码篡改 |
| 第 5 层 | 审批工作流 + 四眼原则 | 内部威胁 |

**创建的文件**：

- `docs/workstreams/truffle-security-architecture/README.md` - 完整架构文档
- `docs/workstreams/truffle-security-architecture/operations-log.md` - 操作日志
- `docs/workstreams/truffle-security-architecture/implementation-guide.md` - 实施指南

**下一步行动**：

1. 根据 README.md 中的实施路线图开始开发
2. 阶段 1：基础安全层（Prisma Schema 扩展、签名验证）
3. 阶段 2：审批工作流
4. 阶段 3：安全执行层（Quarkus + Truffle 集成）
5. 阶段 4：监控与审计

---

### 2026-01-14（续）

#### 阶段 1 实施完成

**实施内容**：

基于实施指南完成了安全架构的基础层开发：

**1. Prisma Schema 扩展** (`prisma/schema.prisma`)
- 扩展 `PolicyVersion` 模型，添加安全字段（source, sourceHash, prevHash, status, isDefault 等）
- 新增 `PolicyVersionStatus` 枚举（DRAFT, PENDING_APPROVAL, APPROVED, REJECTED, DEPRECATED, ARCHIVED）
- 新增 `PolicyApproval` 模型（审批记录）
- 新增 `ApprovalDecision` 枚举
- 新增 `UsedNonce` 模型（防重放攻击）
- 新增 `SecurityEvent` 模型（安全事件日志）
- 新增 `SecurityEventType` 和 `EventSeverity` 枚举

**2. 安全服务层** (`src/services/security/`)
- `policy-security.ts` - 哈希计算、签名生成和验证、时间戳验证
- `nonce-service.ts` - Nonce 检查、记录和清理
- `security-event-service.ts` - 安全事件记录和查询
- `secure-executor.ts` - 安全执行器（签名验证 + 哈希锁定 + 策略执行）
- `index.ts` - 模块导出

**3. 版本管理服务** (`src/services/policy/version-manager.ts`)
- 版本创建（链式哈希）
- 版本更新（仅限草稿）
- 提交审批
- 审批版本（含四眼原则检查）
- 设置默认版本
- 废弃/归档版本
- 版本查询

**4. API 路由** (`src/app/api/v1/policies/[id]/`)
- `secure-execute/route.ts` - 安全执行端点
- `versions/route.ts` - 版本列表和创建
- `versions/[version]/set-default/route.ts` - 设置默认版本
- `versions/[version]/deprecate/route.ts` - 废弃版本
- `versions/[version]/archive/route.ts` - 归档版本

**5. 前端 Hooks** (`src/hooks/`)
- `use-secure-policy-execute.ts` - 安全执行 Hook
- `use-policy-versions.ts` - 版本管理 Hook

**6. 定时任务** (`src/cron/` 和 `src/app/api/cron/`)
- `cleanup-nonces.ts` - Nonce 清理任务
- `cleanup-nonces/route.ts` - Cron API 端点

**创建的文件清单**：

```
src/services/security/
├── index.ts
├── nonce-service.ts
├── policy-security.ts
├── secure-executor.ts
└── security-event-service.ts

src/services/policy/
└── version-manager.ts

src/app/api/v1/policies/[id]/
├── secure-execute/
│   └── route.ts
└── versions/
    ├── route.ts
    └── [version]/
        ├── archive/
        │   └── route.ts
        ├── deprecate/
        │   └── route.ts
        └── set-default/
            └── route.ts

src/hooks/
├── use-policy-versions.ts
└── use-secure-policy-execute.ts

src/cron/
└── cleanup-nonces.ts

src/app/api/cron/cleanup-nonces/
└── route.ts
```

**下一步行动**：

1. 运行 `npx prisma db push` 应用数据库迁移
2. 配置环境变量 `POLICY_SIGNING_SECRET` 和 `CRON_SECRET`
3. 配置 Vercel Cron 定时清理（vercel.json）
4. 集成前端组件使用新的 Hooks
5. 阶段 2：实现完整的审批工作流 UI

---

## 关键设计原则

### 零信任架构

```
前端验证 (UX) ≠ 后端验证 (Security)
两者独立，互不信任
```

### 哈希锁定

```
执行请求不包含源码，只包含：
- policyId: 策略 ID
- hash: 客户端计算的源码哈希
- input: 执行参数
- signature: 请求签名
- timestamp + nonce: 防重放

服务端：
1. 验证签名
2. 验证 nonce 未使用
3. 验证时间戳在窗口内
4. 从数据库读取已批准策略
5. 验证哈希匹配
6. 使用数据库中的源码执行（不使用任何客户端提供的源码）
```

### 四眼原则

```
策略创建者 ≠ 策略审批者
强制人工审核，防止内部威胁
```

---

## 参考资料

- [GraalVM Truffle 文档](https://www.graalvm.org/latest/graalvm-as-a-platform/language-implementation-framework/)
- [aster-truffle 实现](../../aster-lang/aster-truffle/)
- [quarkus-policy-api 当前实现](../../aster-lang/quarkus-policy-api/)
