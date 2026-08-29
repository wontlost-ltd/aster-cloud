# S2-1a-2 Slice-2b-launch 实现计划（in-cluster Go runner-launcher）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐单元/逐任务实现。每个实现步骤严格 TDD：先写失败测试 → `go test ./...` 看红 → 写实现 → 看绿 → commit。步骤用 checkbox（`- [ ]`）追踪。**本计划只写 launcher 微服务与其 k8s manifests，不改 aster-api runner 字节、不改 cloud F client。**

**Goal:** 实现 in-cluster Go runner-launcher 微服务：收 cloud（CF Worker 经 Cloudflare Tunnel）的 7 行 canonical HMAC 请求（独立 key）→ 验签 → 用 client-go 建 digest-pinned Kubernetes Job 真跑 Slice-2a 已签名的 runner 镜像（Fork C：initContainer 写 request 到 emptyDir + 主容器 command 覆写 stdin 重定向）→ watch 到终态 → 读 Pod log 取 runner envelope → 映射为 F 契约响应（SUCCESS/ERROR 皆 200，不可达非 200）回传。launcher 只编排不产证据，透传 runner envelope 不改字段。

**Architecture:** 独立 Go 微服务（`net/http` handler + client-go Job 编排），部署到 k3s `aster-runner` 命名空间（2b-seed 已种脚手架）。三个内聚单元 + manifests：HMAC 验证中间件（无状态，独立 key）→ Job 编排器（per-invocation ConfigMap owner-ref 级联 GC + Job watch + Pod log 读 envelope + exit code 权威）→ HTTP handler（镜像 F client 的 reject-proof 契约）→ k8s manifests（硬化 Deployment + 最小 SA RBAC + Service + external-secrets + network-policy）。runner digest 由 launcher Deployment `RUNNER_IMAGE_DIGEST` env 注入（Fork A），image-pin 脚本第三写目标 patch 之（跨仓，另篇）。

**Tech Stack:** Go (net/http + k8s client-go), Docker multi-arch, cosign, kustomize.

## Global Constraints

**（承 spec `2026-07-21-s2-1a-2-slice2b-design.md` §Slice-2b-launch，逐字保留铁律）**

- **诚实边界（spec §诚实边界）**：本 slice 无签名 = 无 attestation 安全增量，不抗 aster-api/launcher 攻破、不解锁签字。它建 **runner 编排骨架 + 集成 parity**，称 **integration/orchestration milestone**，非 attestation 增量。
- **launcher 是新 TCB 成员（spec §3b）**：只编排不产证据（证据仍由 runner 产、S2-1b 才签），launcher 镜像 cosign-verified admission，审计。MVP 不具备 §3b 完整绑定（imageID 可信观察/challenge 原子消费/SVID 签）——那是 S2-1b/-1c。
- **parity 证集成正确性非算法独立性（spec §4）**：runner 与 aster-api 跑同一份 executor 代码，byte-parity 近乎定义性；差分门守的是「打包/镜像/launcher/Job 环境未在共享代码外引入分叉」。
- **Fork C（stdin 注入）**：per-invocation ConfigMap 持 RunnerRequest JSON → initContainer copy 到 emptyDir `/work/request.json` → 主容器 `command: ["/bin/sh","-c","exec /app/bin/runner < /work/request.json"]` 覆写（runner 镜像字节不变）。
- **Fork C（envelope 读协议）**：读全 Pod log（**不 2>/dev/null**，保诊断），取**最后一行能解析为合法 RunnerEnvelope JSON**（有 outcome∈{SUCCESS,ERROR}）；**exit code 作 SUCCESS/ERROR/序列化失败权威**（RunnerMain 0/1/3）；日志截断/不可解析 → fail-closed 到 unavailable。
- **Fork A（runner digest 载体）**：image = `docker.io/wontlost/aster-replay-runner@${RUNNER_IMAGE_DIGEST}`（从 launcher Deployment env 读）。
- **launcher Go 源码目录 = `aster-api/launcher/`**（NOT a Gradle module——独立 Go，own go.mod/Dockerfile/deploy workflow `aster-runner-launcher-deploy.yml`；复用 runner 已验证的 CI/cosign 模式，与 runner 同仓便于 image-pin workflow 同处）。
- **简体中文注释。禁止 MVP/占位符**（除容量数字——那是唯一延后项，且延后本身是有测量流程的具体 task）。
- **launcher 绝不裸 500**——始终结构化响应（镜像 cloud client 的 reject-proof 契约：whole-body try + safeErrorMessage + finally guard；业务错也返回结构化 200，仅系统性不可达才非 200）。
- **HMAC key 隔离**（`ASTER_RUNNER_LAUNCHER_HMAC_KEY`，绝不 fallback 到 plan-gate key）。
- **SA RBAC 最小**（无 pods/attach，无 cluster-scope，仅 `aster-runner` ns）。
- **launcher 只编排不产证据**（透传 runner envelope 不改字段）。
- **本地验证（无 CI 外包）**：Go 单测 HMAC；orchestrator 集成测试用 `LAUNCHER_E2E=1` gate 跑本地 kind/k3d，无集群时跳过。
- **★launcher 镜像信任根（allowed-images + CIP）2b-seed 未覆盖**（2b-seed 只种了 runner 镜像的信任根）——launcher 镜像的 allowed-images 条 + 两 ClusterImagePolicy CIP 是本 slice 的额外信任根种子（诚实标注为 gap，本 slice 补）。
- 仓根：launcher 源码 = `/Users/rpang/IdeaProjects/aster-api/launcher/`（本计划源码路径相对它）；manifests = `/Users/rpang/IdeaProjects/k3s/apps/aster-lang/aster-runner/`（Units 3-6，PART 2）。

---

## Unit 1 — HMAC 验证中间件（Go）

**职责：** 验 cloud→launcher 的 7 行 canonical HMAC（独立 key `ASTER_RUNNER_LAUNCHER_HMAC_KEY`），时间戳窗口 ±300s，常量时间比对。无状态。

**契约（须逐字节匹配已上线 stub `runner-launcher-stub.ts` + client `signRunnerLauncherHeaders`）：**
- Endpoint `POST /api/v1/runner/launch`。
- Headers：`X-Internal-Caller: cloud-runner-launcher`（非此→401）、`X-Aster-Timestamp`（unix **秒**）、`X-Aster-Nonce`、`X-Aster-Tenant`、`X-Aster-Role`、`X-Internal-Signature`。
- Canonical（7 行 `\n`-joined）：`method\npath\ntimestamp\nnonce\nbodyHash\ntenant\nrole`；`bodyHash` = 小写 hex sha256(raw UTF-8 body)；signature = 小写 hex HMAC-SHA256(`ASTER_RUNNER_LAUNCHER_HMAC_KEY`, canonical)。★注意：canonical 用的是收到的 **原始 timestamp 字符串**（非 parse 后再 format），逐字对齐 stub `runner-launcher-stub.ts:46` 的 `${timestamp}`。
- **验证顺序（from stub `runner-launcher-stub.ts:29-51`）**：
  1. 缺任一必需 header 或 `X-Internal-Caller !== "cloud-runner-launcher"` → **401**。
  2. 时间戳 ±300s 窗口，**parse/finite 守卫在前**（`Number.isFinite` 等价）→ NaN/过期/未来越界 → **401**（fail-fast，不做无谓 crypto）。
  3. 重算 `bodyHash` 重建 canonical → 常量时间 HMAC 比对（Go `hmac.Equal`）→ 不匹配 → **403**。
- **Nonce 去重（诚实标注）**：stub 不去重（无状态）。**本 MVP 不做 nonce store**——重放保护靠时间戳 ±300s 窗 + cloud 每次生成 fresh nonce（`generateNonce`，16 字节 crypto random）。**nonce store 是 S2-1b 加固**，本 slice 明确不实现。

**接口：** `VerifyHMAC(r *http.Request, body []byte) (tenant, role string, status int)`——`status == 0` 表示通过（返回 tenant/role），非 0 为 HTTP 拒绝码（401/403），此时 tenant/role 为 `""`。★body 由 handler 预读一次（`io.ReadAll` after limit），避免 `VerifyHMAC` 与后续 JSON 解析重复读 body（body 不可重读）。

### Task 1.1: 项目脚手架 + 常量

**Files:**
- Create: `aster-api/launcher/go.mod`
- Create: `aster-api/launcher/internal/auth/hmac.go`
- Create: `aster-api/launcher/internal/auth/hmac_test.go`

**Interfaces:**
- Produces: 包 `auth`，导出 `VerifyHMAC(r *http.Request, body []byte) (tenant, role string, status int)` 与常量 `ExpectedCaller = "cloud-runner-launcher"`、`TimestampWindowSeconds = 300`。

- [ ] **Step 1（RED）：先写 `go.mod` + 失败测试**

`aster-api/launcher/go.mod`（Go 1.23；client-go 依赖在 Unit 2 引入，Unit 1 仅用标准库）：

```go
module github.com/aster-cloud/aster-api/launcher

go 1.23
```

`aster-api/launcher/internal/auth/hmac_test.go`（表驱动，覆盖 valid / tampered-sig / expired-ts / future-ts-beyond-window / wrong-caller / missing-header / NaN-ts）：

```go
package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"
)

// 测试用固定 key（与 client signRunnerLauncherHeaders 的 ASTER_RUNNER_LAUNCHER_HMAC_KEY 同角色）。
const testKey = "test-runner-launcher-hmac-key"

// signCanonical 复刻 client 侧签名：小写 hex HMAC-SHA256(key, 7 行 canonical)。
// ★测试是契约的可执行规格——它必须与 signRunnerLauncherHeaders 逐字节一致，否则守不住 drift。
func signCanonical(t *testing.T, key, method, path, ts, nonce string, body []byte, tenant, role string) string {
	t.Helper()
	sum := sha256.Sum256(body)
	bodyHash := hex.EncodeToString(sum[:])
	canonical := strings.Join([]string{method, path, ts, nonce, bodyHash, tenant, role}, "\n")
	mac := hmac.New(sha256.New, []byte(key))
	mac.Write([]byte(canonical))
	return hex.EncodeToString(mac.Sum(nil))
}

// buildRequest 造一个带全套签名头的 *http.Request（body 单独返回供 VerifyHMAC 用）。
func buildRequest(t *testing.T, key, tenant, role string, ts int64, tamper func(h http.Header)) (*http.Request, []byte) {
	t.Helper()
	const method, path, nonce = "POST", "/api/v1/runner/launch", "0123456789abcdef0123456789abcdef"
	body := []byte(`{"tenantId":"t1","source":"m","input":{},"locale":"en-US","functionName":"f","aliasSet":null}`)
	tsStr := strconv.FormatInt(ts, 10)
	sig := signCanonical(t, key, method, path, tsStr, nonce, body, tenant, role)
	r := httptest.NewRequest(method, path, nil)
	r.Header.Set("X-Internal-Caller", ExpectedCaller)
	r.Header.Set("X-Aster-Timestamp", tsStr)
	r.Header.Set("X-Aster-Nonce", nonce)
	r.Header.Set("X-Aster-Tenant", tenant)
	r.Header.Set("X-Aster-Role", role)
	r.Header.Set("X-Internal-Signature", sig)
	if tamper != nil {
		tamper(r.Header)
	}
	return r, body
}

func TestVerifyHMAC(t *testing.T) {
	t.Setenv("ASTER_RUNNER_LAUNCHER_HMAC_KEY", testKey)
	now := time.Now().Unix()

	cases := []struct {
		name       string
		ts         int64
		tamper     func(h http.Header)
		wantStatus int // 0 = 通过
	}{
		{"valid", now, nil, 0},
		{"tampered-sig-403", now, func(h http.Header) { h.Set("X-Internal-Signature", "deadbeef"+h.Get("X-Internal-Signature")[8:]) }, http.StatusForbidden},
		{"expired-ts-401", now - 400, nil, http.StatusUnauthorized},
		{"future-ts-beyond-window-401", now + 400, nil, http.StatusUnauthorized},
		{"wrong-caller-401", now, func(h http.Header) { h.Set("X-Internal-Caller", "cloud-bff") }, http.StatusUnauthorized},
		{"missing-header-401", now, func(h http.Header) { h.Del("X-Aster-Nonce") }, http.StatusUnauthorized},
		{"nan-ts-401", now, func(h http.Header) { h.Set("X-Aster-Timestamp", "abc") }, http.StatusUnauthorized},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r, body := buildRequest(t, testKey, "t1", "user", tc.ts, tc.tamper)
			// ★NaN-ts 用例改了 header 里的 ts 但签名用的是原始有效 ts——本用例意在 ts parse 守卫
			//   先于 crypto 触发（stub:34-36）。故直接断言 status，不要求签名对这条也成立。
			gotTenant, gotRole, gotStatus := VerifyHMAC(r, body)
			if gotStatus != tc.wantStatus {
				t.Fatalf("status=%d want=%d", gotStatus, tc.wantStatus)
			}
			if tc.wantStatus == 0 {
				if gotTenant != "t1" || gotRole != "user" {
					t.Fatalf("tenant/role=%q/%q want t1/user", gotTenant, gotRole)
				}
			}
		})
	}
}

// 未配置 key → 500（launcher 绝不裸 panic；handler 会把 500 转结构化——见 Unit 3）。
func TestVerifyHMAC_MissingKey(t *testing.T) {
	t.Setenv("ASTER_RUNNER_LAUNCHER_HMAC_KEY", "")
	r, body := buildRequest(t, testKey, "t1", "user", time.Now().Unix(), nil)
	if _, _, status := VerifyHMAC(r, body); status != http.StatusInternalServerError {
		t.Fatalf("status=%d want 500", status)
	}
	_ = fmt.Sprint // 占位避免 import 未用（实际测试会用到 fmt/strings，见 Step 2 补 import）
}
```

- [ ] **Step 2（RED→run）：`go test ./...` 看红**

`cd aster-api/launcher && go test ./...` 应报 `undefined: VerifyHMAC` / `undefined: ExpectedCaller`。记录红。

- [ ] **Step 3（GREEN）：写 `hmac.go` 实现**

`aster-api/launcher/internal/auth/hmac.go`：

```go
// Package auth 实现 cloud→launcher 的 HMAC 验证中间件。
// 逐字节复刻已上线契约（runner-launcher-stub.ts + signRunnerLauncherHeaders）：
// 7 行 canonical、独立 key、±300s 时间戳窗口、常量时间比对。无状态（nonce 去重是 S2-1b）。
package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"os"
	"strconv"
	"strings"
)

// ExpectedCaller 是 cloud 侧 signRunnerLauncherHeaders 固定写入的 caller 标识。
// 非此值一律 401（与 stub:29 的 caller !== 'cloud-runner-launcher' 一致）。
const ExpectedCaller = "cloud-runner-launcher"

// TimestampWindowSeconds 是时间戳允许的时钟偏移窗口（秒），双向。与 stub:35 的 300 一致。
const TimestampWindowSeconds = 300

// nowUnix 抽成变量便于测试注入（默认取真实时钟）。
var nowUnix = func() int64 { return timeNowUnix() }

// VerifyHMAC 验证请求签名。返回 (tenant, role, status)：
//   - status == 0：通过，tenant/role 为已验证的 X-Aster-Tenant/X-Aster-Role。
//   - status == 401：缺 header / caller 不符 / 时间戳无效或越窗（fail-fast，不做 crypto）。
//   - status == 403：签名不匹配（key 隔离验证：错 key 签的 sig 对不上真 key）。
//   - status == 500：ASTER_RUNNER_LAUNCHER_HMAC_KEY 未配置（handler 转结构化响应）。
// body 由调用方预读一次（body 不可重读）——须是与 client 签名时逐字节一致的 raw UTF-8。
func VerifyHMAC(r *http.Request, body []byte) (tenant, role string, status int) {
	key := os.Getenv("ASTER_RUNNER_LAUNCHER_HMAC_KEY")
	if key == "" {
		return "", "", http.StatusInternalServerError
	}

	sig := r.Header.Get("X-Internal-Signature")
	timestamp := r.Header.Get("X-Aster-Timestamp")
	nonce := r.Header.Get("X-Aster-Nonce")
	caller := r.Header.Get("X-Internal-Caller")
	tenant = r.Header.Get("X-Aster-Tenant")
	role = r.Header.Get("X-Aster-Role")

	// (1) 缺签名头 / caller 不符 → 401（stub:29-31）。
	//     tenant/role 允许为空串，但 header 必须存在（client 恒发；用 Values 判存在性）。
	if sig == "" || timestamp == "" || nonce == "" || caller != ExpectedCaller ||
		!headerPresent(r, "X-Aster-Tenant") || !headerPresent(r, "X-Aster-Role") {
		return "", "", http.StatusUnauthorized
	}

	// (2) 时间戳窗口，parse/finite 守卫在前（stub:34-36）：
	//     Number('abc')=NaN 在 Go 表现为 ParseInt err → 401，避免 NaN 误放行。
	ts, err := strconv.ParseInt(timestamp, 10, 64)
	if err != nil {
		return "", "", http.StatusUnauthorized
	}
	if abs64(nowUnix()-ts) > TimestampWindowSeconds {
		return "", "", http.StatusUnauthorized
	}

	// (3) 重算 bodyHash 重建 canonical，常量时间比对（stub:44-51）。
	sum := sha256.Sum256(body)
	bodyHash := hex.EncodeToString(sum[:])
	canonical := strings.Join(
		[]string{r.Method, r.URL.Path, timestamp, nonce, bodyHash, tenant, role}, "\n")
	mac := hmac.New(sha256.New, []byte(key))
	mac.Write([]byte(canonical))
	expected := mac.Sum(nil)

	// 收到的 sig 是小写 hex；解码失败即不可能匹配 → 403。
	got, decErr := hex.DecodeString(sig)
	if decErr != nil || !hmac.Equal(got, expected) {
		return "", "", http.StatusForbidden
	}
	return tenant, role, 0
}

// headerPresent 判断 header 是否存在（区分「空串」与「缺失」——client 恒发这两个头）。
func headerPresent(r *http.Request, name string) bool {
	_, ok := r.Header[http.CanonicalHeaderKey(name)]
	return ok
}

func abs64(v int64) int64 {
	if v < 0 {
		return -v
	}
	return v
}
```

`aster-api/launcher/internal/auth/clock.go`（时钟拆一个文件，便于测试注入）：

```go
package auth

import "time"

// timeNowUnix 返回当前 unix 秒。独立小函数便于在测试里替换 nowUnix。
func timeNowUnix() int64 { return time.Now().Unix() }
```

★实现说明：`hmac.Equal` 是 Go 标准库的常量时间比较（对应 stub 用 `crypto.subtle.verify` 常量时间原语的要求）。测试文件需补 `strings` import（Step 1 骨架里 `signCanonical` 用了 `strings.Join`）。

