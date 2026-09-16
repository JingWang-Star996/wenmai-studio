# 平台文章语义连续性门禁

## 目的

平台版不能只证明“格式完整”或“正文与 Word 一致”。每个新登记的 canonical 与平台版本都必须证明，陌生读者仍能从当前正文中读出正面主命题及七项不变量：

1. `author_entry`：作者为何有这个观察入口；经历不能冒充事实证据。
2. `problem_origin`：这篇文章在回答什么真实问题，问题从何而来。
3. `first_term_explanation`：关键术语首次出现时已经解释。
4. `reading_route`：读者知道文章将怎样推进。
5. `core_proposition`：平台版仍在回答 canonical 的核心命题。
6. `evidence_boundary`：事实、推断、类比和未知没有被混写。
7. `responsibility_boundary`：能力增强不能自动推出方向、证据或责任正确。

`primaryThesis` 是非空、无首尾空白的正面主命题文本。`primaryThesisSha256` 是该文本 UTF-8 原文的 SHA-256（不做 trim、JSON 包装或其他规范化）。代码只核对字段结构、UTF-8 原文摘要、精确正文引文和位置；文章主轴是否成立只能依赖可信协调者记录的独立冷读，不能由代码自动理解或断言。`primaryThesisEvidenceQuote` 必须精确等于 `primaryThesis`、同样不得有首尾空白，并作为当前正文至少 8 字的 `lead` 引文出现在前 800 个字符内；它必须早于 `core_proposition`、`evidence_boundary` 与 `responsibility_boundary` 的登记证据。`core_proposition` 的精确引文也必须在前 800 个字符内，并且不得晚于两类边界证据；边界句不能替代文章主命题。

前四项的精确正文引文必须出现在正文前 800 个字符内。所有引文都必须逐字存在于当前正文且不少于 8 个字符，六项冷读回答也各不少于 8 个字符；不接受词级命中、关键词布尔值、相似度分数或模型自述替代。

## 登记数据

`metadata.publicationVersion.semanticGate` 使用 `wenmai.article-publication-semantic-gate/1.2.0`。以下示例只展示结构，摘要和引文必须来自实际正文：

```json
{
  "schemaVersion": "wenmai.article-publication-semantic-gate/1.2.0",
  "bodySha256": "<current-body-sha256>",
  "primaryThesis": "<non-empty positive main thesis text>",
  "primaryThesisSha256": "<sha256 of UTF-8 primaryThesis source text>",
  "primaryThesisEvidenceQuote": "<exact lead quote that states the primary thesis>",
  "primaryThesisRegion": "lead",
  "contract": {
    "items": [
      {
        "id": "author_entry",
        "evidenceQuote": "<exact quote from current body>",
        "evidenceRef": "body:lead:author-entry",
        "region": "lead"
      }
    ]
  },
  "contractSha256": "<deterministic hash of primaryThesis identity and all seven items>",
  "canonicalContractSha256": "<platform variants only: current canonical contract hash>",
  "canonicalPrimaryThesisSha256": "<platform variants only: current canonical primaryThesisSha256>",
  "independentReaderEvidence": {
    "recordedBy": "coordinator_recorded",
    "snapshotSha256": "<current-body-sha256>",
    "reviewerId": "<stable reviewer id>",
    "reviewedAt": "2026-09-16T00:00:00.000Z",
    "verdict": "pass",
    "answers": {
      "author_entry": "<what the reader understood>",
      "problem_origin": "<what the reader understood>",
      "first_term_explanation": "<what the reader understood>",
      "reading_route": "<what the reader understood>",
      "primary_thesis": "<the positive main thesis the reader can repeat>",
      "boundary_relation": "<how evidence and responsibility boundaries relate to the main thesis>"
    }
  }
}
```

`bodySha256` 与 `independentReaderEvidence.snapshotSha256` 都必须同时等于 Article Revision 当前正文 UTF-8 原文的实算 SHA-256；正文改变而三个登记摘要仍旧时失败关闭。`coordinator_recorded` 表示协调者记录了独立冷读证据，不表示服务端已经认证读者身份。`fail`、`inconclusive`、`stale`、缺字段、未来时间、正文摘要不符、主命题或核心命题位置错误、引文不在正文、canonical 合同或主命题摘要绑定不符，都会失败关闭。

## 生命周期

- `register_publication_version`：使用数据库中的当前正文复验 gate。canonical 与平台版都必须通过；平台版的 `canonicalPrimaryThesisSha256` 及自身 `primaryThesisSha256` 都必须精确等于当前 canonical 的 `primaryThesisSha256`。
- 历史记录：缺 gate 时仍可读取，状态为 `semantic_gate_missing`；`1.1.0` 及更早 schema 只按 `unverified` 历史数据读取。两类记录都不能用于新的登记或 Build。
- 重新签发：旧记录必须从当前 Article Revision 正文重新实算 `bodySha256`，按当前 canonical 正面主命题重新生成 `primaryThesisSha256`、精确引文、七项合同和独立冷读快照，再以 `1.2.0` 重新登记；不得原地把 schema 字符串改成新版本。
- `create_build`：再次从已登记 JSON 和当前正文读回复验。正文、canonical、合同或冷读快照任一变化，旧 gate 都不能继续使用。
- 技术检查、格式检查、字数检查、导入成功、自动保存和发布回执均不能替代这项门禁。

门禁只证明当前正文与当前语义证据的绑定关系；它不证明外部事实已经重新联网核验，也不证明平台提交、后台记录或公开可见。
