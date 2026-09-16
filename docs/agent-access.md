# Agent、MCP、Runner 与 Model Gateway

[English](agent-access.en.md) · [首页](../README.md)

## 三类本机角色钥匙

- `content-steward`：全库只读盘点；仅可 create/update/cancel task，不能产出候选，也不能替代审批或发布授权。
- `article-worker`：可在全库范围工作，但必须绑定既有任务，且只提交候选，不能审批、合并或发布。
- `local-registrar`：仅在 `http://[::1]:3000` 注册新根文章；不能列举、读取正文或覆盖已有文章，只能凭精确 `articleId` 与 `bodySha` 读回有界状态。

角色钥匙应短期、最小范围、可撤销，并绑定固定 loopback origin。不得把候选角色与审批、合并或发布能力混在同一钥匙中。特权角色的范围必须与代码中的精确合同匹配。

## Agent Gateway 与 MCP

Agent Gateway 是本地协调入口，负责将身份、范围和任务边界传递给受控操作；它不授予新权限，也不自行调用模型。MCP 使用 token、scope 与文章边界进行校验。调用方必须保存请求与回执，失败或不确定状态不能被重试逻辑伪装成成功。

## Runner

Runner 只执行已登记的本机步骤。每次执行应关联租约、输入摘要、允许命令和回执；不要以自然语言、网页内容或 Agent 输出直接拼接 shell 命令。Runner 的本机成功也不能推导外部平台状态。

## Model Gateway

Model Gateway 不会自主触发。明确受控动作会按固定 Provider 合同向已配置 Provider 发送有界输入，并接收结构化候选；Provider 名称、路由代码或环境变量模板都不代表真实 Provider 已连通。确定性检查留在代码中。只有冻结输入、固定 schema、低风险、候选式的中间任务才可交给已配置 Provider；含糊判断、内容改写、高风险动作与完成声明交给协调者。

## 外部动作

平台默认 `manual` / `not_connected`。发布准备、提交接受、目标读回和公开可见是不同状态。执行外部提交前需要当前批次明确人工授权、一次性能力、单次消费与后续读回；不明结果先只读探测，不能自动二次提交。