- [ ] **Step 4（GREEN→run）：`go test ./...` 看绿**

`cd aster-api/launcher && go test ./...`——7 个子用例 + MissingKey 全绿。若 tampered-sig 用例因替换后 hex 长度奇数导致 decode err 也返回 403（可接受，同为拒绝），但为守「篡改仍是有效 hex 长度」的真常量时间路径，tamper 函数保持替换前 8 hex 字符（长度不变）。

- [ ] **Step 5: commit**

`git add aster-api/launcher/go.mod aster-api/launcher/internal/auth/ && git commit`——message：`feat(launcher): HMAC 验证中间件（7 行 canonical + 独立 key + ±300s 窗口）`。

---

## Unit 2 — Job 编排器（Go client-go）

**职责：** 建 digest-pinned runner Job（Fork C：initContainer 写 request 到 emptyDir + 主容器 command 覆写 `["/bin/sh","-c","exec /app/bin/runner < /work/request.json"]`），watch 到终态，读 Pod log 取 envelope，exit code 作 SUCCESS/ERROR/序列化失败权威。

**接口：** `runJob(ctx context.Context, clientset kubernetes.Interface, req RunnerRequest, digest string) (RunnerEnvelope, error)`。

**关键设计（承 spec §Fork C / §Fork A）：**
- image = `docker.io/wontlost/aster-replay-runner@${RUNNER_IMAGE_DIGEST}`（digest 由 `runJob` 入参传入，来源 = launcher Deployment env，Fork A）。
- per-invocation ConfigMap 持 RunnerRequest JSON，**owner-ref 到 Job**（Job 删则 ConfigMap 级联 GC）。
- Job 字段镜像 migrate-job.yaml 硬化：`ttlSecondsAfterFinished` / `backoffLimit:2` / `restartPolicy:Never` / `automountServiceAccountToken:false` / runAsNonRoot uid 1000 / seccomp RuntimeDefault / `allowPrivilegeEscalation:false` / `readOnlyRootFilesystem:true` / cap drop ALL / emptyDir `/work` + `/tmp`。
- watch 到 `status.Succeeded`/`status.Failed`，30s SLA budget via `ctx` timeout。
- 读 Pod logs（不 `2>/dev/null`）取**最后一行合法 RunnerEnvelope JSON**；用 pod 容器 **exit code**（0=SUCCESS/1=ERROR/3=序列化失败）作权威；截断/不可解析 → unavailable。

### Task 2.1: RunnerRequest / RunnerEnvelope Go 类型 + buildRunnerJob

**Files:**
- Create: `aster-api/launcher/internal/orchestrator/types.go`
- Create: `aster-api/launcher/internal/orchestrator/job.go`
- Create: `aster-api/launcher/internal/orchestrator/job_test.go`

**Interfaces:**
- Produces: `RunnerRequest`（逐字对齐 `RunnerRequest.java`：tenantId/source/input/locale/functionName/aliasSet）、`RunnerEnvelope`（逐字对齐 `RunnerEnvelope.java`：outcome/replayMetadata/errorCode/message/phase）、`ReplayMetadata`（5 replay-critical + 可选 runtimeToolchainId）、`buildRunnerJob(req, digest) (*batchv1.Job, *corev1.ConfigMap)`。

- [ ] **Step 1（RED）：写类型 + `buildRunnerJob` 的失败测试**

先在 `go.mod` 加 client-go 依赖：

```
cd aster-api/launcher
go get k8s.io/client-go@v0.31.1 k8s.io/api@v0.31.1 k8s.io/apimachinery@v0.31.1
```

`aster-api/launcher/internal/orchestrator/types.go`：

```go
// Package orchestrator 负责把一次 launch 请求编排成一个 digest-pinned runner Job，
// watch 到终态并读回 runner envelope。launcher 只编排不产证据——透传 runner 产的字段不改。
package orchestrator

// RunnerRequest 逐字对齐 aster-api runner 的 RunnerRequest.java（JSON 字段名一致）。
// role 不在此结构（role 只在 HMAC header，不进 runner request body——见 F 契约）。
type RunnerRequest struct {
	TenantID     string              `json:"tenantId"`
	Source       string              `json:"source"`
	Input        any                 `json:"input"`
	Locale       string              `json:"locale"`
	FunctionName string              `json:"functionName"`
	AliasSet     map[string][]string `json:"aliasSet"` // 可为 null（omitempty 不加——须显式发 null 对齐 Java 侧）
}

// ReplayMetadata 是 5 个 replay-critical 字段 + 可选 runtimeToolchainId（仅诊断，不进 parity）。
// 逐字对齐 cloud F client 的 LaunchReplayMetadata（runner-launcher-client.ts:15-22）。
type ReplayMetadata struct {
	CanonicalInputHash     *string `json:"canonicalInputHash"`
	CanonicalOutputHash    *string `json:"canonicalOutputHash"`
	CanonicalizationVersion *string `json:"canonicalizationVersion"`
	ReplayabilityStatus    *string `json:"replayabilityStatus"`
	TraceHash              *string `json:"traceHash"`
	RuntimeToolchainID     *string `json:"runtimeToolchainId,omitempty"`
}

// RunnerEnvelope 逐字对齐 aster-api runner 的 RunnerEnvelope.java（NON_NULL 序列化：
// 成功承 replayMetadata，错误承 errorCode/message/phase，二者不共存）。launcher 原样透传。
type RunnerEnvelope struct {
	Outcome        string          `json:"outcome"` // "SUCCESS" | "ERROR"
	ReplayMetadata *ReplayMetadata `json:"replayMetadata,omitempty"`
	ErrorCode      string          `json:"errorCode,omitempty"`
	Message        string          `json:"message,omitempty"`
	Phase          string          `json:"phase,omitempty"`
}
```

`aster-api/launcher/internal/orchestrator/job_test.go`（断言 Job/ConfigMap 硬化字段 + Fork C 结构）：

```go
package orchestrator

import (
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
)

func testReq() RunnerRequest {
	return RunnerRequest{
		TenantID: "t1", Source: "Module M ...", Input: map[string]any{"x": 1},
		Locale: "en-US", FunctionName: "f", AliasSet: nil,
	}
}

func TestBuildRunnerJob_ForkC_And_Hardening(t *testing.T) {
	const digest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	job, cm := buildRunnerJob(testReq(), digest)

	// ConfigMap 持 request.json，且 owner-ref 到 Job（级联 GC）。
	if _, ok := cm.Data["request.json"]; !ok {
		t.Fatal("configmap 缺 request.json")
	}
	if len(cm.OwnerReferences) != 1 || cm.OwnerReferences[0].Kind != "Job" {
		t.Fatalf("configmap owner-ref 未指向 Job: %+v", cm.OwnerReferences)
	}

	spec := job.Spec.Template.Spec
	// Fork A：image = @digest（不可是 tag）。
	img := spec.Containers[0].Image
	if !strings.HasSuffix(img, "@"+digest) || !strings.Contains(img, "aster-replay-runner") {
		t.Fatalf("image 未 digest-pin: %q", img)
	}
	// Fork C：主容器 command 覆写 stdin 重定向。
	wantCmd := []string{"/bin/sh", "-c", "exec /app/bin/runner < /work/request.json"}
	if strings.Join(spec.Containers[0].Command, "\x00") != strings.Join(wantCmd, "\x00") {
		t.Fatalf("主容器 command 未覆写: %v", spec.Containers[0].Command)
	}
	// Fork C：initContainer copy configmap → /work/request.json。
	if len(spec.InitContainers) != 1 {
		t.Fatalf("缺 initContainer: %v", spec.InitContainers)
	}

	// 硬化断言（镜像 migrate-job.yaml）。
	if job.Spec.BackoffLimit == nil || *job.Spec.BackoffLimit != 2 {
		t.Fatal("backoffLimit != 2")
	}
	if job.Spec.TTLSecondsAfterFinished == nil {
		t.Fatal("缺 ttlSecondsAfterFinished")
	}
	if spec.RestartPolicy != corev1.RestartPolicyNever {
		t.Fatalf("restartPolicy=%v want Never", spec.RestartPolicy)
	}
	if spec.AutomountServiceAccountToken == nil || *spec.AutomountServiceAccountToken {
		t.Fatal("automountServiceAccountToken 应为 false")
	}
	if spec.SecurityContext == nil || spec.SecurityContext.RunAsNonRoot == nil || !*spec.SecurityContext.RunAsNonRoot {
		t.Fatal("runAsNonRoot 应为 true")
	}
	c := spec.Containers[0].SecurityContext
	if c == nil || c.ReadOnlyRootFilesystem == nil || !*c.ReadOnlyRootFilesystem {
		t.Fatal("readOnlyRootFilesystem 应为 true")
	}
	if c.AllowPrivilegeEscalation == nil || *c.AllowPrivilegeEscalation {
		t.Fatal("allowPrivilegeEscalation 应为 false")
	}
	if c.Capabilities == nil || len(c.Capabilities.Drop) == 0 || c.Capabilities.Drop[0] != "ALL" {
		t.Fatal("capabilities 应 drop ALL")
	}
	// emptyDir /work + /tmp 均可写（readOnlyRootFilesystem 下靠 emptyDir 提供可写路径）。
	var work, tmp bool
	for _, v := range spec.Volumes {
		if v.EmptyDir == nil {
			continue
		}
		switch v.Name {
		case "work":
			work = true
		case "tmp":
			tmp = true
		}
	}
	if !work || !tmp {
		t.Fatalf("缺 emptyDir work/tmp: work=%v tmp=%v", work, tmp)
	}
}
```

- [ ] **Step 2（RED→run）：`go test ./...` 看红**

报 `undefined: buildRunnerJob`。记录红。

- [ ] **Step 3（GREEN）：写 `buildRunnerJob`**

`aster-api/launcher/internal/orchestrator/job.go`：

```go
package orchestrator

import (
	"encoding/json"
	"fmt"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// 镜像仓库前缀——digest 由 Fork A 从 launcher Deployment env RUNNER_IMAGE_DIGEST 传入。
const runnerImageRepo = "docker.io/wontlost/aster-replay-runner"

// runnerNamespace 是 launcher 建 Job 的目标 ns（与 launcher 同 ns，2b-seed 已建）。
const runnerNamespace = "aster-runner"

// buildRunnerJob 造一个 digest-pinned runner Job + per-invocation ConfigMap。
// ★Fork C：ConfigMap 持 request.json → initContainer copy 到 emptyDir /work → 主容器
//   command 覆写为 stdin 重定向（runner 镜像字节不变）。ConfigMap owner-ref 到 Job（级联 GC）。
// ★硬化镜像 migrate-job.yaml：backoffLimit/ttl/restartPolicy/token/securityContext/emptyDir。
// digest 形如 "sha256:...."；image = <repo>@<digest>。jobName 用调用方生成的唯一名（见 runJob）。
func buildRunnerJob(req RunnerRequest, digest string) (*batchv1.Job, *corev1.ConfigMap) {
	jobName := newJobName()

	// request.json：runner 逐字读 stdin 的 RunnerRequest JSON（aliasSet 显式 null 对齐 Java）。
	reqJSON, _ := json.Marshal(req) // req 全为可序列化标量/map，不会失败；防御性忽略 err 由 runJob 前置校验兜底

	falsePtr := boolPtr(false)
	truePtr := boolPtr(true)
	uid := int64Ptr(1000)
	backoff := int32Ptr(2)
	ttl := int32Ptr(300) // 5min 后 GC；比 30s SLA 宽裕，便于失败时短暂保留日志

	cm := &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{
			Name:      jobName, // 与 Job 同名，便于关联
			Namespace: runnerNamespace,
		},
		Data: map[string]string{"request.json": string(reqJSON)},
	}

	job := &batchv1.Job{
		ObjectMeta: metav1.ObjectMeta{
			Name:      jobName,
			Namespace: runnerNamespace,
			Labels:    map[string]string{"app": "aster-runner-job"},
		},
		Spec: batchv1.JobSpec{
			TTLSecondsAfterFinished: ttl,
			BackoffLimit:            backoff,
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: map[string]string{"app": "aster-runner-job", "job-name": jobName}},
				Spec: corev1.PodSpec{
					RestartPolicy:                corev1.RestartPolicyNever,
					AutomountServiceAccountToken: falsePtr,
					SecurityContext: &corev1.PodSecurityContext{
						RunAsNonRoot:   truePtr,
						RunAsUser:      uid,
						RunAsGroup:     uid,
						FSGroup:        uid,
						SeccompProfile: &corev1.SeccompProfile{Type: corev1.SeccompProfileTypeRuntimeDefault},
					},
					InitContainers: []corev1.Container{{
						Name:  "write-request",
						Image: fmt.Sprintf("%s@%s", runnerImageRepo, digest), // 复用同一 runner 镜像（含 sh）
						// 从 ConfigMap 挂载点 copy 到 emptyDir /work（emptyDir 在 readOnlyRootFilesystem 下可写）。
						Command:         []string{"/bin/sh", "-c", "cp /config/request.json /work/request.json"},
						SecurityContext: hardenedContainerSecurityContext(),
						VolumeMounts: []corev1.VolumeMount{
							{Name: "config", MountPath: "/config", ReadOnly: true},
							{Name: "work", MountPath: "/work"},
						},
					}},
					Containers: []corev1.Container{{
						Name:  "runner",
						Image: fmt.Sprintf("%s@%s", runnerImageRepo, digest),
						// ★Fork C：覆写 command，把 emptyDir 里的 request.json 重定向进 runner stdin。
						Command:         []string{"/bin/sh", "-c", "exec /app/bin/runner < /work/request.json"},
						SecurityContext: hardenedContainerSecurityContext(),
						Resources:       runnerResources(), // TODO-capacity：见 Task 2.3 实测驱动
						VolumeMounts: []corev1.VolumeMount{
							{Name: "work", MountPath: "/work"},
							{Name: "tmp", MountPath: "/tmp"},
						},
					}},
					Volumes: []corev1.Volume{
						{Name: "config", VolumeSource: corev1.VolumeSource{
							ConfigMap: &corev1.ConfigMapVolumeSource{LocalObjectReference: corev1.LocalObjectReference{Name: jobName}}}},
						{Name: "work", VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{}}},
						{Name: "tmp", VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{}}},
					},
				},
			},
		},
	}

	// owner-ref：ConfigMap 属于 Job，Job 删则 ConfigMap 级联 GC（避免 per-invocation ConfigMap 泄漏）。
	// ★owner-ref 的 UID 在 Job 由 API server 创建后才有——runJob 会在 create Job 后回填 UID 再 create ConfigMap。
	cm.OwnerReferences = []metav1.OwnerReference{{
		APIVersion: "batch/v1", Kind: "Job", Name: jobName,
		Controller: truePtr, BlockOwnerDeletion: truePtr,
	}}
	return job, cm
}

// hardenedContainerSecurityContext 是容器级硬化（镜像 migrate-job 的 container securityContext）。
func hardenedContainerSecurityContext() *corev1.SecurityContext {
	return &corev1.SecurityContext{
		AllowPrivilegeEscalation: boolPtr(false),
		ReadOnlyRootFilesystem:   boolPtr(true),
		Capabilities:             &corev1.Capabilities{Drop: []corev1.Capability{"ALL"}},
	}
}

// runnerResources 是 runner 容器的 request/limit。
// ★TODO-capacity（唯一延后项）：当前值是保守占位，正式值由 Task 2.3 实测（峰值 RSS + p95 冷启动）驱动，
//   并发 default=1。见 Task 2.3 的测量流程——不是拍脑袋数字。
func runnerResources() corev1.ResourceRequirements {
	// 占位：宽松上限便于先跑通编排 + 供 Task 2.3 测峰值。正式值替换后 commit。
	return corev1.ResourceRequirements{}
}
```

`aster-api/launcher/internal/orchestrator/util.go`（指针与命名辅助）：

```go
package orchestrator

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
)

func boolPtr(b bool) *bool    { return &b }
func int32Ptr(v int32) *int32 { return &v }
func int64Ptr(v int64) *int64 { return &v }

// newJobName 生成 per-invocation 唯一 Job 名（k8s 名须小写 DNS-1123；用 8 字节随机 hex）。
func newJobName() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return fmt.Sprintf("runner-%s", hex.EncodeToString(b))
}
```

- [ ] **Step 4（GREEN→run）：`go test ./...` 看绿**

`cd aster-api/launcher && go test ./...`——`TestBuildRunnerJob_ForkC_And_Hardening` 全绿。★注意 `runnerResources()` 当前返回空（TODO-capacity），测试不断言 resources 数值——那由 Task 2.3 补。

- [ ] **Step 5: commit**

`feat(launcher): buildRunnerJob（Fork C stdin 注入 + migrate-job 硬化 + owner-ref 级联 GC）`。

### Task 2.2: runJob — create → watch → 读 envelope

**Files:**
- Edit: `aster-api/launcher/internal/orchestrator/job.go`（加 `runJob`）
- Create: `aster-api/launcher/internal/orchestrator/run.go`
- Create: `aster-api/launcher/internal/orchestrator/run_test.go`（用 `k8s.io/client-go/kubernetes/fake`）

**Interfaces:**
- Produces: `runJob(ctx context.Context, clientset kubernetes.Interface, req RunnerRequest, digest string) (RunnerEnvelope, error)`——create ConfigMap（回填 Job UID owner-ref）→ create Job → watch 到终态 → 读 Pod log 末行 envelope；exit code 权威；截断/不可解析 → error（handler 归 unavailable）。

- [ ] **Step 1（RED）：写 `runJob` 的失败测试（fake clientset）**

`aster-api/launcher/internal/orchestrator/run_test.go`：

```go
package orchestrator

import (
	"context"
	"testing"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"
)

// 用 fake clientset 驱动：手动把 Job 标记为 Succeeded 后，runJob 应读回 envelope。
// ★Pod log 在 fake clientset 里恒返回固定串（不可注入任意 log）——故本单测覆盖
//   「create + watch 终态 + exit code 分类」的编排逻辑；真 log 解析走 Task 2.4 集成测试。
func TestRunJob_SucceedsAndReadsEnvelope(t *testing.T) {
	const digest = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	cs := fake.NewSimpleClientset()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// 后台 goroutine 模拟 Job controller：等 Job 出现后标 Succeeded=1。
	go func() {
		for i := 0; i < 50; i++ {
			jobs, _ := cs.BatchV1().Jobs(runnerNamespace).List(ctx, metav1.ListOptions{})
			if len(jobs.Items) == 1 {
				j := jobs.Items[0].DeepCopy()
				j.Status.Succeeded = 1
				j.Status.Conditions = []batchv1.JobCondition{{Type: batchv1.JobComplete, Status: "True"}}
				_, _ = cs.BatchV1().Jobs(runnerNamespace).UpdateStatus(ctx, j, metav1.UpdateOptions{})
				return
			}
			time.Sleep(20 * time.Millisecond)
		}
	}()

	env, err := runJob(ctx, cs, testReq(), digest)
	if err != nil {
		t.Fatalf("runJob err: %v", err)
	}
	if env.Outcome != "SUCCESS" {
		t.Fatalf("outcome=%q want SUCCESS", env.Outcome)
	}
}

func TestRunJob_TimeoutIsError(t *testing.T) {
	const digest = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
	cs := fake.NewSimpleClientset()
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	// 不模拟 controller → Job 永不终态 → ctx 超时 → error（handler 归 unavailable）。
	if _, err := runJob(ctx, cs, testReq(), digest); err == nil {
		t.Fatal("期望超时 error，得 nil")
	}
}
```

