# 策略执行输入（Execute Input）

适用端点：

- `POST /api/policies/{id}/execute`（控制台执行页）
- `POST /api/v1/policies/{id}/execute`（API Key / SDK）

> **实现位置**：`src/lib/execution-input/`（两条路径共用）。改动输入映射规则时，必须同步更新本文档。

---

## 1. 输入使用策略语言

执行输入与策略所用语言一致。德语策略用德语（本地化）字段名书写输入：

```json
{ "input": { "person": { "alter": 35 } } }
```

平台在调用引擎前，按该版本的领域词汇把输入映射为规范名（`{"person":{"age":35}}`）。执行页的
「生成示例」与表单模式产出的就是这种写法，可以直接执行。

映射只发生在**类型确定**的位置。类型取自该版本源码：由引擎 `resolvePolicyTypes` 按版本语言、冻结别名与
同一份词汇**按位置解析**（ADR 0051），得到每个结构 / 字段 / 枚举的规范名与作者写法。

| 输入位置 | 规则 |
|---|---|
| 参数名（顶层键，如 `person`） | 参数是源码局部名，不查词汇：按源码里的写法原样使用。参数名与某个词条同名也一样，无需改用规范名 |
| 类型为已声明结构的对象（含列表 / Map 值里的结构） | 字段键：策略写法、规范名、**该结构下**该字段词条的本地化名与同义词 → 规范名；先精确匹配，再大小写折叠匹配 |
| 类型为已声明枚举的字段值 | 是该枚举成员（任一写法）时 → 规范值；其它值原样 |
| 类型标签 `__type` 的值 | 指向已声明结构时 → 规范名，并按该结构映射字段 |
| Map 类型的键 | 是数据，不映射 |
| 结构内未知键、未知参数、类型未知或原始类型（Text 等）里的值 | 原样保留 |
| 源码无法编译出类型 | 整个输入原样交给引擎 |

关键词别名（策略版本的 aliasSet）只作用于源码关键词，不参与输入映射。

## 2. 规范名仍然接受

既有 API 客户端发送的规范名输入（`{"person":{"age":35}}`）照常执行，结果相同。

## 3. 歧义 → 400

两种情况平台不猜测，返回 400 `ambiguous_input_field`：

- 同一对象里同时出现某字段的本地化名与规范名（或它的两个同义词）；
- 输入用到的写法在该结构（或枚举）里没有精确命中、大小写折叠后又对应多个规范名——例如同一结构下
  `Stufe` 与 `stufe` 是两个不同字段的本地化名，而输入写了 `STUFE`。响应带 `candidates`（可能的规范名），
  请改用精确写法或规范名。写法表按结构 / 枚举分别建立（与引擎同口径：NFC 精确优先，折叠匹配仅在唯一时采用），
  同一个词在不同结构里各有所指不算歧义。

示例（第一种）：

```json
{
  "error": "Input fields \"person.alter\" and \"person.age\" both refer to the policy field \"alter\". Send only one of them.",
  "code": "ambiguous_input_field",
  "field": "person.age",
  "fields": ["person.alter", "person.age"],
  "policyField": "alter"
}
```

## 3a. 缺少规则读取的字段 → 400

输入里缺少规则**实际读取**的字段（或缺少整个参数）时，返回 400 `missing_input_field`。字段语义与
`ambiguous_input_field` 一致：`field` 为缺失字段相对输入的**规范名**路径（引擎原样，程序据此识别），
`policyField` 为策略语言写法（德语策略为 `person.alter`，无词汇时与 `field` 相同），界面展示用它：

```json
{
  "error": "The input is missing the field \"applicant.creditScore\" that the policy reads. Add it to the input and try again.",
  "code": "missing_input_field",
  "field": "applicant.creditScore",
  "policyField": "applicant.creditScore",
  "executionId": "…"
}
```

- 判定在执行端（aster-api）：只有规则执行时真的读到该字段才报错，所以缺少规则没用到的字段、带多余字段都照常执行。
- 单参数规则直接传整个对象（输入不带参数名这一层）时，路径也不带参数名（如 `creditScore`）。
- 引擎已经执行过，所以**照常写执行记录**（decision=`error`，`output.inputError` 带码与规范名路径）并计执行用量；
  v1 另记一次 `api_error` API 调用。响应带 `executionId`（v1 另带 `meta`）。
- 路径之外不透出引擎原文（Java 异常、Polyglot 等）。

### 行为变化（需 aster-api#416 部署后生效）

| 端点 | 变更前 | 变更后 |
|---|---|---|
| `POST /api/v1/policies/{id}/execute` | 200，`success:false`、`errorCode:"execution_failed"`、通用说明，`data` 为执行结果 | **400**，`{ error, code:"missing_input_field", field, policyField, executionId, meta }`，无 `data` |
| `POST /api/policies/{id}/execute`（控制台） | 200，`errorCode:"execution_failed"` | 400，同上（带 `executionId`、`decision`、`durationMs`） |
| `POST /api/policies/evaluate-source`（编辑器预览） | 400，通用说明 | 400，带 `code` / `field` / `policyField` |

执行记录与用量计数在变更前后都会写入（decision=`error`）。按 HTTP 状态码区分成功/失败的 API 集成方需要处理新的 400 分支。

## 4. 用哪份词汇

| 被执行的版本 | 词汇 |
|---|---|
| 已审批 / 已弃用 | 审批时冻结的快照（策略作用域内的分组），之后的词条编辑不影响 |
| 草稿、待审批、被拒、无版本记录的旧策略 | 版本作者（`PolicyVersion.createdBy`，团队策略里可不是所有者）**当前**的词汇中策略作用域内的分组（与审批冻结同一作者与作用域规则），编辑词条后下一次执行即生效；版本无作者时不带词汇 |

同一份词汇既交给引擎规范化源码，也用于上面的输入映射。版本没有作用域内的词汇时，输入原样交给引擎。

版本语言两条路径统一用 `resolveStoredVersionLocale`：版本保存时记录的编译 locale → 冻结快照的唯一 locale →
源码识别。

## 5. 响应（向后兼容）

- `output` / `data` 中的结果保持引擎的规范名，与以往一致。
- 控制台端点新增可选字段 `localizedResult`：把结果里的字段名、枚举值还原为策略语言，仅在与
  `output.result` 不同时出现，供界面展示。
- 执行记录（`Execution.input`）保存映射后的规范输入，即引擎实际评估的输入；回放、parity、
  审批登记都以它为准。
