# Truffle 安全架构

> **已下线（2026-10-30）**：本文描述的 `POST /api/v1/policies/{id}/secure-execute`（共享密钥 HMAC 签名执行）及
> `src/services/security/secure-executor.ts` 已移除（#654）。原因：生产从未配置 `POLICY_SIGNING_SECRET`，验签实际以空串
> 进行，签名形同虚设；原客户端方案还要求浏览器读取 `NEXT_PUBLIC_` 密钥，等于公开密钥；该端点只认登录会话、不认 API Key，
> 界面也没有调用方。普通执行路径已按当前生效版本、envelope 校验与冻结词汇快照执行。将来如需「按指定版本执行」，
> 应在普通 execute / v1 execute 上加可选的期望版本哈希参数，复用现有认证与配额。以下为历史设计，仅供参考。

## 概述

本文档定义 Aster Policy 的安全执行架构，基于 GraalVM Truffle 运行时，实现纵深防御策略。

## 架构决策

### 保留 aster-lang-ts

**用途**：前端实时 UX 反馈（语法高亮、编译错误提示）

**原则**：前端验证结果不被后端信任，仅用于用户体验

```
用户编辑 CNL → aster-lang-ts 实时解析 → 显示编译诊断
                    ↓
              仅用于 UX，不影响执行安全
```

### Truffle 作为独立验证层

**用途**：后端独立解析与执行，不依赖前端编译结果

**原则**：零信任架构，前后端验证完全独立

```
执行请求 → 后端从数据库读取源码 → Truffle 独立编译 → 执行
                    ↓
              不信任任何客户端数据
```

## 威胁模型

| 威胁 | 攻击向量 | 防护措施 |
|------|---------|---------|
| 网络层 MITM | 拦截/篡改 HTTP 请求 | TLS 1.3 + 证书固定 |
| 请求篡改 | 修改请求体内容 | HMAC-SHA256 签名 |
| 重放攻击 | 重发有效签名请求 | Nonce + 时间戳窗口 |
| 源码注入 | 执行时注入恶意代码 | 哈希锁定执行 |
| 版本回退 | 执行旧版本策略 | 链式哈希版本控制 |
| 内部威胁 | 恶意内部人员 | 四眼原则审批工作流 |

## 五层防御架构

### 第 1 层：传输安全

```
┌─────────────────────────────────────────┐
│           TLS 1.3 + 证书固定             │
├─────────────────────────────────────────┤
│ • 强制 HTTPS                            │
│ • 证书固定（Certificate Pinning）        │
│ • 禁用弱密码套件                         │
└─────────────────────────────────────────┘
```

### 第 2 层：请求签名

```typescript
interface SignedRequest {
  policyId: string;
  hash: string;           // SHA-256(source)
  input: unknown;
  timestamp: number;      // Unix 毫秒
  nonce: string;          // UUID v4
  signature: string;      // HMAC-SHA256(payload, secret)
}
```

**签名验证流程**：
1. 验证时间戳在 5 分钟窗口内
2. 验证 nonce 未被使用过
3. 重建签名并比对
4. 记录 nonce 防止重放

### 第 3 层：版本控制

```
┌──────────────────────────────────────────────────────┐
│                  策略版本链                           │
├──────────────────────────────────────────────────────┤
│  v1: hash_1 = SHA256(source_1)                       │
│  v2: hash_2 = SHA256(source_2 + hash_1)              │
│  v3: hash_3 = SHA256(source_3 + hash_2)              │
│                    ⋮                                  │
│  vN: hash_N = SHA256(source_N + hash_{N-1})          │
└──────────────────────────────────────────────────────┘
```

**防护能力**：
- 任何历史版本被篡改，后续所有哈希失效
- 无法插入、删除或替换中间版本

### 第 4 层：哈希锁定执行

**核心原则**：执行请求不传递源码

```
客户端                              服务端
   │                                   │
   │  { policyId, hash, input, sig }   │
   ├──────────────────────────────────→│
   │                                   │
   │                         ┌─────────┴─────────┐
   │                         │ 1. 验证签名       │
   │                         │ 2. 验证 nonce     │
   │                         │ 3. 从 DB 读取源码  │
   │                         │ 4. 计算 SHA256    │
   │                         │ 5. 比对 hash      │
   │                         │ 6. 执行 DB 源码   │
   │                         └─────────┬─────────┘
   │                                   │
   │        { result }                 │
   │←──────────────────────────────────┤
```

**关键点**：
- 客户端计算的 hash 仅用于校验
- 实际执行的源码来自数据库
- MITM 无法注入代码，因为执行的是 DB 中的审批版本

### 第 5 层：审批工作流

```
┌──────────────────────────────────────────────────────┐
│                  四眼原则                            │
├──────────────────────────────────────────────────────┤
│                                                      │
│   创建者 ──→ 提交审批 ──→ 审批者 ──→ 批准/拒绝       │
│     ↑                        │                      │
│     │        (创建者 ≠ 审批者)                       │
│     │                        ↓                      │
│     └────────── 拒绝后修改 ←─┘                       │
│                                                      │
└──────────────────────────────────────────────────────┘
```

**规则**：
- 策略创建者不能审批自己的策略
- 至少一名有权限的审批者批准
- 审批记录不可篡改