- [ ] **Step 2（RED→run）：看红**（`undefined: runJob`）。

- [ ] **Step 3（GREEN）：写 `runJob`（`run.go`）**

`aster-api/launcher/internal/orchestrator/run.go`：

```go
package orchestrator

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
)

// ErrUnavailable 表示编排层系统性失败（超时/日志不可解析/Job 消失）——handler 归 F 契约的 unavailable。
var ErrUnavailable = errors.New("runner job unavailable")

// runJob 编排一次 runner 执行：create Job → create owner-ref'd ConfigMap → watch 终态
// （受 ctx 30s SLA 约束）→ 读 Pod log 末行 envelope，用 exit code 作权威。
// 任何系统性失败返回 (zero, err)——handler 绝不裸 500，会转结构化 unavailable。
func runJob(ctx context.Context, clientset kubernetes.Interface, req RunnerRequest, digest string) (RunnerEnvelope, error) {
	job, cm := buildRunnerJob(req, digest)

	// 先 create Job 拿到 UID，回填 ConfigMap owner-ref 的 UID，再 create ConfigMap（级联 GC 精确）。
	created, err := clientset.BatchV1().Jobs(runnerNamespace).Create(ctx, job, metav1.CreateOptions{})
	if err != nil {
		return RunnerEnvelope{}, fmt.Errorf("%w: create job: %v", ErrUnavailable, err)
	}
	cm.OwnerReferences[0].UID = created.UID
	if _, err := clientset.CoreV1().ConfigMaps(runnerNamespace).Create(ctx, cm, metav1.CreateOptions{}); err != nil {
		return RunnerEnvelope{}, fmt.Errorf("%w: create configmap: %v", ErrUnavailable, err)
	}

	// watch 到终态（Succeeded/Failed），受 ctx timeout（30s SLA budget）约束。
	terminal, err := waitForJobTerminal(ctx, clientset, created.Name)
	if err != nil {
		return RunnerEnvelope{}, err // 已含 ErrUnavailable 包装
	}

	// 读 Pod log 末行 envelope。★不 2>/dev/null——读全 log 保诊断，从末尾找首条合法 envelope。
	logs, exitCode, err := readPodLogAndExitCode(ctx, clientset, created.Name)
	if err != nil {
		return RunnerEnvelope{}, fmt.Errorf("%w: read pod log: %v", ErrUnavailable, err)
	}
	env, parseErr := lastEnvelopeLine(logs)
	if parseErr != nil {
		// 日志截断/不可解析 → fail-closed 到 unavailable（Fork C）。
		return RunnerEnvelope{}, fmt.Errorf("%w: unparseable envelope (exit=%d, jobSucceeded=%v): %v",
			ErrUnavailable, exitCode, terminal, parseErr)
	}
	// exit code 作 SUCCESS/ERROR/序列化失败权威（RunnerMain 0/1/3）：与 envelope.outcome 交叉校验。
	// exit==3（序列化失败）→ envelope 不可信 → unavailable。
	if exitCode == 3 {
		return RunnerEnvelope{}, fmt.Errorf("%w: runner serialize failure (exit 3)", ErrUnavailable)
	}
	return env, nil
}

// waitForJobTerminal poll Job 到 Succeeded>0 或 Failed>0；ctx 超时返回 ErrUnavailable。
// ★用 poll 而非 watch informer：单发短命 Job，poll 简单且无 informer 生命周期负担（复杂度 <3 层）。
func waitForJobTerminal(ctx context.Context, clientset kubernetes.Interface, name string) (succeeded bool, err error) {
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return false, fmt.Errorf("%w: watch timeout: %v", ErrUnavailable, ctx.Err())
		case <-ticker.C:
			j, gerr := clientset.BatchV1().Jobs(runnerNamespace).Get(ctx, name, metav1.GetOptions{})
			if gerr != nil {
				return false, fmt.Errorf("%w: get job: %v", ErrUnavailable, gerr)
			}
			if j.Status.Succeeded > 0 {
				return true, nil
			}
			if j.Status.Failed > 0 {
				return false, nil // Failed 也是终态——仍去读 log 拿 runner 的 ERROR envelope
			}
		}
	}
}

// readPodLogAndExitCode 找 Job 的 Pod，读全 log（不 2>/dev/null）+ 容器终止 exit code。
func readPodLogAndExitCode(ctx context.Context, clientset kubernetes.Interface, jobName string) (string, int32, error) {
	pods, err := clientset.CoreV1().Pods(runnerNamespace).List(ctx, metav1.ListOptions{
		LabelSelector: fmt.Sprintf("job-name=%s", jobName),
	})
	if err != nil {
		return "", -1, err
	}
	if len(pods.Items) == 0 {
		return "", -1, errors.New("no pod for job")
	}
	pod := pods.Items[0]

	// exit code：从 runner 容器的 terminated state 读（0/1/3）。
	var exitCode int32 = -1
	for _, cs := range pod.Status.ContainerStatuses {
		if cs.Name == "runner" && cs.State.Terminated != nil {
			exitCode = cs.State.Terminated.ExitCode
		}
	}

	// 读 log：不指定 container 时若单容器 OK；这里显式 runner。★不加 2>/dev/null（Fork C 保诊断）。
	req := clientset.CoreV1().Pods(runnerNamespace).GetLogs(pod.Name, &corev1.PodLogOptions{Container: "runner"})
	rc, err := req.Stream(ctx)
	if err != nil {
		return "", exitCode, err
	}
	defer rc.Close()
	var buf bytes.Buffer
	if _, err := buf.ReadFrom(rc); err != nil {
		return "", exitCode, err
	}
	return buf.String(), exitCode, nil
}

// lastEnvelopeLine 从 log 末尾向前找第一条能解析为合法 RunnerEnvelope（outcome∈{SUCCESS,ERROR}）的行。
// ★runner 把前置日志走 stderr、envelope 走 stdout 最后一行——但保守起见扫全 log 找末条合法 JSON。
func lastEnvelopeLine(logs string) (RunnerEnvelope, error) {
	lines := strings.Split(strings.TrimRight(logs, "\n"), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		if line == "" || !strings.HasPrefix(line, "{") {
			continue
		}
		var env RunnerEnvelope
		if err := json.Unmarshal([]byte(line), &env); err != nil {
			continue
		}
		if env.Outcome == "SUCCESS" || env.Outcome == "ERROR" {
			return env, nil
		}
	}
	return RunnerEnvelope{}, errors.New("no valid envelope line in log")
}

// bufio 引入以备大 log 逐行扫描的替代实现（当前 strings.Split 足够——单发短 log）。
var _ = bufio.NewReader
```

- [ ] **Step 4（GREEN→run）：看绿**

`cd aster-api/launcher && go test ./...`——`TestRunJob_SucceedsAndReadsEnvelope`（fake 下 Pod log 恒为 fake 固定串 `"fake logs"`，`lastEnvelopeLine` 会 parse 失败→ 该断言需调整为「Succeeded 但 log 不可解析 → ErrUnavailable」）。

★**诚实修正**：fake clientset 的 `GetLogs` 返回固定 `"fake logs"`，无法注入合法 envelope。故 `TestRunJob_SucceedsAndReadsEnvelope` 的正确断言是：Job Succeeded 但 fake log 不可解析 → 返回 `ErrUnavailable`（验证 fail-closed 路径），而**真 envelope 解析的成功路径由 Task 2.4 集成测试**（真 runner 镜像产真 envelope）覆盖。Step 1 的测试骨架据此改为：

```go
	env, err := runJob(ctx, cs, testReq(), digest)
	// fake clientset 的 pod log 不可注入合法 envelope → 编排到读 log 后 fail-closed。
	if !errors.Is(err, ErrUnavailable) {
		t.Fatalf("期望 ErrUnavailable（fake log 不可解析），得 env=%+v err=%v", env, err)
	}
```

（`lastEnvelopeLine` 的成功路径改由独立纯函数单测覆盖——见下。）

- [ ] **Step 5: `lastEnvelopeLine` / exit-code 纯函数单测**

补 `run_test.go`（纯函数，无需集群）：

```go
func TestLastEnvelopeLine(t *testing.T) {
	logs := "starting runner\nWARN something on stderr merged\n" +
		`{"outcome":"SUCCESS","replayMetadata":{"canonicalInputHash":"h","canonicalOutputHash":"o","canonicalizationVersion":"v1","replayabilityStatus":"REPLAYABLE","traceHash":"t"}}` + "\n"
	env, err := lastEnvelopeLine(logs)
	if err != nil || env.Outcome != "SUCCESS" || env.ReplayMetadata == nil {
		t.Fatalf("env=%+v err=%v", env, err)
	}
	if _, err := lastEnvelopeLine("no json here\ntruncated {\"outcome\""); err == nil {
		t.Fatal("截断 log 应 error")
	}
}
```

- [ ] **Step 6: commit**

`feat(launcher): runJob（create→watch 终态→读 Pod log 末行 envelope + exit code 权威 + fail-closed）`。

### Task 2.3: ★容量测量 task（唯一延后的数字，且延后本身是具体任务）

**这不是拍脑袋数字——是一个有测量流程的 task，产出是测量脚本 + 记录，而非硬编码常量。**

**Files:**
- Create: `aster-api/launcher/scripts/measure-runner-capacity.sh`（测量脚本）
- Edit: `aster-api/launcher/internal/orchestrator/job.go`（`runnerResources()` 填实测值 + 并发说明）
- Create: `aster-api/launcher/docs/capacity-measurement.md`（记录：测得峰值 RSS / p95 冷启动 / 定的 request/limit / 测量日期与镜像 digest）

**测量流程（承 spec §2「实测驱动，非 128Mi/512Mi 拍脑袋」）：**

- [ ] **Step 1: 用宽松 limit 跑 runner Job 测峰值**

`measure-runner-capacity.sh`：在本地 kind/k3d（或临时 namespace），先用宽松 limit（如 `memory: 2Gi`, `cpu: 2`）建 runner Job，喂 gen-expected corpus 中**最大/最复杂的 fixture**（多次 N≥20 迭代含冷启动），采集：
  - 峰值 RSS：`kubectl top pod` 轮询 + `metrics-server`，或容器退出后从 `kubectl get --raw /api/v1/nodes/.../proxy/metrics/resource` 抓 `container_memory_working_set_bytes` 峰值；无 metrics-server 时用 `kubectl exec` 前的 cgroup `memory.peak`（`/sys/fs/cgroup/memory.peak`）。
  - p95 冷启动：从 Job create 到 Pod `Running` 再到容器 `Terminated` 的墙钟时延分布（脚本记录每次 `.status.startTime` 与 terminated `.finishedAt`），取 p95。
  - ★JVM 冷启动是主成本项——runner 是 JVM 进程，首个 fixture 的启动含 JIT/类加载，须计入 p95（这也是为何 SLA budget 用 30s 而非几秒）。

- [ ] **Step 2: 据峰值 RSS + p95 冷启动设 request/limit**

规则：
  - `requests.memory` = 稳态峰值 RSS ×1.2（留头）；`limits.memory` = 峰值 RSS ×1.5（防瞬时抖动 OOMKill，但不给无谓大以免调度稀释）。
  - `requests.cpu` 保守（如 250m，JVM 启动短时占多但稳态低）；`limits.cpu` 给足冷启动（如 2）以压缩 p95 冷启动进 SLA。
  - **并发 default=1**（spec §2）：launcher 单发单 Job，不并行——`runnerResources()` 注释注明「并发默认 1；提并发前须重测聚合内存」。

- [ ] **Step 3: 把实测值填进 `runnerResources()` + 记录 `capacity-measurement.md`**

`runnerResources()` 改为（示例，数值由 Step 1/2 实测替换 `<measured>`）：

```go
func runnerResources() corev1.ResourceRequirements {
	// ★数值由 scripts/measure-runner-capacity.sh 实测（见 docs/capacity-measurement.md）：
	//   requests = 峰值RSS×1.2，limits = 峰值RSS×1.5；cpu limit 给足冷启动压 p95 进 30s SLA。
	//   并发 default=1——提并发前须重测聚合内存。
	return corev1.ResourceRequirements{
		Requests: corev1.ResourceList{
			corev1.ResourceMemory: resource.MustParse("<measured-req-mem>"),
			corev1.ResourceCPU:    resource.MustParse("250m"),
		},
		Limits: corev1.ResourceList{
			corev1.ResourceMemory: resource.MustParse("<measured-limit-mem>"),
			corev1.ResourceCPU:    resource.MustParse("2"),
		},
	}
}
```

（import `"k8s.io/apimachinery/pkg/api/resource"`；`job_test.go` 补一条断言 resources 非空——填值后启用。）

- [ ] **Step 4: commit**

`feat(launcher): 实测驱动 runner Job resources（峰值RSS×1.2/1.5，并发默认1）+ 容量测量脚本与记录`。

### Task 2.4: 集成测试（`LAUNCHER_E2E=1` gate，本地 kind/k3d）

**Files:**
- Create: `aster-api/launcher/internal/orchestrator/e2e_test.go`

**Interfaces:**
- Produces: 用 Slice-2a 本地 build 的 runner 镜像 + gen-expected corpus，真建 runner Job 跑 Fork C stdin 路径，断言读回的 envelope == aster-api 权威 expected。**无 `LAUNCHER_E2E=1` 时 `t.Skip`。**

- [ ] **Step 1: 写 gated 集成测试骨架**

`aster-api/launcher/internal/orchestrator/e2e_test.go`：

```go
package orchestrator

import (
	"context"
	"os"
	"testing"
	"time"

	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/clientcmd"
	"k8s.io/client-go/util/homedir"
	"path/filepath"
)

// TestRunJob_E2E 用真本地集群（kind/k3d）+ Slice-2a 本地 build 的 runner 镜像跑完整编排，
// 断言读回的 envelope == gen-expected corpus 里 aster-api 的权威 expected（真 stdin 路径）。
// ★gate：仅 LAUNCHER_E2E=1 才跑（无集群时跳过，不阻塞纯逻辑单测）。
//
// 前置（脚本化，见 Task 2.3/PART2 的 e2e-setup）：
//   1. kind/k3d 起本地集群；`aster-runner` namespace 已建。
//   2. Slice-2a 的 runner 镜像本地 build 并 `kind load docker-image` / `k3d image import`。
//   3. 设 RUNNER_IMAGE_DIGEST = 本地镜像 digest（或改 buildRunnerJob 走本地 tag 的 e2e 变体）。
func TestRunJob_E2E(t *testing.T) {
	if os.Getenv("LAUNCHER_E2E") != "1" {
		t.Skip("集成测试：设 LAUNCHER_E2E=1 且备好本地 kind/k3d + runner 镜像后再跑")
	}
	digest := os.Getenv("RUNNER_IMAGE_DIGEST")
	if digest == "" {
		t.Fatal("LAUNCHER_E2E=1 时须设 RUNNER_IMAGE_DIGEST（本地镜像 digest）")
	}

	// 用本机 kubeconfig 连本地集群。
	kubeconfig := filepath.Join(homedir.HomeDir(), ".kube", "config")
	cfg, err := clientcmd.BuildConfigFromFlags("", kubeconfig)
	if err != nil {
		t.Fatalf("kubeconfig: %v", err)
	}
	cs, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		t.Fatalf("clientset: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	// 从 gen-expected corpus 取一条 fixture（tenantId/source/input/locale/functionName/aliasSet）
	// 与其 aster-api 权威 expected envelope（同源 corpus，Slice-2a 已产）。
	req, wantExpected := loadCorpusFixture(t) // 见下：读 aster-api runner 的 gen-expected 输出

	env, err := runJob(ctx, cs, req, digest)
	if err != nil {
		t.Fatalf("runJob e2e: %v", err)
	}
	assertEnvelopeParity(t, env, wantExpected) // 断言 5 replay-critical 字段逐字相等
}
```

- [ ] **Step 2: `loadCorpusFixture` / `assertEnvelopeParity` 辅助**

从 aster-api runner 的 `gen-expected` corpus 输出目录读固定 fixture + expected envelope（复用 Slice-2a 已产的权威 corpus，路径见 runner `scripts/`），`assertEnvelopeParity` 逐字比 5 个 replay-critical 字段（`canonicalInputHash`/`canonicalOutputHash`/`canonicalizationVersion`/`replayabilityStatus`/`traceHash`），**`runtimeToolchainId` 不进 parity 比对**（仅诊断，对齐 client 契约注释）。

- [ ] **Step 3: 本地实测（有集群时）**

`cd aster-api/launcher && LAUNCHER_E2E=1 RUNNER_IMAGE_DIGEST=<local> go test ./internal/orchestrator/ -run E2E -v`——断言 envelope parity 绿。无集群 CI/本地：`go test ./...` 自动 skip 此测试。

- [ ] **Step 4: commit**

`test(launcher): LAUNCHER_E2E gated 集成测试（真 runner Job Fork C stdin 路径 + envelope parity）`。

---

> **PART 1 到此结束（Unit 1 HMAC 中间件 + Unit 2 Job 编排器）。以下 PART 2 追加 Unit 3-6 + 跨仓交付顺序 + 交叉审查。**

## Unit 3 — HTTP handler + main.go 装配（Go）

**职责：** `POST /api/v1/runner/launch` 端点：验 HMAC（Unit 1）→ 通过则解析 RunnerRequest → 调 runJob（Unit 2）→ 把 RunnerEnvelope 映射为 F 契约响应；`/healthz` 供 k8s 探针。**★reject-proof：整个 handler 裹 panic-recovery + whole-body 错误归一——launcher 绝不裸 500 stacktrace，镜像 cloud client 的 safeErrorMessage 哲学。**

