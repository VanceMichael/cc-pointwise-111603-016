# 来源与消费契约

## 来源

入口 `/standards/notices`，HTML 内的 source-record JSON 节点保留了门户输出字段；rel=next 链接表示下一页。`fixtures/source.json` 的 opening 与 updated 是两个可切换的来源观察，不代表业务库必须得出某个预设结论；可添加新的来源观察验证行为。

standardId 为标准号，documentVersion 为来源文件版本；公告时间不是附件可用时间。文件可暂缺，替代声明在新文件可用前仍需展示，旧提醒的文件版本与依据应可解释。通知消费状态在 fixtures/notifications.json，检索与提醒读取相同的有效文件事实。

## 业务消费

`readOperations(repository)` 返回 product 和 rows，每行带 sourceId/source/observedAt/attributes。传入派生状态（`readOperations(repository, libraryState)`）时附加 standards 检索视图：每个标准给出最新公告及其文件状态、最近可用版本、逐版本的替代关系（replaces/replacedBy）、当前提醒依据与文字说明。已被明确替代的旧文件标记 replaced，不作为最新标准通知；待文件版本给出原因（未上传、摘要未知、摘要不一致、来源故障等），继续采集即可重试。

提醒只依据校验通过的可用版本生成，提醒记录包含引用的文件、sha256 与校验时间，通知消费状态与提醒日志持久化在派生状态中，可查询先前提醒引用过的文件。现有 CLI 和结构化导入用于本地运维；新增采集结果也需要让业务读取入口看到一致状态，必要的解释信息可扩展返回。原始来源身份与 observedAt 不是通用的业务版本、完整性或成功证明。来源接口契约是兼容边界，采集、状态管理和新业务表达由实现决定。
