# 策略执行输入（Execute Input）

适用端点：

- `POST /api/policies/{id}/execute`（控制台执行页）
- `POST /api/v1/policies/{id}/execute`（API Key / SDK）
- `POST /api/v1/policies/{id}/secure-execute`（签名执行）

> **实现位置**：`src/lib/execution-input/`（三条路径共用）。改动输入映射规则时，必须同步更新本文档。

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

`secure-execute` 的响应体沿用其既有形状（`success: false`、`errorCode: "AMBIGUOUS_INPUT_FIELD"`），并附加同样的
`code` / `field` / `fields` / `policyField`（及 `candidates`）。未发生执行，不计入用量。

## 4. 用哪份词汇

| 被执行的版本 | 词汇 |
|---|---|
| 已审批 / 已弃用 | 审批时冻结的快照（策略作用域内的分组），之后的词条编辑不影响 |
| 草稿、待审批、被拒、无版本记录的旧策略 | 版本作者（`PolicyVersion.createdBy`，团队策略里可不是所有者）**当前**的词汇中策略作用域内的分组（与审批冻结同一作者与作用域规则），编辑词条后下一次执行即生效；版本无作者时不带词汇 |

同一份词汇既交给引擎规范化源码，也用于上面的输入映射。版本没有作用域内的词汇时，输入原样交给引擎。

版本语言三条路径统一用 `resolveStoredVersionLocale`：版本保存时记录的编译 locale → 冻结快照的唯一 locale →
源码识别。

## 5. 响应（向后兼容）

- `output` / `data` 中的结果保持引擎的规范名，与以往一致。
- 控制台端点新增可选字段 `localizedResult`：把结果里的字段名、枚举值还原为策略语言，仅在与
  `output.result` 不同时出现，供界面展示。
- 执行记录（`Execution.input`）保存映射后的规范输入，即引擎实际评估的输入；回放、parity、
  审批登记都以它为准。
- `secure-execute`：签名覆盖的是原始输入。每次签名执行，`POLICY_EXECUTED` 安全事件的 `details.inputMapping`
  都记录原始输入哈希 `originalInputSha256` 与改写位置 `renames`（`path` / `from` / `to`，无改写时为空数组），签名内容与执行内容可追溯。