**契约（须逐字节匹配已上线 client `runner-launcher-client.ts`）：**
- 成功 → `{"outcome":"SUCCESS","replayMetadata":{...}}` **HTTP 200**（client L76-78 按 `outcome==='SUCCESS' && replayMetadata` 分类为 `ok:true`）。
- runner 业务错 → `{"outcome":"ERROR","errorCode":...,"message":...,"phase":...}` **HTTP 200**（NOT HTTP error——client L79-81 按 `outcome` 分类为 `runner-error`，非 HTTP status）。
- 编排不可达（Job 未调度/超时/日志不可解析）→ **HTTP 503** + 结构化 body（client L71 把任何非 200 归 `unavailable`；503 body 内容仅诊断用，client 只看 status）。
- **★reject-proof（承 Global Constraints + spec §Fork F）**：handler 全体裹 `deferredRecover`；任何 panic/内部 error → 结构化 503 JSON，绝不 `http.Error` 吐 500 stacktrace。镜像 client 的 `safeErrorMessage`：错误消息提取不二次 panic。

**接口：** `LaunchHandler` 持一个 `Orchestrator` 接口 seam（便于表驱动测试 mock，不需真集群）；`ServeHTTP` 实现 `http.Handler`。

**★orchestrator seam（design-for-testability）：** handler 依赖 `Orchestrator` 接口而非直接 `runJob`——测试注入 mock（返回 SUCCESS/ERROR/ErrUnavailable/panic），生产注入真 client-go 实现。这样 handler 单测无需 kind/k3d。

### Task 3.1: Orchestrator 接口 seam + 生产实现适配

**Files:**
- Create: `aster-api/launcher/internal/orchestrator/orchestrator.go`（`Orchestrator` 接口 + `K8sOrchestrator` 生产实现，包 `clientset` + `digest`）
- Create: `aster-api/launcher/internal/orchestrator/orchestrator_test.go`

**Interfaces:**
- Produces: `type Orchestrator interface { Run(ctx context.Context, req RunnerRequest) (RunnerEnvelope, error) }`；`type K8sOrchestrator struct{ Clientset kubernetes.Interface; Digest string }` 实现 `Run`（内部调 Task 2.2 的 `runJob`）；导出 `ErrUnavailable`（Task 2.2 已定义，本 Task 只确认导出可见）。

- [ ] **Step 1（RED）：写接口 + 生产实现的失败测试**

`aster-api/launcher/internal/orchestrator/orchestrator_test.go`：

```go
package orchestrator

import (
	"context"
	"testing"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"
)

// K8sOrchestrator.Run 应把 digest 透传给 runJob，并把 runJob 的 (env,err) 原样返回。
// 用 fake clientset：Job 超时 → Run 返回 ErrUnavailable（验证 seam 不吞错、digest 透传）。
func TestK8sOrchestrator_Run_TimeoutPropagates(t *testing.T) {
	const digest = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
	cs := fake.NewSimpleClientset()
	o := &K8sOrchestrator{Clientset: cs, Digest: digest}

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	if _, err := o.Run(ctx, testReq()); err == nil {
		t.Fatal("期望超时 error（Job 永不终态），得 nil")
	}
	// 断言 Run 确实建了 digest-pin 的 Job（seam 未丢 digest）。
	jobs, _ := cs.BatchV1().Jobs(runnerNamespace).List(context.Background(), metav1.ListOptions{})
	if len(jobs.Items) != 1 {
		t.Fatalf("期望建 1 个 Job，得 %d", len(jobs.Items))
	}
	img := jobs.Items[0].Spec.Template.Spec.Containers[0].Image
	if wantSuffix := "@" + digest; img[len(img)-len(wantSuffix):] != wantSuffix {
		t.Fatalf("Job image 未用注入 digest: %q", img)
	}
	_ = batchv1.Job{}
}
```

- [ ] **Step 2（RED→run）：看红**（`undefined: Orchestrator` / `undefined: K8sOrchestrator`）。

- [ ] **Step 3（GREEN）：写接口 + 生产实现**

`aster-api/launcher/internal/orchestrator/orchestrator.go`：

```go
package orchestrator

import (
	"context"

	"k8s.io/client-go/kubernetes"
)

// Orchestrator 是 handler 依赖的编排 seam：把一次 RunnerRequest 跑成 RunnerEnvelope。
// ★接口而非直接调 runJob——handler 单测注入 mock（不需真集群），生产注入 K8sOrchestrator。
type Orchestrator interface {
	// Run 编排一次 runner 执行。系统性失败返回 (zero, err)（其中 ErrUnavailable 归 F 契约 unavailable）；
	// runner 业务错（outcome=="ERROR"）经 env 正常返回（err==nil）——由 handler 按 outcome 映射。
	Run(ctx context.Context, req RunnerRequest) (RunnerEnvelope, error)
}

// K8sOrchestrator 是 Orchestrator 的生产实现：用 in-cluster clientset 建 digest-pinned Job。
// Digest 由 main.go 从 RUNNER_IMAGE_DIGEST env 注入（Fork A：runner digest 载体）。
type K8sOrchestrator struct {
	Clientset kubernetes.Interface
	Digest    string
}

// Run 透传 Digest 给 runJob（Task 2.2）——不改字段、不产证据，只编排。
func (o *K8sOrchestrator) Run(ctx context.Context, req RunnerRequest) (RunnerEnvelope, error) {
	return runJob(ctx, o.Clientset, req, o.Digest)
}
```

- [ ] **Step 4（GREEN→run）：看绿**

`cd aster-api/launcher && go test ./...`——`TestK8sOrchestrator_Run_TimeoutPropagates` 绿（Job 建了、digest 透传、超时归 error）。

- [ ] **Step 5: commit**

`feat(launcher): Orchestrator 接口 seam + K8sOrchestrator 生产实现（digest 注入透传）`。

### Task 3.2: LaunchHandler — 验签 → runJob → F 契约映射 + reject-proof

**Files:**
- Create: `aster-api/launcher/internal/httpapi/handler.go`
- Create: `aster-api/launcher/internal/httpapi/handler_test.go`

**Interfaces:**
- Produces: `type LaunchHandler struct{ Orch orchestrator.Orchestrator }`；`func (h *LaunchHandler) ServeHTTP(w http.ResponseWriter, r *http.Request)`（实现 `http.Handler`）；`func Healthz(w http.ResponseWriter, r *http.Request)`。
- Consumes: `auth.VerifyHMAC`（Unit 1）、`orchestrator.Orchestrator` / `orchestrator.ErrUnavailable` / `orchestrator.RunnerRequest` / `orchestrator.RunnerEnvelope`（Unit 2/3.1）。

- [ ] **Step 1（RED）：写表驱动 handler 测试（httptest.NewRecorder + mock orchestrator）**

`aster-api/launcher/internal/httpapi/handler_test.go`（覆盖 valid→200 SUCCESS 透传 / runner-error→200 ERROR / unavailable→503 / bad-HMAC→401·403 / panic-in-orchestrator→503-not-500）：

```go
package httpapi

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/aster-cloud/aster-api/launcher/internal/orchestrator"
)

const testKey = "test-runner-launcher-hmac-key"

// mockOrch 是 Orchestrator 的测试替身：按预设返回 env/err 或 panic。
type mockOrch struct {
	env      orchestrator.RunnerEnvelope
	err      error
	doPanic  bool
	gotReq   orchestrator.RunnerRequest
	gotCalls int
}

func (m *mockOrch) Run(ctx context.Context, req orchestrator.RunnerRequest) (orchestrator.RunnerEnvelope, error) {
	m.gotCalls++
	m.gotReq = req
	if m.doPanic {
		panic("simulated orchestrator panic")
	}
	return m.env, m.err
}

// signRequest 造带全套签名头的 *http.Request（复刻 client signRunnerLauncherHeaders）。
func signRequest(t *testing.T, tenant, role string, body []byte) *http.Request {
	t.Helper()
	const method, path, nonce = "POST", "/api/v1/runner/launch", "0123456789abcdef0123456789abcdef"
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	sum := sha256.Sum256(body)
	bodyHash := hex.EncodeToString(sum[:])
	canonical := strings.Join([]string{method, path, ts, nonce, bodyHash, tenant, role}, "\n")
	mac := hmac.New(sha256.New, []byte(testKey))
	mac.Write([]byte(canonical))
	sig := hex.EncodeToString(mac.Sum(nil))

	r := httptest.NewRequest(method, path, strings.NewReader(string(body)))
	r.Header.Set("X-Internal-Caller", "cloud-runner-launcher")
	r.Header.Set("X-Aster-Timestamp", ts)
	r.Header.Set("X-Aster-Nonce", nonce)
	r.Header.Set("X-Aster-Tenant", tenant)
	r.Header.Set("X-Aster-Role", role)
	r.Header.Set("X-Internal-Signature", sig)
	return r
}

func strPtr(s string) *string { return &s }

func TestLaunchHandler(t *testing.T) {
	t.Setenv("ASTER_RUNNER_LAUNCHER_HMAC_KEY", testKey)
	validBody := []byte(`{"tenantId":"t1","source":"Module M","input":{"x":1},"locale":"en-US","functionName":"f","aliasSet":null}`)

	successEnv := orchestrator.RunnerEnvelope{
		Outcome: "SUCCESS",
		ReplayMetadata: &orchestrator.ReplayMetadata{
			CanonicalInputHash: strPtr("h"), CanonicalOutputHash: strPtr("o"),
			CanonicalizationVersion: strPtr("v1"), ReplayabilityStatus: strPtr("REPLAYABLE"), TraceHash: strPtr("t"),
		},
	}
	errorEnv := orchestrator.RunnerEnvelope{
		Outcome: "ERROR", ErrorCode: "EXECUTION", Message: "boom", Phase: "execute",
	}

	cases := []struct {
		name       string
		req        func() *http.Request
		orch       *mockOrch
		wantStatus int
		wantBody   func(t *testing.T, body []byte)
	}{
		{
			name: "valid-success-200-passthrough",
			req:  func() *http.Request { return signRequest(t, "t1", "user", validBody) },
			orch: &mockOrch{env: successEnv},
			wantStatus: 200,
			wantBody: func(t *testing.T, body []byte) {
				var got orchestrator.RunnerEnvelope
				if err := json.Unmarshal(body, &got); err != nil || got.Outcome != "SUCCESS" || got.ReplayMetadata == nil {
					t.Fatalf("body 非 SUCCESS envelope: %s (err=%v)", body, err)
				}
			},
		},
		{
			name: "runner-error-200-not-http-error",
			req:  func() *http.Request { return signRequest(t, "t1", "user", validBody) },
			orch: &mockOrch{env: errorEnv},
			wantStatus: 200, // ★关键：runner 业务错也是 200，client 按 outcome 分类
			wantBody: func(t *testing.T, body []byte) {
				var got orchestrator.RunnerEnvelope
				_ = json.Unmarshal(body, &got)
				if got.Outcome != "ERROR" || got.ErrorCode != "EXECUTION" || got.Phase != "execute" {
					t.Fatalf("ERROR envelope 字段丢失: %s", body)
				}
			},
		},
		{
			name: "unavailable-503",
			req:  func() *http.Request { return signRequest(t, "t1", "user", validBody) },
			orch: &mockOrch{err: orchestrator.ErrUnavailable},
			wantStatus: 503,
		},
		{
			name: "panic-in-orchestrator-503-not-500",
			req:  func() *http.Request { return signRequest(t, "t1", "user", validBody) },
			orch: &mockOrch{doPanic: true},
			wantStatus: 503, // ★reject-proof：panic 也被 recover 成结构化 503，绝不裸 500
		},
		{
			name: "bad-hmac-403",
			req: func() *http.Request {
				r := signRequest(t, "t1", "user", validBody)
				r.Header.Set("X-Internal-Signature", "deadbeef"+r.Header.Get("X-Internal-Signature")[8:])
				return r
			},
			orch:       &mockOrch{env: successEnv},
			wantStatus: 403,
		},
		{
			name: "wrong-caller-401",
			req: func() *http.Request {
				r := signRequest(t, "t1", "user", validBody)
				r.Header.Set("X-Internal-Caller", "cloud-bff")
				return r
			},
			orch:       &mockOrch{env: successEnv},
			wantStatus: 401,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := &LaunchHandler{Orch: tc.orch}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, tc.req())
			if rec.Code != tc.wantStatus {
				t.Fatalf("status=%d want=%d body=%s", rec.Code, tc.wantStatus, rec.Body.String())
			}
			// ★reject-proof 断言：任何响应都是合法 JSON，绝不是裸 stacktrace 文本。
			var probe map[string]any
			if err := json.Unmarshal(rec.Body.Bytes(), &probe); err != nil {
				t.Fatalf("响应非结构化 JSON（疑似裸 500 stacktrace）: %s", rec.Body.String())
			}
			// 拒绝态（401/403/503）不得调用 orchestrator（bad-HMAC 在验签阶段 fail-fast）。
			if tc.wantStatus == 401 || tc.wantStatus == 403 {
				if tc.orch.gotCalls != 0 {
					t.Fatalf("验签失败不应调用 orchestrator，实际调用 %d 次", tc.orch.gotCalls)
				}
			}
			if tc.wantBody != nil {
				tc.wantBody(t, rec.Body.Bytes())
			}
		})
	}
}

// Healthz 恒 200 + {"status":"ok"}（k8s liveness/readiness）。
func TestHealthz(t *testing.T) {
	rec := httptest.NewRecorder()
	Healthz(rec, httptest.NewRequest("GET", "/healthz", nil))
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "ok") {
		t.Fatalf("healthz code=%d body=%s", rec.Code, rec.Body.String())
	}
}
```

- [ ] **Step 2（RED→run）：看红**（`undefined: LaunchHandler` / `undefined: Healthz`）。

- [ ] **Step 3（GREEN）：写 handler**

`aster-api/launcher/internal/httpapi/handler.go`：

```go
// Package httpapi 实现 launcher 的 HTTP 端点：POST /api/v1/runner/launch + /healthz。
// ★reject-proof（Global Constraints）：整个 handler 裹 panic-recovery，任何 panic/内部 error
// 归结构化 503 JSON——launcher 绝不裸 500 stacktrace（镜像 cloud client 的 safeErrorMessage 哲学）。
package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/aster-cloud/aster-api/launcher/internal/auth"
	"github.com/aster-cloud/aster-api/launcher/internal/orchestrator"
)

// maxBodyBytes 限制请求体大小（防超大 body OOM）。runner 源码通常几 KB，1MiB 足够宽裕。
const maxBodyBytes = 1 << 20

// LaunchHandler 处理 POST /api/v1/runner/launch。Orch 是编排 seam（生产=K8sOrchestrator）。
type LaunchHandler struct {
	Orch orchestrator.Orchestrator
}

// errorBody 是所有非 200 响应的结构化 body（诊断用；client 只看 HTTP status 不解析此 body）。
type errorBody struct {
	Error string `json:"error"`
}

// ServeHTTP：验签 → 解析 → 编排 → F 契约映射，全程裹 recover。★绝不裸 500。
func (h *LaunchHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// ★panic-recovery：任何 panic（含 orchestrator 内部）→ 结构化 503，不吐 stacktrace。
	defer func() {
		if rec := recover(); rec != nil {
			writeJSON(w, http.StatusServiceUnavailable, errorBody{Error: "internal orchestrator failure"})
		}
	}()

	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, errorBody{Error: "method not allowed"})
		return
	}

	// 预读 body 一次（body 不可重读）：VerifyHMAC 与 JSON 解析共用同一份 raw bytes。
	body, err := io.ReadAll(io.LimitReader(r.Body, maxBodyBytes))
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, errorBody{Error: "read body failed"})
		return
	}

	// (1) 验 HMAC（Unit 1）。status!=0 → 直接返回该拒绝码（401/403/500 均转结构化）。
	//     ★验签失败 fail-fast，绝不进 orchestrator（key 隔离 + 拒绝态不触发建 Job）。
	tenant, role, status := auth.VerifyHMAC(r, body)
	if status != 0 {
		// 500（key 未配）也转 503——launcher 对外只暴露「可用/不可用」，不吐内部 500。
		httpStatus := status
		if httpStatus == http.StatusInternalServerError {
			httpStatus = http.StatusServiceUnavailable
		}
		writeJSON(w, httpStatus, errorBody{Error: "unauthorized"})
		return
	}

	// (2) 解析 RunnerRequest（body 已读）。tenant/role 来自已验证 header——tenant 权威取 header
	//     覆盖 body（防 body 内 tenantId 与签名 tenant 不一致的越权；role 不进 body）。
	var req orchestrator.RunnerRequest
	if err := json.Unmarshal(body, &req); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, errorBody{Error: "unparseable request body"})
		return
	}
	req.TenantID = tenant // 以已验证 header tenant 为权威（body 内值仅参考）
	_ = role              // role 只用于 HMAC canonical，不进 runner request body（F 契约）

	// (3) 编排（Unit 2/3.1）。系统性失败（ErrUnavailable/任意 err）→ 503；env 正常 → 按 outcome 映射。
	env, runErr := h.Orch.Run(r.Context(), req)
	if runErr != nil {
		// 任意编排错（含 ErrUnavailable）→ 503（client 归 unavailable）。诊断放 body，不吐 stacktrace。
		reason := "runner unavailable"
		if errors.Is(runErr, orchestrator.ErrUnavailable) {
			reason = "runner orchestration unavailable"
		}
		writeJSON(w, http.StatusServiceUnavailable, errorBody{Error: reason})
		return
	}

	// (4) F 契约映射：SUCCESS 与 ERROR 皆 HTTP 200（client 按 outcome 分类，非 HTTP status）。
	//     launcher 原样透传 runner envelope（不改字段——只编排不产证据）。
	writeJSON(w, http.StatusOK, env)
}

// Healthz 是 k8s liveness/readiness 探针端点：恒 200 + {"status":"ok"}。
func Healthz(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// writeJSON 序列化 v 为 JSON 并写 status。★序列化失败也不裸 panic——退化为最简结构化 503。
// （env 全为可序列化标量/指针，理论上不失败；此为 reject-proof 的最后一环。）
func writeJSON(w http.ResponseWriter, status int, v any) {
	buf, err := json.Marshal(v)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte(`{"error":"response serialization failed"}`))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(buf)
}
```

- [ ] **Step 4（GREEN→run）：看绿**

`cd aster-api/launcher && go test ./...`——6 个子用例 + Healthz 全绿。★重点看 `panic-in-orchestrator-503-not-500`：defer recover 生效，响应是结构化 503 JSON 非裸 500。

- [ ] **Step 5: commit**

`feat(launcher): LaunchHandler（验签→runJob→F 契约映射；reject-proof panic-recovery；SUCCESS/ERROR 皆 200，不可达 503）`。

### Task 3.3: main.go — in-cluster clientset + 路由装配 + ListenAndServe

**Files:**
- Create: `aster-api/launcher/cmd/launcher/main.go`
- Create: `aster-api/launcher/cmd/launcher/main_test.go`（env 读取与路由装配的可测部分）

