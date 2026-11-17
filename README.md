# 标准公告资料库

Node.js 本地数据接入项目。已有一次来源读取、结构化导入与操作查询，来源服务和业务存储独立，来源变化不会自动刷新本地集合。公告、正式文件版本与提醒依据已关联：公告先入目录，文件完整下载且 sha256 校验通过才成为可用版本，提醒只依据可用版本。

## 运行

需要 Node.js 22，无第三方包、远程服务或账户凭据。`npm test` 运行现有行为与本地接口测试；`npm run demo` 启动临时来源，按 opening → updated → ready 三个阶段演示公告入目录、文件校验、替代关系与提醒依据，结束时自动关闭监听并清理临时数据，通常两秒内完成。`npm start -- ingest` 从 `fixtures/records.json` 导入，`npm start -- query` 读取本地 `var/records.json`。演示数据不访问生产站点。

## 组件和数据

`source/server.js` 读取 `fixtures/source.json` 并监听随机回环端口。`startSource()` 返回 url、publish(stage)、failNext(path,status) 和 close()；publish 切换可观察来源版本而不修改业务仓库，failNext 可返回 503 或使用 disconnect 断开连接。它记录请求路径并支持来源 ETag/304。`src/source-client.js` 只接受同一回环来源；`src/adapter.js` 解析现有首批页面并保留原始来源属性，返回 records 和 next；目前 demo 只导入首批。`src/service.js` 与 `src/repository.js` 维护持久集合；`src/operations.js` 是读取该集合的业务消费入口，来源协议见 [CONTRACT.md](CONTRACT.md)。

采集生命周期由 `src/versions.js`（公告目录、版本状态、替代关系、提醒决策）、`src/documents.js`（文件下载与 sha256 校验）和 `src/library.js`（编排与派生状态持久化，写入 `var/library.json`）承担。公告入目录即登记版本（待文件 pending-file）；文件完整且校验通过后转为可用（usable）；勘误公告的 replaces 会把旧版标记为已被明确替代，旧文件不再作为最新标准提醒。每次提醒都记录引用的文件、摘要与校验时间，可经通知历史查询。

状态目录属于运行产物。扩展导入时应保留现有 CLI 和现有集合查询能力；新增状态可以另行组织。测试可直接使用随机端口来源，不需要等待真实时间或接入外网。运行录制可用 test 和 demo，无需安装浏览器或外部数据库。

`npm start` 或 `npm start -- --help` 查看命令。除原有 ingest、query 外：`collect <来源URL>` 读取公告并入目录、采集校验待文件版本；`status` 输出检索视图（公告、可用版本、替代关系、提醒依据）；`notify` 依据可用版本生成提醒；`notifications` 查询先前提醒引用过的文件。`npm run acceptance` 在临时目录中验证本地来源读取、首批导入、重启回读、重放、业务查询以及公告→校验→提醒的完整生命周期，完成后清理临时状态。
