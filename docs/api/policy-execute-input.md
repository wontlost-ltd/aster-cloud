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

| 输入位置 | 规则 |
|---|---|
| 参数名（顶层键，如 `person`） | 来自策略源码，原样使用，不做映射 |
| 字段名（嵌套对象的键，含列表中的结构） | 本地化名或词条别名（同义词）→ 规范名，大小写不敏感 |
| 枚举字段的值 | 是该枚举成员的本地化名 / 别名时 → 规范值；其它值原样 |
| 类型标签 `__type` 的值 | 结构的本地化名 → 规范名 |
| Map 类型的键 | 是数据，不映射 |
| 未知键 | 原样保留（与以往一致） |

关键词别名（策略版本的 aliasSet）只作用于源码关键词，不参与输入映射。

## 2. 规范名仍然接受

既有 API 客户端发送的规范名输入（`{"person":{"age":35}}`）照常执行，结果相同。

## 3. 同一字段写了两次 → 400

同一对象里同时出现某字段的本地化名与规范名（或它的两个同义词）时，平台不猜测，返回 400：

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
`code` / `field` / `fields` / `policyField`。未发生执行，不计入用量。

## 4. 用哪份词汇

| 被执行的版本 | 词汇 |
|---|---|
| 已审批 / 已弃用 | 审批时冻结的快照（策略作用域内的分组），之后的词条编辑不影响 |
| 草稿、待审批、被拒、无版本记录的旧策略 | 版本作者**当前**的词汇中策略作用域内的分组（与审批冻结同一作用域规则），编辑词条后下一次执行即生效 |

同一份词汇既交给引擎规范化源码，也用于上面的输入映射。版本没有作用域内的词汇时，输入原样交给引擎。

## 5. 响应（向后兼容）

- `output` / `data` 中的结果保持引擎的规范名，与以往一致。
- 控制台端点新增可选字段 `localizedResult`：把结果里的字段名、枚举值还原为策略语言，仅在与
  `output.result` 不同时出现，供界面展示。
- 执行记录（`Execution.input`）保存映射后的规范输入，即引擎实际评估的输入；回放、parity、
  审批登记都以它为准。