**Interfaces:**
- Produces: `func main()`（读 env → in-cluster clientset → 装配 mux → ListenAndServe）；`func buildMux(orch orchestrator.Orchestrator) *http.ServeMux`（可测：路由装配抽出，main 只负责 clientset 构造 + 监听）。
- Reads env：`ASTER_RUNNER_LAUNCHER_HMAC_KEY`（VerifyHMAC 内部读，main 只做存在性预检 fail-loud）、`RUNNER_IMAGE_DIGEST`（Fork A）、`RUNNER_NAMESPACE`（默认 `aster-runner`，与 orchestrator 常量一致性校验）、`PORT`（默认 `8080`）。

- [ ] **Step 1（RED）：写 buildMux 路由装配测试**

`aster-api/launcher/cmd/launcher/main_test.go`：

```go
package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/aster-cloud/aster-api/launcher/internal/orchestrator"
)

type stubOrch struct{}

func (stubOrch) Run(context.Context, orchestrator.RunnerRequest) (orchestrator.RunnerEnvelope, error) {
	return orchestrator.RunnerEnvelope{Outcome: "SUCCESS"}, nil
}

// buildMux 应把 /healthz 与 /api/v1/runner/launch 都装上。
func TestBuildMux_Routes(t *testing.T) {
	mux := buildMux(stubOrch{})

	// /healthz 200。
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest("GET", "/healthz", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("/healthz code=%d", rec.Code)
	}

	// /api/v1/runner/launch 存在（未签名 → 走 handler 的验签路径，非 404）。
	rec2 := httptest.NewRecorder()
	mux.ServeHTTP(rec2, httptest.NewRequest("POST", "/api/v1/runner/launch", nil))
	if rec2.Code == http.StatusNotFound {
		t.Fatal("/api/v1/runner/launch 未装配（404）")
	}
}
```

- [ ] **Step 2（RED→run）：看红**（`undefined: buildMux`）。

- [ ] **Step 3（GREEN）：写 main.go**

`aster-api/launcher/cmd/launcher/main.go`：

```go
// Command launcher 是 in-cluster runner-launcher 微服务入口：
// 收 cloud（经 Cloudflare Tunnel）的 HMAC 请求 → 建 digest-pinned runner Job → 回传 envelope。
// ★in-cluster：用 rest.InClusterConfig（由 launcher Pod 的 SA token 提供 API 凭据）。
package main

import (
	"log"
	"net/http"
	"os"

	"github.com/aster-cloud/aster-api/launcher/internal/httpapi"
	"github.com/aster-cloud/aster-api/launcher/internal/orchestrator"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

func main() {
	// ★fail-loud 预检：HMAC key 未配置则拒绝启动（绝不带缺失 key 上线——VerifyHMAC 会对每个
	//   请求返回内部错，但启动即崩比运行时静默拒绝所有请求更诚实，也让 readiness 探针失败快速暴露）。
	if os.Getenv("ASTER_RUNNER_LAUNCHER_HMAC_KEY") == "" {
		log.Fatal("ASTER_RUNNER_LAUNCHER_HMAC_KEY 未配置——拒绝启动（HMAC key 隔离铁律）")
	}

	// Fork A：runner digest 从 launcher Deployment env 读（image-pin 脚本第三写目标 patch 之）。
	digest := os.Getenv("RUNNER_IMAGE_DIGEST")
	if digest == "" {
		log.Fatal("RUNNER_IMAGE_DIGEST 未配置——拒绝启动（无 digest 无法 pin runner 镜像）")
	}

	// RUNNER_NAMESPACE 与 orchestrator 常量一致性校验：不一致则拒绝启动（防 manifest 与代码漂移）。
	if ns := os.Getenv("RUNNER_NAMESPACE"); ns != "" && ns != orchestrator.Namespace() {
		log.Fatalf("RUNNER_NAMESPACE=%q 与编排器常量 %q 不一致——拒绝启动", ns, orchestrator.Namespace())
	}

	// in-cluster k8s clientset：由 launcher Pod 挂载的 SA token（automountServiceAccountToken:true）提供。
	cfg, err := rest.InClusterConfig()
	if err != nil {
		log.Fatalf("获取 in-cluster 配置失败（launcher 须跑在 Pod 内 + 挂载 SA token）: %v", err)
	}
	clientset, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		log.Fatalf("构建 k8s clientset 失败: %v", err)
	}

	orch := &orchestrator.K8sOrchestrator{Clientset: clientset, Digest: digest}
	mux := buildMux(orch)

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	log.Printf("runner-launcher 监听 :%s（runner digest=%s ns=%s）", port, digest, orchestrator.Namespace())
	// ListenAndServe 阻塞；返回即致命（Pod 会被 k8s 重启）。
	if err := http.ListenAndServe(":"+port, mux); err != nil {
		log.Fatalf("ListenAndServe 退出: %v", err)
	}
}

// buildMux 装配路由：/healthz（探针）+ /api/v1/runner/launch（LaunchHandler）。
// ★抽出便于单测（main 只做 clientset 构造 + 监听，不可单测；路由装配可单测）。
func buildMux(orch orchestrator.Orchestrator) *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", httpapi.Healthz)
	mux.Handle("/api/v1/runner/launch", &httpapi.LaunchHandler{Orch: orch})
	return mux
}
```

补 `aster-api/launcher/internal/orchestrator/orchestrator.go` 暴露 ns 常量给 main（一致性校验用）：

```go
// Namespace 返回 launcher 建 Job 的目标 ns（runnerNamespace 常量的导出访问器）。
// ★main.go 用它对 RUNNER_NAMESPACE env 做一致性校验，防 manifest 与代码漂移。
func Namespace() string { return runnerNamespace }
```

- [ ] **Step 4（GREEN→run）：看绿**

`cd aster-api/launcher && go test ./...`——`TestBuildMux_Routes` 绿（/healthz 200、launch 非 404）。全仓 `go vet ./...` 无警告。

- [ ] **Step 5: commit**

`feat(launcher): main.go 装配（in-cluster clientset + /healthz + /api/v1/runner/launch + env fail-loud 预检）`。

---

## Unit 4 — k8s manifests（k3s 仓，`apps/aster-lang/aster-runner/`）

**职责：** launcher 微服务的 GitOps manifests，加入 2b-seed 已建的 `aster-runner` kustomization（2b-seed 只含 `namespace.yaml`）。硬化 Deployment（镜像 cloudflared 模板）+ **最小** SA/Role/RoleBinding（★launcher 是集群首个建 Job 的 SA——安全一等件，spec §3b/Fork F）+ Service（tunnel 路由目标）+ external-secrets（HMAC key）+ network-policy（k3s kube-router caveat）。

**★与 cloudflared 模板的关键差异（承 factbase B5）：** cloudflared SA **无** API access（`automountServiceAccountToken:false` + 无 Role）。launcher 反过来——**需要** API access（建 Job/读 log），故 `automountServiceAccountToken:true` + 真 Role。但 Role 严格最小：无 `pods/attach`、无 cluster-scope、仅 `aster-runner` ns。

**★镜像 pin 说明（Fork A 第三写目标）：** launcher 自身镜像 `docker.io/wontlost/aster-runner-launcher@sha256:<placeholder>` 是**它自己的** pinned 镜像（由 Unit 6 的 `aster-runner-launcher-deploy.yml` 签发+pin）；Deployment 里的 `RUNNER_IMAGE_DIGEST` env 是**runner 镜像**的 digest（Fork A 第三写目标——runner 的 image-pin 脚本 patch 此 env value，见 Unit 6 Task 6.3）。两者是不同镜像的两个 pin：launcher 镜像 pin 走 launcher 自己的 workflow；runner digest env 走 runner workflow 的第三写目标。

### Task 4.1: deployment.yaml（硬化 + RUNNER_IMAGE_DIGEST env + HMAC secretKeyRef）

**Files:**
- Create: `k3s/apps/aster-lang/aster-runner/deployment.yaml`

- [ ] **Step 1: 写 deployment.yaml**

`k3s/apps/aster-lang/aster-runner/deployment.yaml`：

```yaml
# runner-launcher Deployment（S2-1a-2 Slice-2b-launch）
# in-cluster Go 微服务：收 cloud（经 Cloudflare Tunnel）的 HMAC 请求 → 建 digest-pinned
# runner Job → 回传 envelope。硬化模板镜像 cloudflare-tunnel/deployment.yaml。
# ★与 cloudflared 差异：launcher 需 API access（建 Job/读 log），故 automountServiceAccountToken:true
#   + 专用最小 Role（见 role.yaml）。cloudflared 无 API access（automount:false）。
apiVersion: apps/v1
kind: Deployment
metadata:
  name: runner-launcher
  namespace: aster-runner
  labels:
    app.kubernetes.io/name: runner-launcher
    app.kubernetes.io/component: launcher
    app.kubernetes.io/part-of: aster-lang
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: runner-launcher
  template:
    metadata:
      labels:
        app.kubernetes.io/name: runner-launcher
        app.kubernetes.io/component: launcher
        app.kubernetes.io/part-of: aster-lang
    spec:
      # ★launcher 需 k8s API（建 Job/读 Pod log）——与 cloudflared 相反，须挂 SA token。
      serviceAccountName: runner-launcher
      automountServiceAccountToken: true

      # Pod 级安全硬化（镜像 cloudflared L29-35）。
      securityContext:
        runAsNonRoot: true
        runAsUser: 65532
        runAsGroup: 65532
        fsGroup: 65532
        seccompProfile:
          type: RuntimeDefault

      containers:
        - name: runner-launcher
          # ★launcher 自己的 pinned 镜像（由 aster-runner-launcher-deploy.yml 签发+pin）。
          #   placeholder digest——launcher 镜像 image-pin 会覆写为真实 digest（Unit 6）。
          image: docker.io/wontlost/aster-runner-launcher@sha256:0000000000000000000000000000000000000000000000000000000000000000
          imagePullPolicy: IfNotPresent
          ports:
            - name: http
              containerPort: 8080
          env:
            # PORT：与 containerPort 一致。
            - name: PORT
              value: "8080"
            # RUNNER_NAMESPACE：与代码常量 runnerNamespace 一致（main.go 会一致性校验）。
            - name: RUNNER_NAMESPACE
              value: aster-runner
            # ★Fork A：runner 镜像 digest 载体。placeholder——image-pin 脚本第三写目标 patch 此 value
            #   （runner workflow 的 image-pin 步指向本 Deployment 的此 env，见 Unit 6 Task 6.3）。
            - name: RUNNER_IMAGE_DIGEST
              value: sha256:0000000000000000000000000000000000000000000000000000000000000000
            # ★HMAC key 隔离（绝不 fallback 到 plan-gate key）：从专用 secret 读。
            - name: ASTER_RUNNER_LAUNCHER_HMAC_KEY
              valueFrom:
                secretKeyRef:
                  name: aster-runner-launcher-hmac
                  key: hmac-key
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              cpu: 250m
              memory: 128Mi
          # 容器级安全硬化（镜像 cloudflared L62-67）。
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop:
                - ALL
          # 健康探针 → /healthz（main.go 装配的探针端点）。
          livenessProbe:
            httpGet:
              path: /healthz
              port: http
            initialDelaySeconds: 10
            periodSeconds: 10
            failureThreshold: 3
          readinessProbe:
            httpGet:
              path: /healthz
              port: http
            initialDelaySeconds: 5
            periodSeconds: 5
            failureThreshold: 3
      terminationGracePeriodSeconds: 30
```

- [ ] **Step 2: 渲染检查**（本地实测，无 apply）

`kubectl kustomize k3s/apps/aster-lang/aster-runner/` 应渲染出 Deployment（先加进 kustomization.yaml，见 Task 4.7；本 Task 单独渲染时可临时把 deployment.yaml 加到 resources 验证语法）。★注意此时 image/RUNNER_IMAGE_DIGEST 仍是 placeholder digest——渲染不校验 digest 真伪，只校验 YAML/kustomize 语法。

- [ ] **Step 3: commit**

`feat(k3s): runner-launcher Deployment（硬化 securityContext + RUNNER_IMAGE_DIGEST env + HMAC secretKeyRef + /healthz 探针）`。

### Task 4.2: serviceaccount.yaml

**Files:**
- Create: `k3s/apps/aster-lang/aster-runner/serviceaccount.yaml`

- [ ] **Step 1: 写 serviceaccount.yaml**

`k3s/apps/aster-lang/aster-runner/serviceaccount.yaml`：

```yaml
# runner-launcher 专用 ServiceAccount（S2-1a-2 Slice-2b-launch）
# ★与 cloudflared SA（automount:false，无 API access）相反：launcher 需 k8s API 建 Job/读 log，
#   故 automountServiceAccountToken:true。权限严格由 role.yaml 限定（仅 aster-runner ns，无 cluster-scope）。
apiVersion: v1
kind: ServiceAccount
metadata:
  name: runner-launcher
  namespace: aster-runner
  labels:
    app.kubernetes.io/name: runner-launcher
    app.kubernetes.io/component: launcher
    app.kubernetes.io/part-of: aster-lang
automountServiceAccountToken: true
```

- [ ] **Step 2: 渲染检查 + commit**

`kubectl kustomize` 渲染无误 → `feat(k3s): runner-launcher ServiceAccount（automountServiceAccountToken:true，需 API access）`。

### Task 4.3: role.yaml（★最小权限——安全一等件）

**Files:**
- Create: `k3s/apps/aster-lang/aster-runner/role.yaml`

**★最小权限（spec §Fork F + factbase B5）：** 只给编排 runner Job 的最小动词。**无 `pods/attach`**（Fork C 用 stdin 文件注入非 attach，故不需要）、**无 cluster-scope**（Role 非 ClusterRole）、**仅 `aster-runner` ns**。

- [ ] **Step 1: 写 role.yaml**

`k3s/apps/aster-lang/aster-runner/role.yaml`：

```yaml
# runner-launcher 最小 Role（S2-1a-2 Slice-2b-launch）
# ★安全一等件（spec §3b 威胁模型 / Fork F）：集群首个建 Job 的 SA，权限严格最小。
#   - batch/jobs：create（建 runner Job）、get/list/watch（poll 到终态）、delete（清理/GC 触发）。
#   - pods：get/list/watch（找 Job 派生的 Pod 读 log 与 exit code）。
#   - pods/log：get（读 runner stdout envelope——Fork C 读协议）。
#   - configmaps：create（per-invocation request.json）、delete（清理；owner-ref 级联 GC 兜底）。
# ★明确不含：pods/attach（Fork C 用 stdin 文件注入非 attach）、pods/exec、secrets、
#   任何 cluster-scope（本对象是 Role 非 ClusterRole，仅 aster-runner ns 生效）。
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: runner-launcher
  namespace: aster-runner
  labels:
    app.kubernetes.io/name: runner-launcher
    app.kubernetes.io/component: launcher
    app.kubernetes.io/part-of: aster-lang
rules:
  # 编排 runner Job 生命周期。
  - apiGroups: ["batch"]
    resources: ["jobs"]
    verbs: ["create", "get", "list", "watch", "delete"]
  # 找 Job 派生的 Pod（读 log + exit code）。
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list", "watch"]
  # 读 runner stdout envelope（Fork C envelope 读协议）。
  - apiGroups: [""]
    resources: ["pods/log"]
    verbs: ["get"]
  # per-invocation request.json ConfigMap（owner-ref 到 Job，级联 GC；delete 作兜底清理）。
  - apiGroups: [""]
    resources: ["configmaps"]
    verbs: ["create", "delete"]
```

- [ ] **Step 2: 渲染检查 + commit**

`kubectl kustomize` 渲染无误 → `feat(k3s): runner-launcher 最小 Role（batch/jobs+pods+pods/log+configmaps；无 pods/attach 无 cluster-scope）`。

### Task 4.4: rolebinding.yaml

**Files:**
- Create: `k3s/apps/aster-lang/aster-runner/rolebinding.yaml`

- [ ] **Step 1: 写 rolebinding.yaml**

`k3s/apps/aster-lang/aster-runner/rolebinding.yaml`：

```yaml
# runner-launcher RoleBinding：SA runner-launcher → Role runner-launcher（S2-1a-2 Slice-2b-launch）
# ★命名空间级绑定（RoleBinding 非 ClusterRoleBinding）：权限只在 aster-runner ns 生效。
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: runner-launcher
  namespace: aster-runner
  labels:
    app.kubernetes.io/name: runner-launcher
    app.kubernetes.io/component: launcher
    app.kubernetes.io/part-of: aster-lang
subjects:
  - kind: ServiceAccount
    name: runner-launcher
    namespace: aster-runner
roleRef:
  kind: Role
  name: runner-launcher
  apiGroup: rbac.authorization.k8s.io
```

- [ ] **Step 2: 渲染检查 + commit**

`kubectl kustomize` 渲染无误 → `feat(k3s): runner-launcher RoleBinding（SA→Role，命名空间级）`。

### Task 4.5: service.yaml（tunnel 路由目标）

**Files:**
- Create: `k3s/apps/aster-lang/aster-runner/service.yaml`

- [ ] **Step 1: 写 service.yaml**

`k3s/apps/aster-lang/aster-runner/service.yaml`：

```yaml
# runner-launcher Service（S2-1a-2 Slice-2b-launch）
# ★Cloudflare Tunnel 路由目标：dashboard 配的 tunnel ingress 把 /api/v1/runner/launch
#   路由到本 ClusterIP（带外 dashboard 步，无 in-repo YAML——见 factbase C10）。
#   tunnel 引用格式如 http://runner-launcher.aster-runner.svc.cluster.local:80。
apiVersion: v1
kind: Service
metadata:
  name: runner-launcher
  namespace: aster-runner
  labels:
    app.kubernetes.io/name: runner-launcher
    app.kubernetes.io/component: launcher
    app.kubernetes.io/part-of: aster-lang
spec:
  type: ClusterIP
  selector:
    app.kubernetes.io/name: runner-launcher
  ports:
    - name: http
      port: 80
      targetPort: http # 指向 Deployment 容器的 named port http（8080）
      protocol: TCP
```

- [ ] **Step 2: 渲染检查 + commit**

`kubectl kustomize` 渲染无误 → `feat(k3s): runner-launcher Service（ClusterIP，tunnel 路由目标 port 80→8080）`。

### Task 4.6: external-secrets.yaml（HMAC key 从 Vault）

**Files:**
- Create: `k3s/apps/aster-lang/aster-runner/external-secrets.yaml`

**★Vault path 待确认（placeholder）：** 镜像 cloud external-secret 模式（`vault-backend` ClusterSecretStore，`creationPolicy:Owner` / `deletionPolicy:Retain`）。Vault path `apps/aster-runner-launcher` 是 placeholder——须确认 Vault 里已写入独立 HMAC key（`vault kv put secret/apps/aster-runner-launcher hmac-key="$(openssl rand -hex 32)"`），且 cloud 侧 `ASTER_RUNNER_LAUNCHER_HMAC_KEY` env 用**同一值**（双向验签一致）。