## 数据库 Schema 扩展

```prisma
// 策略版本表
model PolicyVersion {
  id           String   @id @default(cuid())
  policyId     String
  version      Int
  source       String   @db.Text
  sourceHash   String   // SHA-256
  prevHash     String?  // 链式哈希
  createdBy    String
  createdAt    DateTime @default(now())
  status       PolicyVersionStatus @default(DRAFT)

  policy       Policy   @relation(fields: [policyId], references: [id])
  approvals    PolicyApproval[]

  @@unique([policyId, version])
  @@index([policyId])
  @@index([sourceHash])
}

enum PolicyVersionStatus {
  DRAFT
  PENDING_APPROVAL
  APPROVED
  REJECTED
  DEPRECATED
}

// 审批记录表
model PolicyApproval {
  id              String   @id @default(cuid())
  versionId       String
  approverId      String
  decision        ApprovalDecision
  comment         String?
  createdAt       DateTime @default(now())

  version         PolicyVersion @relation(fields: [versionId], references: [id])

  @@index([versionId])
  @@index([approverId])
}

enum ApprovalDecision {
  APPROVED
  REJECTED
  REQUESTED_CHANGES
}

// Nonce 表（防重放）
model UsedNonce {
  id        String   @id @default(cuid())
  nonce     String   @unique
  usedAt    DateTime @default(now())
  expiresAt DateTime

  @@index([expiresAt])
}

// 安全事件日志
model SecurityEvent {
  id          String   @id @default(cuid())
  eventType   SecurityEventType
  severity    EventSeverity
  policyId    String?
  userId      String?
  ipAddress   String?
  userAgent   String?
  details     Json
  createdAt   DateTime @default(now())

  @@index([eventType])
  @@index([severity])
  @@index([createdAt])
}

enum SecurityEventType {
  SIGNATURE_INVALID
  NONCE_REUSED
  TIMESTAMP_EXPIRED
  HASH_MISMATCH
  UNAUTHORIZED_APPROVAL
  POLICY_EXECUTED
  APPROVAL_DECISION
}

enum EventSeverity {
  INFO
  WARNING
  ERROR
  CRITICAL
}
```

## API 规范

### 安全执行端点

```
POST /api/v1/policies/{id}/secure-execute
```

**请求体**：
```json
{
  "hash": "sha256:abc123...",
  "input": { "applicant": { "age": 25 } },
  "timestamp": 1705234567890,
  "nonce": "550e8400-e29b-41d4-a716-446655440000",
  "signature": "hmac-sha256:xyz789..."
}
```

**响应**：
```json
{
  "success": true,
  "result": { "approved": true, "reason": "符合条件" },
  "executionTimeMs": 42,
  "version": 3,
  "sourceHash": "sha256:abc123..."
}
```

**错误响应**：
```json
{
  "success": false,
  "error": "HASH_MISMATCH",
  "message": "请求哈希与数据库版本不匹配",
  "expectedHash": "sha256:def456...",
  "requestedHash": "sha256:abc123..."
}
```

### 版本管理端点

```
POST /api/v1/policies/{id}/versions
GET  /api/v1/policies/{id}/versions
GET  /api/v1/policies/{id}/versions/{version}
POST /api/v1/policies/{id}/versions/{version}/submit-for-approval
POST /api/v1/policies/{id}/versions/{version}/approve
POST /api/v1/policies/{id}/versions/{version}/reject
```

## 实施路线图

### 阶段 1：基础安全层（1-2 周）

- [ ] Prisma Schema 扩展与迁移
- [ ] 签名验证中间件
- [ ] Nonce 服务与清理任务
- [ ] 安全事件日志服务

### 阶段 2：版本控制（1 周）

- [ ] PolicyVersion CRUD API
- [ ] 链式哈希计算
- [ ] 版本历史 UI

### 阶段 3：审批工作流（1-2 周）

- [ ] 审批 API
- [ ] 四眼原则验证
- [ ] 审批通知
- [ ] 审批 UI

### 阶段 4：安全执行（1 周）

- [ ] 哈希锁定执行 API
- [ ] 客户端签名 Hook
- [ ] 监控仪表板

## 验收标准

### 功能验收

- [ ] 签名验证：无效签名被拒绝
- [ ] Nonce 验证：重放请求被拒绝
- [ ] 时间戳验证：过期请求被拒绝
- [ ] 哈希验证：不匹配的哈希被拒绝
- [ ] 审批工作流：创建者无法自审批
- [ ] 版本控制：链式哈希验证通过

### 安全验收

- [ ] MITM 测试：篡改请求被检测
- [ ] 重放测试：重放攻击被阻止
- [ ] 注入测试：恶意代码无法执行
- [ ] 权限测试：越权操作被拒绝

### 性能验收

- [ ] 签名验证延迟 < 5ms
- [ ] Nonce 查询延迟 < 10ms
- [ ] 哈希计算延迟 < 1ms
- [ ] 整体执行延迟增加 < 20ms

## 参考资料

- [GraalVM Truffle 文档](https://www.graalvm.org/latest/graalvm-as-a-platform/language-implementation-framework/)
- [OWASP API 安全](https://owasp.org/www-project-api-security/)
- [HMAC-SHA256 规范](https://datatracker.ietf.org/doc/html/rfc2104)
