# 架构与信任边界

[English](architecture.en.md) · [首页](../README.md)

## 组件

`app/` 是 Vinext/Vite UI 与路由；`worker/` 是 Cloudflare Worker 入口并加入安全响应头；`db/` 用 Drizzle 建模 Cloudflare D1 绑定。`npm run dev` 在固定 `http://[::1]:3000` 启动。

数据模型包含文章、分支、修订、工作项、Agent 运行、Runner 租约、命令回执、合并提案、发布能力及消费记录。记录存在本身不证明外部动作已完成。

```text
浏览器/UI -> 本机 API 与工作台 -> D1
                              -> Agent Gateway / MCP / Runner
                              -> Model Gateway（仅明确动作）
                              -> 平台准备（默认人工且未连接）
```

各层只能转发自身已验证的输入，并在边界核验身份、范围、工件摘要、有效期与回执。下游输出是待验证证据，不是自动授权。

## Agent、Runner 与模型

Agent Gateway 协调受限的本地 Agent 流程，不会替 Agent 选择或调用模型。MCP 的资源和工具受 token、范围与文章边界限制。Runner 只执行已登记、带租约和回执的本机步骤，不能把任意文本当命令。

Model Gateway 使用确定性路由，且不会自主触发：明确受控动作才会向已配置固定 Provider 发送有界输入并接收结构化候选。哈希、schema、固定格式检查由代码完成；只有冻结输入、明确输出合同的低风险候选任务可使用该 Provider；含糊判断、内容改写、高风险动作与完成声明留给协调者。Provider 的秘密、配置和连通性属于运行环境，代码合同不是可用性证明。

## 候选、审批、合并与发布

文章工作者可提出候选或补丁，但候选不等于批准。审批、合并准备/执行和发布能力消费必须分离，并有各自身份、范围和回执。`prepare` 停在提交前；平台目标默认 `manual` / `not_connected`，不能推断自动提交或公开状态。

## 数据边界

D1 是工作状态的一部分。代码、迁移、数据库备份与导入来源应分开保存和核验。先在可恢复副本演练迁移、记录输入版本与结果，再改变目标数据库；见[运维](operations.md)。固定 loopback origin 不是身份系统，不能替代网络隔离与秘密管理。