- [ ] **Step 1: 写 external-secrets.yaml**

`k3s/apps/aster-lang/aster-runner/external-secrets.yaml`：

```yaml
# runner-launcher HMAC key ExternalSecret（S2-1a-2 Slice-2b-launch）
# ★HMAC key 隔离（spec §Fork F / Global Constraints）：独立 key ASTER_RUNNER_LAUNCHER_HMAC_KEY，
#   绝不复用 plan-gate hmac-key。同一值须同步写入 cloud 侧 env（signRunnerLauncherHeaders 用它签）。
#
# Vault path（★待确认 placeholder）：secret/apps/aster-runner-launcher
#   写入：vault kv put secret/apps/aster-runner-launcher hmac-key="$(openssl rand -hex 32)"
#   同一 hmac-key 也须写入 aster-cloud 的 ASTER_RUNNER_LAUNCHER_HMAC_KEY（cloud 签 / launcher 验一致）。
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: aster-runner-launcher-hmac
  namespace: aster-runner
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: vault-backend
    kind: ClusterSecretStore
  target:
    name: aster-runner-launcher-hmac # deployment.yaml secretKeyRef 引用此 secret
    creationPolicy: Owner
    deletionPolicy: Retain
  data:
    - secretKey: hmac-key # → deployment env ASTER_RUNNER_LAUNCHER_HMAC_KEY
      remoteRef:
        key: apps/aster-runner-launcher
        property: hmac-key
```

- [ ] **Step 2: 渲染检查 + commit**

`kubectl kustomize` 渲染无误 → `feat(k3s): runner-launcher HMAC key ExternalSecret（独立 key，Vault path 待确认）`。

### Task 4.7: network-policy.yaml（★k3s kube-router caveat）

**Files:**
- Create: `k3s/apps/aster-lang/aster-runner/network-policy.yaml`

**★k3s kube-router NetworkPolicy caveat（承 cloud kustomization 注释惯例）：** k3s 默认 CNI（flannel + kube-router）对 NetworkPolicy 的支持有已知边界（部分 egress/ipBlock 语义在某些 k3s 版本不完全 enforce）。cloud 的做法是**提供 policy 但注释掉/标注 caveat**，避免误以为 enforce 生效。本文件同样提供完整 policy 但**默认注释禁用**（若集群 CNI 确认支持 NetworkPolicy enforce 再启用）。

- [ ] **Step 1: 写 network-policy.yaml（默认注释禁用，带 caveat）**

`k3s/apps/aster-lang/aster-runner/network-policy.yaml`：

```yaml
# runner-launcher NetworkPolicy（S2-1a-2 Slice-2b-launch）
# ★k3s kube-router caveat（承 cloud kustomization 惯例）：k3s 默认 CNI 对 NetworkPolicy 的
#   enforce 存在已知边界（部分 egress/ipBlock 语义未完全 enforce）。为避免「以为 enforce 生效」
#   的安全假象，本 policy 默认注释禁用——待确认集群 CNI 支持后再启用（届时从 kustomization
#   resources 引入并解注释）。若集群已用支持 NetworkPolicy 的 CNI（如 Calico），可直接启用。
#
# 期望语义（启用后）：
#   - ingress：只允许来自 cloudflare namespace 的 cloudflared Pod 访问 8080（tunnel 是唯一入口）。
#   - egress：允许 DNS（53）+ kube-apiserver（建 Job/读 log）；其余默认拒绝。
#
# apiVersion: networking.k8s.io/v1
# kind: NetworkPolicy
# metadata:
#   name: runner-launcher
#   namespace: aster-runner
#   labels:
#     app.kubernetes.io/name: runner-launcher
#     app.kubernetes.io/part-of: aster-lang
# spec:
#   podSelector:
#     matchLabels:
#       app.kubernetes.io/name: runner-launcher
#   policyTypes:
#     - Ingress
#     - Egress
#   ingress:
#     # 只允许 cloudflared（tunnel）访问 launcher 8080。
#     - from:
#         - namespaceSelector:
#             matchLabels:
#               kubernetes.io/metadata.name: cloudflare
#           podSelector:
#             matchLabels:
#               app.kubernetes.io/name: cloudflared
#       ports:
#         - protocol: TCP
#           port: 8080
#   egress:
#     # DNS 解析。
#     - to:
#         - namespaceSelector: {}
#       ports:
#         - protocol: UDP
#           port: 53
#         - protocol: TCP
#           port: 53
#     # kube-apiserver（建 Job/读 log）——apiserver IP 因集群而异，此处放行全部 TCP 443 到 default ns
#     #   的 kubernetes Service（启用时按实际 apiserver endpoint 收窄）。
#     - to:
#         - namespaceSelector:
#             matchLabels:
#               kubernetes.io/metadata.name: default
#       ports:
#         - protocol: TCP
#           port: 443
```

★说明：整个 policy 体注释掉是刻意的（caveat 使然）——文件存在但不 enforce，避免安全假象。**不**加入 kustomization resources（注释文件加进 resources 会渲染空，kustomize 报错），仅作文档/待启用占位。启用时：取消注释 + 加进 Task 4.8 的 resources。

- [ ] **Step 2: commit**

`feat(k3s): runner-launcher NetworkPolicy（k3s kube-router caveat，默认注释禁用待 CNI 确认）`。

### Task 4.8: 更新 kustomization.yaml resources

**Files:**
- Edit: `k3s/apps/aster-lang/aster-runner/kustomization.yaml`

- [ ] **Step 1: 把 Unit 4 manifests 加进 resources**

`k3s/apps/aster-lang/aster-runner/kustomization.yaml`（2b-seed 只有 `namespace.yaml`，现加全部 launcher manifests；network-policy 默认注释禁用故**不**列入）：

```yaml
# Aster Runner 命名空间 + launcher 微服务（S2-1a-2 Slice-2b-launch）
# 由 ApplicationSet aster-lang-apps 自动发现并部署（apps/aster-lang/*/kustomization.yaml）。
# 2b-seed 只建 namespace；2b-launch 加入 launcher Deployment/SA/Role/RoleBinding/Service/ExternalSecret。
# ★network-policy.yaml 默认注释禁用（k3s kube-router caveat），故不列入 resources——
#   待确认集群 CNI 支持 NetworkPolicy enforce 后再解注释并加入。
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

namespace: aster-runner

resources:
  - namespace.yaml
  - serviceaccount.yaml
  - role.yaml
  - rolebinding.yaml
  - deployment.yaml
  - service.yaml
  - external-secrets.yaml
```

- [ ] **Step 2: 全量渲染检查**（本地实测，无 apply）

`kubectl kustomize k3s/apps/aster-lang/aster-runner/` 应渲染出：Namespace + ServiceAccount + Role + RoleBinding + Deployment + Service + ExternalSecret，全部 `namespace: aster-runner`。★yq 抽查 Role rules 无 `pods/attach`、无 ClusterRole；Deployment `automountServiceAccountToken:true`；HMAC 从 secretKeyRef。

- [ ] **Step 3: commit**

`feat(k3s): aster-runner kustomization 加入 launcher manifests（SA/Role/RoleBinding/Deployment/Service/ExternalSecret）`。

---

## Unit 5 — launcher 镜像信任根种子（k3s 仓）— ★被 flag 的缺口

**★这是 Global Constraints 明确标注的 gap：** 2b-seed 只种了 **runner** 镜像的信任根（allowed-images 第 3 条 + 两 runner CIP + runner image-lock）。**launcher 镜像 `docker.io/wontlost/aster-runner-launcher` 需要它自己的一整套信任根**——否则 launcher 镜像被 admission 拒（未在 allowed-images 白名单 → image-lock 出现即拒；无 CIP → cosign 无从验签）。

**★CRITICAL：verify-cip-sync 2N 契约变更（3 仓/6 CIP → 4 仓/8 CIP）。** `verify-cip-sync.sh:42-45` 硬校验 `CIP 数量 == 2×repo_count`。加 allowed-images 第 4 条（launcher）后 `repo_count=4`，期望 `8 CIP`——**故 allowed-images 第 4 条与 2 个 launcher CIP 必须原子同落**（同 2b-seed 的「allowed-images 条 + CIP 同 PR」原子耦合铁律：先加 allowed-images 条不加 CIP → `verify-cip-sync` 立刻 fail `期望 8 得 6`；先加 CIP 不加 allowed-images 条 → 也 fail `期望 6 得 8`）。★引用 2b-seed 教训：allowed-images 受 push-ruleset 保护 → **人工 commit**（非 auto-PR），且必须与 CIP 同一 commit/PR 一起过 `verify-cip-sync` 门。

**信任根身份（对齐 Unit 6 的 launcher deploy workflow cosign identity）：**
- allowed-images 第 4 条：`sourceRepo: aster-cloud/aster-api`，`workflowFile: aster-runner-launcher-deploy.yml`，`sourceRef: refs/heads/main`。
- 2 CIP 镜像 runner 的两 CIP，glob 换 `index.docker.io/wontlost/aster-runner-launcher`。

### Task 5.1: allowed-images 第 4 条（★人工 commit，push-ruleset 保护）

**Files:**
- Edit: `k3s/.github/image-pin/allowed-images.yaml`

- [ ] **Step 1: 加 launcher 第 4 条**

在 `k3s/.github/image-pin/allowed-images.yaml` 的 `images:` 列表末尾（runner 第 3 条之后）追加：

```yaml
  # ── aster-runner-launcher 镜像（S2-1a-2 Slice-2b-launch）─────────────
  # launcher 是 in-cluster 微服务（建 runner Job），源仓同 aster-api 但独立 workflow
  # （aster-runner-launcher-deploy.yml）签发。★verify-cip-sync 的 2N 契约因本条从
  #   3 仓→4 仓：本条与两 launcher CIP 必须原子同落（否则 verify-cip-sync fail）。
  - image: docker.io/wontlost/aster-runner-launcher
    sourceRepo: aster-cloud/aster-api         # 唯一合法源仓（org=aster-cloud）
    workflowFile: aster-runner-launcher-deploy.yml
    sourceRef: refs/heads/main
```

★本文件受 push-ruleset 保护（头注 L5-8）——**人工 commit，禁 image-pin auto-PR 修改**。且必须与 Task 5.2 的 2 CIP **同一 commit/PR**（原子耦合，见本 Unit 说明）。

- [ ] **Step 2: 单独此步不跑 verify-cip-sync**（会 fail：加了 allowed-images 第 4 条但 CIP 还是 6 → `期望 8 得 6`）。**verify-cip-sync 门在 Task 5.2 CIP 加完后一起跑**（原子）。此步只 yq 校验 schema 合法：

`IMAGE=docker.io/wontlost/aster-runner-launcher yq '.images | map(select(.image == strenv(IMAGE))) | length' k3s/.github/image-pin/allowed-images.yaml` 应输出 `1`。

- [ ] **Step 3: 暂存（不单独 commit——与 5.2 同 commit）**

`git add k3s/.github/image-pin/allowed-images.yaml`（暂不 commit；与 5.2 CIP 一起 commit 保原子）。

### Task 5.2: 两 launcher CIP（★与 allowed-images 第 4 条原子同落，verify-cip-sync exit 0 = 8 CIP）

**Files:**
- Create: `k3s/apps/infrastructure/policy-controller/policies/cluster-image-policy-aster-runner-launcher.yaml`
- Create: `k3s/apps/infrastructure/policy-controller/policies/cluster-image-policy-aster-runner-launcher-reject-tag.yaml`
- Edit: `k3s/apps/infrastructure/policy-controller/policies/kustomization.yaml`

- [ ] **Step 1: 写 digest-verify CIP（镜像 runner 的，glob 换 launcher）**

`k3s/apps/infrastructure/policy-controller/policies/cluster-image-policy-aster-runner-launcher.yaml`：

```yaml
# digest-verify CIP：aster-runner-launcher（S2-1a-2 Slice-2b-launch）
# 信任根：sourceRepo aster-cloud/aster-api, workflowFile aster-runner-launcher-deploy.yml,
#   sourceRef refs/heads/main（对齐 aster-runner-launcher-deploy.yml 的 cosign identity-regexp）。
# ★verify-cip-sync 的 2N 契约：本 CIP + reject-tag CIP + allowed-images 第 4 条必须同在（4 仓→8 CIP）。
apiVersion: policy.sigstore.dev/v1beta1
kind: ClusterImagePolicy
metadata:
  name: wontlost-aster-runner-launcher
  annotations:
    argocd.argoproj.io/sync-wave: "2"
spec:
  images:
    - glob: "index.docker.io/wontlost/aster-runner-launcher@sha256:**"
  authorities:
    - keyless:
        identities:
          - issuer: https://token.actions.githubusercontent.com
            subject: https://github.com/wontlost-ltd/aster-api/.github/workflows/aster-runner-launcher-deploy.yml@refs/heads/main
  mode: enforce
```

★字段严格对齐 `verify-cip-sync.sh` 收紧规则（L99-105）：`.spec` 恰 `authorities,images,mode` 三键；`authorities[0]` 恰 `keyless`；`keyless` 恰 `identities`；`identities[0]` 恰 `issuer,subject`（禁 Regexp 字段 OR 扩权）。

- [ ] **Step 2: 写 tag-fail CIP**

`k3s/apps/infrastructure/policy-controller/policies/cluster-image-policy-aster-runner-launcher-reject-tag.yaml`：

```yaml
# tag-fail CIP：aster-runner-launcher（闭 unresolved-tag TOCTOU）
apiVersion: policy.sigstore.dev/v1beta1
kind: ClusterImagePolicy
metadata:
  name: wontlost-aster-runner-launcher-reject-tag
  annotations:
    argocd.argoproj.io/sync-wave: "2"
spec:
  images:
    - glob: "index.docker.io/wontlost/aster-runner-launcher:**"
  authorities:
    - static:
        action: fail
        message: "受控仓 aster-runner-launcher 只允许 cosign-verified digest；tag 形式一律拒绝（S2-0 TOCTOU 闭合）"
  mode: enforce
```

- [ ] **Step 3: 加进 policies kustomization.yaml**

`k3s/apps/infrastructure/policy-controller/policies/kustomization.yaml` 头注改 `6 个` → `8 个`，resources 末尾加两条：

```yaml
# 8 个 ClusterImagePolicy（4 digest-verify + 4 tag-fail）。
# ★内层 Git source 只指向本目录，不含 application.yaml（防 multi-source 递归认领）。
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - cluster-image-policy-aster-api.yaml
  - cluster-image-policy-aster-api-reject-tag.yaml
  - cluster-image-policy-aster-cloud-migrate.yaml
  - cluster-image-policy-aster-cloud-migrate-reject-tag.yaml
  - cluster-image-policy-aster-replay-runner.yaml
  - cluster-image-policy-aster-replay-runner-reject-tag.yaml
  - cluster-image-policy-aster-runner-launcher.yaml
  - cluster-image-policy-aster-runner-launcher-reject-tag.yaml
```

- [ ] **Step 4（回归门）：verify-cip-sync.sh exit 0（现期望 8 CIP）**

`bash k3s/scripts/image-pin/verify-cip-sync.sh` 应打印 `CIP-SYNC OK: 8 个 CIP 与信任根 4 仓契约一致` 并 exit 0。★这是原子耦合的证据：allowed-images 第 4 条（Task 5.1）+ 两 launcher CIP（本 Task）同在才过；缺任一即 fail（`期望 8 得 6` 或 `期望 6 得 8`）。同时 `kubectl kustomize k3s/apps/infrastructure/policy-controller/policies/` 渲染 8 个 CIP 无误。

- [ ] **Step 5: 原子 commit（allowed-images 第 4 条 + 两 CIP + policies kustomization 同 commit）**

`git add k3s/.github/image-pin/allowed-images.yaml k3s/apps/infrastructure/policy-controller/policies/cluster-image-policy-aster-runner-launcher*.yaml k3s/apps/infrastructure/policy-controller/policies/kustomization.yaml && git commit`——message：`feat(k3s): launcher 镜像信任根（allowed-images 第4条 + 2 CIP，原子；verify-cip-sync 4仓/8CIP）`。★因 allowed-images 受 push-ruleset 保护，此 commit 走**人工流程**（非 image-pin auto-PR），引用 2b-seed 的同一原子耦合教训。

### Task 5.3: launcher image-lock 条目（第 2 条 alongside runner）

**Files:**
- Edit: `k3s/apps/aster-lang/aster-runner/image-lock.yaml`

**★决策说明（launcher pin 住哪）：** launcher 镜像的 digest pin 落在**同一个** `aster-runner/image-lock.yaml`（与 runner entry 并列第 2 条）——因为 launcher 镜像也是 `aster-runner` ns 的 workload（Deployment 引用它），归属同一 ns 的 image-lock 语义正确。★注意区分两个 digest：
- **launcher image-lock 条**（本 Task）：pin launcher Deployment 自身镜像的 digest → 由 launcher 的 image-pin（Unit 6 workflow，`LOCK_PATH=aster-runner/image-lock.yaml` + `KUSTOMIZATION_PATH`）覆写。
- **RUNNER_IMAGE_DIGEST env**（Unit 4 deployment.yaml）：runner 镜像的 digest → 由 runner workflow 的第三写目标（Unit 6 Task 6.3）patch。
两者独立，勿混。

★★**关键工程门（承 A2 fail-closed 根因）：** `open-image-pin-pr.sh:61-66` 硬校验目标镜像在 image-lock **和** kustomization 里**各恰 1 条**。launcher 镜像走 launcher deploy workflow 的 image-pin 时，需要 launcher 镜像同时在 `aster-runner/image-lock.yaml`（本 Task 种）**和** kustomization 的 `images:` 段各有一条占位——否则 `count/kcount != 1` fail-closed exit 1。**故本 Task 须同时在 image-lock 种 launcher 占位条 + 在 aster-runner kustomization 加 `images:` 段 launcher 条。**

- [ ] **Step 1: image-lock 加 launcher 第 2 条（占位）**

`k3s/apps/aster-lang/aster-runner/image-lock.yaml` 的 `images:` 列表加第 2 条（runner 条之后）：

```yaml
  # launcher 镜像 pin（S2-1a-2 Slice-2b-launch）——由 aster-runner-launcher-deploy.yml 的 image-pin
  #   步覆写（LOCK_PATH 指向本文件）。占位：digest 全零 + sourceSha=UNVERIFIED-SEED，
  #   首个真 pin 由 launcher 首个 CI PR 写入。★与 runner 条独立（两个不同镜像的两个 pin）。
  - image: docker.io/wontlost/aster-runner-launcher
    digest: sha256:0000000000000000000000000000000000000000000000000000000000000000
    sourceSha: UNVERIFIED-SEED # launcher 首个 CI PR 覆盖为真实 github.sha
    runId: "0"
```

- [ ] **Step 2: aster-runner kustomization 加 `images:` 段（launcher 条，供 image-pin kcount==1）**

`k3s/apps/aster-lang/aster-runner/kustomization.yaml` 加 `images:` 段（kustomize image transformer——把 Deployment 里的 launcher 镜像按 digest 覆写为部署真相；image-pin 脚本 `kcount` 校验此段）：

```yaml
# ★launcher 镜像 digest（部署真相）：image-pin 脚本改写此段的 digest，k3s verify 校验 == image-lock。
#   RUNNER_IMAGE_DIGEST（runner 镜像）不在此——那走 deployment.yaml env 的第三写目标（Unit 6）。
images:
  - name: docker.io/wontlost/aster-runner-launcher
    digest: sha256:0000000000000000000000000000000000000000000000000000000000000000
```

★注意：deployment.yaml 里 launcher `image:` 写的是 `docker.io/wontlost/aster-runner-launcher@sha256:<placeholder>`——kustomize `images:` transformer 的 `name` 匹配 `@` 前的 repo 部分，用 `digest` 覆写。两处占位 digest 一致（首个真 pin 会同步覆写 image-lock + 此 kustomization 段，同 cloud 的双写目标机制）。

- [ ] **Step 3: 渲染 + yq 校验 + commit**

`kubectl kustomize k3s/apps/aster-lang/aster-runner/` 渲染无误（launcher Deployment 镜像被 images transformer 处理）。yq 校验：
`IMAGE=docker.io/wontlost/aster-runner-launcher yq '.images | map(select(.image == strenv(IMAGE))) | length' k3s/apps/aster-lang/aster-runner/image-lock.yaml` == `1`；
`IMAGE=docker.io/wontlost/aster-runner-launcher yq '.images | map(select(.name == strenv(IMAGE))) | length' k3s/apps/aster-lang/aster-runner/kustomization.yaml` == `1`。
commit：`feat(k3s): launcher image-lock + kustomization images 占位条（供 launcher image-pin 双写目标 count==1）`。

---

## Unit 6 — launcher Dockerfile + CI/cosign deploy workflow + image-pin 第三写目标（aster-api 仓）

**职责：** launcher 的容器化 + 发版链（镜像 runner 的已验证 CI/cosign 模式）+ image-pin 脚本第三写目标（Fork A 机制：patch launcher Deployment 的 `RUNNER_IMAGE_DIGEST` env）。

**★安全敏感（SHIPPED-CI 变更）：** `open-image-pin-pr.sh` 是已上线发布链脚本——第三写目标须**加固 Codex 审 + 现有 aster-api/migrate pin 回归测试保持不变**（零改动铁律：第三写目标仅由新 env var 激活，不传即完全等同现状）。

### Task 6.1: launcher Dockerfile（multi-stage Go build + 非 root + arch 断言）

**Files:**
- Create: `aster-api/launcher/Dockerfile`

- [ ] **Step 1: 写 Dockerfile（镜像 runner Dockerfile 的 arch 断言纪律）**

`aster-api/launcher/Dockerfile`：

```dockerfile
# runner-launcher 镜像（S2-1a-2 Slice-2b-launch）：multi-stage Go 构建 → distroless static 运行时。
# ★集群节点 ARM64（OCI Ampere），必须真 arm64（承 runner/Dockerfile arch 断言纪律，防 QEMU 误标）。

# ── builder：编 launcher 静态二进制 ──
FROM --platform=$BUILDPLATFORM golang:1.23-alpine AS builder
ARG TARGETOS
ARG TARGETARCH
WORKDIR /src
# 先拷 go.mod/go.sum 单独缓存依赖层（源码变更不失效依赖缓存）。
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# CGO_ENABLED=0 静态编译（distroless static 无 libc）；-trimpath 去构建路径；交叉编到 TARGETARCH。
RUN set -eux; \
    CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath -ldflags="-s -w" -o /out/launcher ./cmd/launcher

# ── runtime：distroless static（无 shell/包管理器，最小攻击面）+ 非 root ──
FROM --platform=$TARGETPLATFORM gcr.io/distroless/static-debian12:nonroot
ARG TARGETARCH
# arch 断言：防 buildx/QEMU 跨构建静默产 amd64 却标 arm64 → 节点 exec format error。
# ★distroless 无 shell/uname——改用 Go 二进制自身 GOARCH（编译期锁定）+ 构建期在 builder 校验：
#   builder 与 runtime 同 TARGETARCH，故这里只 COPY 已按 TARGETARCH 编好的二进制。
#   （运行期 arch 由 build-push-action 的 --platform + workflow 的 in-image uname 断言兜底，见 Task 6.2。）
WORKDIR /app
COPY --from=builder /out/launcher /app/launcher
# distroless:nonroot 默认 UID 65532（与 Deployment securityContext runAsUser 65532 一致）。
USER 65532:65532
ENTRYPOINT ["/app/launcher"]
```

★说明：distroless static 无 `uname`（无 shell），故 runtime 层的 arch 断言靠 build 期（builder 交叉编译 GOARCH 锁定）+ workflow 的 in-image 断言（Task 6.2 用 `--entrypoint` 拉不到 uname 时改用 `docker buildx imagetools inspect` 校验 manifest architecture，或对 launcher 二进制 `file` 判断）——比 runner 的 busybox uname 路径受限，故 workflow 层用 manifest inspect 兜底。

- [ ] **Step 2: 本地 build 验证 + commit**

`cd aster-api/launcher && docker build --platform linux/arm64 -t aster-runner-launcher:local .`（本地有 buildx/QEMU 时）应成功产 arm64 镜像。commit：`feat(launcher): multi-stage Go Dockerfile（distroless static nonroot + arch 纪律）`。

### Task 6.2: aster-runner-launcher-deploy.yml（镜像 runner deploy workflow）

**Files:**
- Create: `aster-api/.github/workflows/aster-runner-launcher-deploy.yml`

**★逐字镜像 `aster-replay-runner-deploy.yml` 的模式：** build（arm64 push 出 digest）→ sign（cosign keyless，identity-regexp 指向**本 workflow 文件名**）→ image-pin-pr（开 PR pin launcher digest + 传 LOCK_PATH 指 aster-runner）。**差异：** launcher 无 gen-expected parity（它不产 replay 证据，无 corpus parity 意义）——故**去掉 parity-arm64 job**（诚实：launcher 是编排器非 executor，parity 对它无定义）。

- [ ] **Step 1: 写 workflow**

`aster-api/.github/workflows/aster-runner-launcher-deploy.yml`：

```yaml
name: aster-runner-launcher deploy

# runner-launcher 镜像发版链（S2-1a-2 Slice-2b-launch）：build（arm64 digest）→
# sign（cosign keyless @digest 签+验）→ image-pin-pr（PR 到 k3s pin launcher digest +
# 第三写目标 patch runner digest env）。镜像 aster-replay-runner-deploy.yml，但去 parity-arm64
# （launcher 是编排器非 executor，无 corpus parity 语义——诚实边界）。
on:
  push:
    branches: [main]
    # ★不设 paths 过滤（承 runner workflow 同理由）：image-pin 前的 stale-gate 正确性要求
    #   每个 main commit 都有自己的 run 接手（paths 白名单会造发布活性死角）。pin 幂等，无害。
  # ★不设 workflow_dispatch：sign 的 cosign verify --certificate-identity-regexp 硬锁 @refs/heads/main，
  #   非 main dispatch 会在 verify 阶段失败。launcher 镜像只随 main push。

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      id-token: write   # cosign keyless OIDC
      contents: read
    outputs:
      digest: ${{ steps.build.outputs.digest }}
    steps:
      - uses: actions/checkout@v7

      - uses: docker/setup-qemu-action@v4
      - uses: docker/setup-buildx-action@v4
      - uses: docker/login-action@v4
        with:
          username: ${{ secrets.DOCKER_USERNAME }}
          password: ${{ secrets.DOCKER_PASSWORD }}

      - name: Build & Push launcher image (arm64)
        id: build
        uses: docker/build-push-action@v7
        with:
          # context/file = launcher 子目录（独立 Go，own go.mod/Dockerfile）。
          context: launcher
          file: launcher/Dockerfile
          # 集群节点 ARM64（OCI Ampere），必须真 arm64。
          platforms: linux/arm64
          push: true
          pull: true
          # 清默认 attestation manifest（platform=unknown 条目会被 k3s 误选）；单平台不需要。
          provenance: false
          sbom: false
          tags: |
            wontlost/aster-runner-launcher:${{ github.sha }}
            wontlost/aster-runner-launcher:latest

      # ★arm64 内容校验：distroless static 无 uname——用 buildx imagetools inspect 校验 manifest
      #   的 platform.architecture == arm64（QEMU 误标兜底；manifest architecture 亦可被撒谎但
      #   配合 build 期 GOARCH 锁定 + 单平台 push，双重约束足够）。
      - name: Verify pushed image is arm64 (manifest inspect)
        env:
          DIGEST: ${{ steps.build.outputs.digest }}
        run: |
          set -euo pipefail
          test -n "${DIGEST}" || { echo "build 未输出 digest，中止"; exit 1; }
          arch="$(docker buildx imagetools inspect "wontlost/aster-runner-launcher@${DIGEST}" \
            --format '{{ range .Manifest.Manifests }}{{ println .Platform.Architecture }}{{ end }}' 2>/dev/null \
            | grep -v '^unknown$' | grep -v '^$' | sort -u | head -n1 || true)"
          # 单平台 push 时 Manifest.Manifests 可能为空 → 退回顶层 Platform。
          if [ -z "$arch" ]; then
            arch="$(docker buildx imagetools inspect "wontlost/aster-runner-launcher@${DIGEST}" \
              --format '{{ .Manifest.Config.Platform.Architecture }}' 2>/dev/null | tr -d '[:space:]' || true)"
          fi
          echo "manifest architecture = '${arch}'"
          case "${arch}" in
            arm64|aarch64) echo "✓ arm64" ;;
            *) echo "::error title=arch mismatch::launcher 镜像 manifest architecture='${arch}'（非 arm64）"; exit 1 ;;
          esac

  sign:
    needs: build
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: sigstore/cosign-installer@v3
      - uses: docker/login-action@v4
        with:
          username: ${{ secrets.DOCKER_USERNAME }}
          password: ${{ secrets.DOCKER_PASSWORD }}
      - name: Sign + verify pushed digest (keyless)
        env:
          COSIGN_YES: "true"
          DIGEST: ${{ needs.build.outputs.digest }}
        run: |
          set -euo pipefail
          test -n "${DIGEST}" || { echo "build 未输出 digest，中止"; exit 1; }
          cosign sign "wontlost/aster-runner-launcher@${DIGEST}"
          # ★identity-regexp 指向**本** workflow 文件名（aster-runner-launcher-deploy.yml）。
          #   与两 launcher CIP 的 subject（Unit 5）逐字对齐。fail-closed。
          cosign verify "wontlost/aster-runner-launcher@${DIGEST}" \
            --certificate-identity-regexp "^https://github.com/${GITHUB_REPOSITORY}/\.github/workflows/aster-runner-launcher-deploy\.yml@refs/heads/main$" \
            --certificate-oidc-issuer "https://token.actions.githubusercontent.com"

  image-pin-pr:
    # ★needs build+sign：解析 needs.build.outputs.digest + 只 pin 已签 digest（无 parity job）。
    needs: [build, sign]
    if: ${{ github.event_name == 'push' && github.ref == 'refs/heads/main' && vars.IMAGE_PIN_APP_CLIENT_ID != '' }}
    runs-on: ubuntu-latest
    concurrency:
      group: image-pin-pr-aster-runner-launcher   # per-image，不与其他镜像 job 互相取消
      cancel-in-progress: true
    steps:
      - name: Final stale gate (再确认 github.sha 仍是 origin/main tip)
        id: staleguard
        run: |
          set -euo pipefail
          tip="$(git ls-remote https://github.com/${{ github.repository }}.git refs/heads/main | cut -f1)"
          echo "this run: ${GITHUB_SHA}  origin/main tip: ${tip}"
          if [ "${GITHUB_SHA}" = "$tip" ]; then
            echo "stale=false" >> "$GITHUB_OUTPUT"
          else
            echo "::notice::main 已前进，本 run 过时 → 跳过 image-pin PR"
            echo "stale=true" >> "$GITHUB_OUTPUT"
          fi

      - name: Mint k3s-scoped token
        if: ${{ steps.staleguard.outputs.stale != 'true' }}
        id: apptoken
        uses: actions/create-github-app-token@v3.2.0
        with:
          client-id: ${{ vars.IMAGE_PIN_APP_CLIENT_ID }}
          private-key: ${{ secrets.IMAGE_PIN_APP_PRIVATE_KEY }}
          owner: wontlost-ltd
          repositories: k3s
          permission-contents: write
          permission-pull-requests: write

      - name: Checkout (for shared script)
        if: ${{ steps.staleguard.outputs.stale != 'true' }}
        uses: actions/checkout@v7

      - name: Open/update image-pin PR to k3s (launcher digest, LOCK_PATH → aster-runner)
        if: ${{ steps.staleguard.outputs.stale != 'true' }}
        env:
          GH_TOKEN: ${{ steps.apptoken.outputs.token }}
          DIGEST: ${{ needs.build.outputs.digest }}
          SOURCE_SHA: ${{ github.sha }}
          RUN_ID: ${{ github.run_id }}
          # ★LOCK_PATH/KUSTOMIZATION_PATH 指 aster-runner（非 default cloud/）——pin launcher 自身镜像。
          LOCK_PATH: apps/aster-lang/aster-runner/image-lock.yaml
          KUSTOMIZATION_PATH: apps/aster-lang/aster-runner/kustomization.yaml
        run: |
          bash scripts/ci/open-image-pin-pr.sh \
            docker.io/wontlost/aster-runner-launcher image-pin/aster-runner-launcher
```

★说明：本 workflow pin 的是 **launcher 自己的镜像**（`LOCK_PATH`/`KUSTOMIZATION_PATH` 指 aster-runner，改写 launcher image-lock/kustomization 条）。**runner digest env 的第三写目标是 runner workflow 的职责**（Task 6.3 改 runner workflow）——不在本 launcher workflow。

- [ ] **Step 2: 本地 lint（actionlint 若装）+ commit**

`actionlint aster-api/.github/workflows/aster-runner-launcher-deploy.yml`（若装）无错。commit：`feat(launcher): aster-runner-launcher-deploy workflow（build+cosign sign+image-pin，无 parity job）`。

### Task 6.3: ★image-pin 脚本第三写目标（Fork A 机制——SHIPPED-CI 安全敏感变更）

**Files:**
- Edit: `aster-api/scripts/ci/open-image-pin-pr.sh`（加可选第三写目标，仅新 env var 激活）
- Edit: `aster-api/.github/workflows/aster-replay-runner-deploy.yml`（runner workflow 传第三写目标参数 + LOCK_PATH 指 aster-runner）
- Create: `aster-api/scripts/ci/open-image-pin-pr-thirdtarget.bats`（或 shell 断言脚本：验现有 pin 零改动 + 第三目标激活时 patch env）

**★零改动铁律（承 spec §迁移/破坏性）：** 第三写目标**仅由新 env var 激活**（`ENV_PATCH_PATH` + `ENV_PATCH_SELECTOR` + `ENV_PATCH_VALUE`）。不传这些 → 脚本行为**完全等同现状**（aster-api/migrate/cloud 的 image-pin 路径零改动）。这是安全敏感的 SHIPPED-CI 变更，须加固 Codex 审 + 现有 pin 回归测试证明不变。

- [ ] **Step 1（RED）：写回归 + 新行为断言测试**

`aster-api/scripts/ci/open-image-pin-pr-thirdtarget.bats`（用 bats 或纯 shell；核心是**离线**测 yq 写逻辑，不真 clone/push——把脚本的 yq 写段抽成可单测函数，或用 fixture 目录跑）：

```bash
#!/usr/bin/env bats
# 验 open-image-pin-pr.sh 第三写目标：
#   (1) 不传 ENV_PATCH_* → 现有 image-lock/kustomization 双写不变（零改动回归）。
#   (2) 传 ENV_PATCH_* → 额外 patch 指定 Deployment env 的 value（第三写目标）。
# ★离线测：把脚本的「写 3 个目标」逻辑抽成 patch_targets() 函数（见 Step 3），本测直接调它，
#   不触发 git clone/push（那些走 CI 集成，非单测）。

setup() {
  TMP="$(mktemp -d)"
  # 造 fixture：image-lock（runner 条）+ kustomization（runner name）+ launcher deployment（RUNNER_IMAGE_DIGEST env）。
  cat > "$TMP/image-lock.yaml" <<'EOF'
version: 1
images:
  - image: docker.io/wontlost/aster-replay-runner
    digest: sha256:0000000000000000000000000000000000000000000000000000000000000000
    sourceSha: UNVERIFIED-SEED
    runId: "0"
EOF
  cat > "$TMP/kustomization.yaml" <<'EOF'
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
images:
  - name: docker.io/wontlost/aster-replay-runner
    digest: sha256:0000000000000000000000000000000000000000000000000000000000000000
EOF
  cat > "$TMP/deployment.yaml" <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: runner-launcher
spec:
  template:
    spec:
      containers:
        - name: runner-launcher
          env:
            - name: RUNNER_IMAGE_DIGEST
              value: sha256:0000000000000000000000000000000000000000000000000000000000000000
EOF
}
teardown() { rm -rf "$TMP"; }

@test "不传 ENV_PATCH_* → image-lock/kustomization 正常写，deployment 不动（零改动回归）" {
  source "${BATS_TEST_DIRNAME}/open-image-pin-pr.sh" --source-only 2>/dev/null || true
  DIGEST="sha256:$(printf 'a%.0s' {1..64})"
  LOCK_PATH="$TMP/image-lock.yaml" KUSTOMIZATION_PATH="$TMP/kustomization.yaml" \
    IMAGE="docker.io/wontlost/aster-replay-runner" \
    patch_targets "$DIGEST" "seed-sha" "123"
  # image-lock digest 已改。
  run yq '.images[0].digest' "$TMP/image-lock.yaml"
  [ "$output" = "$DIGEST" ]
  # deployment 未被触碰（无 ENV_PATCH_* 时第三目标跳过）。
  run yq '.spec.template.spec.containers[0].env[0].value' "$TMP/deployment.yaml"
  [ "$output" = "sha256:0000000000000000000000000000000000000000000000000000000000000000" ]
}

@test "传 ENV_PATCH_* → 额外 patch deployment RUNNER_IMAGE_DIGEST env（第三写目标）" {
  source "${BATS_TEST_DIRNAME}/open-image-pin-pr.sh" --source-only 2>/dev/null || true
  DIGEST="sha256:$(printf 'b%.0s' {1..64})"
  LOCK_PATH="$TMP/image-lock.yaml" KUSTOMIZATION_PATH="$TMP/kustomization.yaml" \
    IMAGE="docker.io/wontlost/aster-replay-runner" \
    ENV_PATCH_PATH="$TMP/deployment.yaml" \
    ENV_PATCH_SELECTOR='.spec.template.spec.containers[0].env[] | select(.name == "RUNNER_IMAGE_DIGEST")' \
    patch_targets "$DIGEST" "seed-sha" "123"
  run yq '.spec.template.spec.containers[0].env[0].value' "$TMP/deployment.yaml"
  [ "$output" = "$DIGEST" ]
}
```

- [ ] **Step 2（RED→run）：看红**（`patch_targets` 未抽出 / `--source-only` 未支持）。

- [ ] **Step 3（GREEN）：改 `open-image-pin-pr.sh`——抽出 `patch_targets` + 加可选第三写目标**

在 `open-image-pin-pr.sh` 里：(a) 支持 `--source-only`（仅定义函数不执行主流程，供单测 source）；(b) 把 L70-78 的 yq 双写抽成 `patch_targets()`；(c) 加可选第三写目标（`ENV_PATCH_PATH` + `ENV_PATCH_SELECTOR`，未设则跳过）。示例 diff（在 L21 `set -euo pipefail` 后与 L68-78 处）：

```bash
# ── 顶部：新增可选第三写目标 env（Fork A：patch launcher Deployment 的 RUNNER_IMAGE_DIGEST env）──
# ★零改动铁律：不设 ENV_PATCH_PATH → 第三目标完全跳过，脚本行为等同现状（现有 aster-api/migrate pin 不受影响）。
ENV_PATCH_PATH="${ENV_PATCH_PATH:-}"                # 如 apps/aster-lang/aster-runner/deployment.yaml
ENV_PATCH_SELECTOR="${ENV_PATCH_SELECTOR:-}"        # yq 选择器，选到 env 项（含 .value 子键）

# patch_targets：写 image-lock（验签真相）+ kustomization（部署真相）+ 可选 deployment env（Fork A 第三目标）。
# 参数：$1=digest $2=source_sha $3=run_id。用全局 LOCK_PATH/KUSTOMIZATION_PATH/IMAGE/ENV_PATCH_*。
patch_targets() {
  local digest="$1" source_sha="$2" run_id="$3"
  # (1) image-lock：改本 entry 的 digest/sourceSha/runId（原 L70-74）。
  DIGEST="$digest" SOURCE_SHA="$source_sha" RUN_ID="$run_id" IMAGE="$IMAGE" yq -i '
    (.images[] | select(.image == strenv(IMAGE))).digest    = strenv(DIGEST)  |
    (.images[] | select(.image == strenv(IMAGE))).sourceSha = strenv(SOURCE_SHA) |
    (.images[] | select(.image == strenv(IMAGE))).runId     = strenv(RUN_ID)
  ' "$LOCK_PATH"
  # (2) kustomization：改本镜像 digest（原 L76-78）。
  DIGEST="$digest" IMAGE="$IMAGE" yq -i '
    (.images[] | select(.name == strenv(IMAGE))).digest = strenv(DIGEST)
  ' "$KUSTOMIZATION_PATH"
  # (3) ★可选第三写目标（Fork A）：patch 指定 Deployment env 的 value = digest。
  #     仅当 ENV_PATCH_PATH+ENV_PATCH_SELECTOR 都设时执行；否则完全跳过（零改动）。
  if [[ -n "$ENV_PATCH_PATH" && -n "$ENV_PATCH_SELECTOR" ]]; then
    [[ -f "$ENV_PATCH_PATH" ]] || { echo "::error::ENV_PATCH_PATH 不存在: $ENV_PATCH_PATH"; return 1; }
    # 校验选择器命中恰 1 项（防误 patch 多个 env / 漂移）。
    local n
    n="$(DIGEST="$digest" yq "[${ENV_PATCH_SELECTOR}] | length" "$ENV_PATCH_PATH")"
    [[ "$n" == "1" ]] || { echo "::error::ENV_PATCH_SELECTOR 命中 ${n} 项(需恰 1): $ENV_PATCH_SELECTOR"; return 1; }
    DIGEST="$digest" yq -i "(${ENV_PATCH_SELECTOR}).value = strenv(DIGEST)" "$ENV_PATCH_PATH"
    echo "第三写目标已 patch: ${ENV_PATCH_PATH} ← ${digest}"
  fi
}

# ── --source-only：供单测 source 本脚本只取函数定义，不跑主流程 ──
if [[ "${1:-}" == "--source-only" ]]; then return 0 2>/dev/null || exit 0; fi
```

主流程里把原 L70-78 替换为 `patch_targets "$DIGEST" "$SOURCE_SHA" "$RUN_ID"`；`git add` 段加上 `$ENV_PATCH_PATH`（若设）：

```bash
git add "$LOCK_PATH" "$KUSTOMIZATION_PATH"
[[ -n "$ENV_PATCH_PATH" ]] && git add "$ENV_PATCH_PATH" || true
```

★`git diff --quiet` 判无变更那段（L85）也须纳入 `$ENV_PATCH_PATH`：

```bash
if git diff --quiet -- "$LOCK_PATH" "$KUSTOMIZATION_PATH" ${ENV_PATCH_PATH:+"$ENV_PATCH_PATH"}; then
```

- [ ] **Step 4（GREEN→run）：看绿 + 现有 pin 回归**

`bats aster-api/scripts/ci/open-image-pin-pr-thirdtarget.bats`——两用例绿（零改动回归 + 第三目标激活）。★额外回归：手动跑一次现有 aster-api image-pin 场景（不传 ENV_PATCH_*）确认 image-lock/kustomization 双写与改前逐字节一致（`git diff` 只动 digest/sourceSha/runId 三字段，deployment 零触碰）。

- [ ] **Step 5: 改 runner workflow 传第三写目标 + LOCK_PATH 指 aster-runner**

`aster-api/.github/workflows/aster-replay-runner-deploy.yml` 的 `image-pin-pr` job 的 `Open/update image-pin PR to k3s` 步（L257-266）加 env + 传参：

```yaml
      - name: Open/update image-pin PR to k3s
        if: ${{ steps.staleguard.outputs.stale != 'true' }}
        env:
          GH_TOKEN: ${{ steps.apptoken.outputs.token }}
          DIGEST: ${{ needs.build.outputs.digest }}
          SOURCE_SHA: ${{ github.sha }}
          RUN_ID: ${{ github.run_id }}
          # ★LOCK_PATH/KUSTOMIZATION_PATH 指 aster-runner（runner 镜像的 pin 落 runner-ns，Fork A）。
          LOCK_PATH: apps/aster-lang/aster-runner/image-lock.yaml
          KUSTOMIZATION_PATH: apps/aster-lang/aster-runner/kustomization.yaml
          # ★Fork A 第三写目标：把 runner digest 同步 patch 进 launcher Deployment 的 RUNNER_IMAGE_DIGEST env。
          #   launcher 读此 env 构 runner 镜像引用——故 runner pin 一次同时更新 image-lock/kustomization/launcher-env。
          ENV_PATCH_PATH: apps/aster-lang/aster-runner/deployment.yaml
          ENV_PATCH_SELECTOR: '.spec.template.spec.containers[0].env[] | select(.name == "RUNNER_IMAGE_DIGEST")'
        run: |
          bash scripts/ci/open-image-pin-pr.sh \
            docker.io/wontlost/aster-replay-runner image-pin/aster-replay-runner
```

★注意：runner workflow 的 `IMAGE` 仍是 `aster-replay-runner`（pin runner 镜像的 image-lock/kustomization 条），但**额外**第三写目标 patch launcher Deployment 的 `RUNNER_IMAGE_DIGEST` env——这就是 Fork A 机制：runner CI 一次 pin 三处（runner image-lock + runner kustomization 段 + launcher env）。launcher workflow（Task 6.2）不传 ENV_PATCH_*（它 pin launcher 自己镜像，不碰 runner digest）。

- [ ] **Step 6: commit（★安全敏感——commit message 标注需加固 Codex 审）**

`feat(ci): open-image-pin-pr 第三写目标（Fork A：patch launcher RUNNER_IMAGE_DIGEST env；零改动可选激活）+ runner workflow 传参`。commit body 注明：SHIPPED-CI 变更，须加固 Codex 审（见交叉审查 §），现有 aster-api/migrate/cloud pin 回归已验零改动。

---

## 跨仓交付顺序（严格——承 spec §跨仓交付顺序，2b-seed 已合并）

**前置状态（已完成）：** 2b-seed 已合并（k3s）——`aster-runner` namespace + kustomization（只 namespace）+ runner image-lock 占位 + allowed-images 第 3 条（runner）+ 两 runner CIP + AppProject destinations 加 aster-runner ns。ArgoCD 已有空 `aster-runner` App。

**本计划（2b-launch）交付顺序（严格，跨 aster-api + k3s 两仓）：**

1. **launcher Go 源码 + 单测**（aster-api，Units 1-3）：`launcher/` 全量 Go（HMAC 中间件 + Job 编排器 + Orchestrator seam + HTTP handler + main.go）+ 全部单测绿（`go test ./...`）。**先落纯代码——无 CI/镜像依赖，本地可完整验证。** 容量测量 task（2.3）与 E2E 集成测试（2.4）需本地 kind/k3d，可与源码同 PR 或紧随。

2. **launcher Dockerfile + deploy workflow**（aster-api，Unit 6 Task 6.1-6.2）：`launcher/Dockerfile` + `aster-runner-launcher-deploy.yml`。**须 GitHub Actions billing 恢复才能真跑 build/sign**（见 §billing 注）；本地 `docker build` 可先验 Dockerfile。

3. **launcher manifests + 信任根**（k3s，Units 4-5）：
   - Unit 4 manifests（Deployment/SA/Role/RoleBinding/Service/ExternalSecret + kustomization 更新）。
   - **★Unit 5 信任根原子 commit**（allowed-images 第 4 条 + 两 launcher CIP + policies kustomization + launcher image-lock/kustomization 占位）——**人工 commit**（push-ruleset 保护），`verify-cip-sync.sh exit 0`（4 仓/8 CIP）作门。
   - **★admission smoke-test（手动，承 2b-seed runbook）**：给 `aster-runner` ns 贴 `policy.sigstore.dev/include=true` 前（2b-seed 已贴），须先在临时贴标签 ns 跑六态 admission smoke-test 确认两 launcher CIP + 两 runner CIP 生效（未签拒 / tag 拒 / 已签 digest 放行）。

4. **image-pin 脚本第三写目标**（aster-api，Unit 6 Task 6.3）：改 `open-image-pin-pr.sh` + runner workflow 传参。**★安全敏感 SHIPPED-CI——加固 Codex 审 + 现有 pin 回归零改动验证**（见交叉审查 §）。此步让 runner CI 一次 pin 三处（runner image-lock/kustomization + launcher env）。

5. **带外 + 首次真 pin 闭链**：
   - **Cloudflare Tunnel 路由**（带外 dashboard 步，无 in-repo YAML——factbase C10）：dashboard 配 tunnel ingress 把 `/api/v1/runner/launch` 路由到 `runner-launcher.aster-runner.svc.cluster.local:80`。
   - **首次真 digest 写入**：launcher CI 首跑 → launcher image-lock/kustomization 占位被覆写为真 launcher digest（launcher Pod 起）；runner CI 首跑（第三写目标激活）→ runner image-lock/kustomization + launcher `RUNNER_IMAGE_DIGEST` env 被覆写为真 runner digest。**此时链闭合，Slice-2a runner image-pin 转绿**（承 spec §Fork A×E 耦合诚实结论：2b-seed 单独不能转绿，须 launcher 存在）。

**依赖方向：** 1（Go 源码）无外部依赖，最先落且本地全验证；3（manifests）依赖 1 的镜像存在（2 产）但 manifest YAML 本身可先写（placeholder digest）；4（第三写目标）依赖 3 的 launcher deployment.yaml 存在（ENV_PATCH_PATH 指向它）；5 依赖 2/3/4 全部就位。

---

## 交叉审查（强制——禁止自审，承 spec §Fork F）

**★强制交叉审查铁律（CLAUDE.md 审查协作规范）：** 代码生成者与审查者必须分离。本计划由 Claude 生成 → **Codex 加固深审**（如 runner-integrity M1 CCO 深审模式）。禁止自审。审查报告写入 `.claude/review-report.md`，应用审查五层法。

**★加固 Codex 深审的审查清单（keyed to spec §3b / §Fork F）：**

1. **SA 最小权限（§Fork F / 安全一等件）**：
   - Role（`role.yaml`）验证：**无 `pods/attach`**（Fork C 用 stdin 文件注入非 attach）、**无 `pods/exec`**、**无 `secrets`**、**无任何 cluster-scope**（是 Role 非 ClusterRole，仅 `aster-runner` ns）。
   - 验证给的动词是编排 Job 的最小集：batch/jobs[create,get,list,watch,delete] + pods[get,list,watch] + pods/log[get] + configmaps[create,delete]，无多余动词（如 jobs 无 `update/patch`、pods 无 `delete`）。
   - RoleBinding 是命名空间级（非 ClusterRoleBinding）。

2. **无证据自产（§3b：launcher 只编排不产证据）**：
   - 验证 handler 原样透传 runner envelope（`writeJSON(w, 200, env)`），**不改任何字段**——不注入/覆写 replayMetadata 的 5 个 replay-critical 字段。
   - 验证 launcher 不自造 canonicalInputHash/traceHash 等（那是 runner 的职责）；`RunnerEnvelope` Go 类型是纯透传容器。
   - 验证 `req.TenantID = tenant`（以验证过的 header tenant 为权威覆盖 body）不是「伪造证据」——这是防越权的正确收窄，非证据篡改（tenant 是路由/隔离字段非证据字段）。

3. **HMAC key 隔离（§Fork F）**：
   - 验证 `VerifyHMAC` 只读 `ASTER_RUNNER_LAUNCHER_HMAC_KEY`，**绝不 fallback** 到 plan-gate key 或任何其他 key。
   - 验证 deployment.yaml 的 secretKeyRef 指向独立 secret（`aster-runner-launcher-hmac`），external-secret 从独立 Vault path（`apps/aster-runner-launcher`）——与 plan-gate（`apps/aster-api-plan-gate`）完全隔离。
   - 验证 7 行 canonical 逐字节对齐 client `signRunnerLauncherHeaders`（method/path/ts/nonce/bodyHash/tenant/role；ts 用原始字符串非 re-format）。

4. **reject-proof（§Fork F / Global Constraints：绝不裸 500）**：
   - 验证 `ServeHTTP` 的 `defer recover()` 覆盖整个 handler（含 orchestrator panic）→ 结构化 503。
   - 验证所有错误路径都走 `writeJSON`（结构化 JSON）——无 `http.Error`/裸 `panic`/未包裹的 stacktrace 输出。
   - 验证 `writeJSON` 序列化失败也退化为结构化 503（最后一环）——镜像 client 的 `safeErrorMessage` finally guard 哲学。
   - 验证 SUCCESS/ERROR 皆 200、编排不可达 503 的映射与 client 分类逻辑（`runner-launcher-client.ts:71/76/79`）逐一对应。

5. **★image-pin 脚本第三写目标（SHIPPED-CI 安全敏感变更）——最高关注**：
   - **零改动铁律**：验证不传 `ENV_PATCH_*` 时脚本行为**逐字节等同现状**——现有 aster-api/migrate/cloud 的 image-pin 路径完全不受影响（回归测试 `open-image-pin-pr-thirdtarget.bats` 的「零改动回归」用例 + 手动跑现有场景 diff 三字段）。
   - **命中恰 1 项守卫**：验证第三写目标的 `ENV_PATCH_SELECTOR` 命中校验（`n==1`）防误 patch 多个 env / 选择器漂移。
   - **原子性**：验证 `git diff --quiet` / `git add` 都纳入 `$ENV_PATCH_PATH`——第三目标变更与 image-lock/kustomization 变更同一 commit（不漏 add 造脏树）。
   - **--source-only 安全**：验证 `--source-only` 分支不误触发主流程（clone/push）。

**审查决策规则（承 CLAUDE.md）：** Codex 综合评分 ≥90 且建议「通过」→ 直接通过；<80 且「退回」→ 直接退回；80-89 → Claude 仔细审阅后决策。审查报告须含审查五层法完整应用（数据结构 / 特殊情况 / 复杂度≤3层缩进 / 破坏性 / 可行性）。

**审查五层法自检要点（生成时已应用，供 Codex 复核）：**
- **数据结构**：RunnerRequest/RunnerEnvelope 是纯透传容器（launcher 不拥有证据数据，只搬运）；Orchestrator seam 让 handler 与 client-go 解耦。
- **特殊情况**：F 契约的 SUCCESS/ERROR/unavailable 三态用 `(env, err)` + outcome 字段自然表达，非嵌套 if 堆叠；reject-proof 用单一 `defer recover` 统一兜底，非每处 try。
- **复杂度**：`waitForJobTerminal` 用 poll 而非 informer（单发短命 Job，复杂度 <3 层）；handler 是线性 4 步（验签→解析→编排→映射），无深嵌套。
- **破坏性**：纯增量（新 ns/新服务/脚本可选参数）；image-pin 第三写目标零改动激活——现有 pin 路径不破坏。
- **可行性**：容量数字是唯一延后项，但延后本身是有测量流程的具体 task（2.3），非拍脑袋。

---

## §billing 注：GitHub Actions 计费须恢复

**★org GitHub Actions billing 必须恢复**，Unit 6 的镜像 build/sign/deploy workflow（`aster-runner-launcher-deploy.yml` + runner workflow 第三写目标）才能真跑。**不阻塞的部分（本地可完整验证，无需 billing）：**
- Units 1-3 的 Go 单测（`go test ./...`）——纯本地。
- Unit 2.4 / 3.x 的本地 kind/k3d 集成测试（`LAUNCHER_E2E=1`）——本地集群。
- Units 4-5 的 `kubectl kustomize` 渲染检查 + `verify-cip-sync.sh` + yq schema 校验——纯本地。
- Unit 6.1 的 `docker build`（本地 buildx）+ 6.3 的 `bats` 回归测试——纯本地。

**须 billing 的部分：** Unit 6.2 的 CI build+push+cosign sign（Fulcio/Rekor 需 GitHub OIDC）+ image-pin PR（跨仓 App token）。交付顺序步骤 2/5 依赖此——billing 未恢复则镜像链无法闭合，Slice-2a runner image-pin 保持 dry-run（诚实边界，不假装转绿）。
