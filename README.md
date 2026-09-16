# 文脉（Wenmai Studio）

[English](README.en.md) · [快速开始](docs/getting-started.md) · [架构](docs/architecture.md) · [运维](docs/operations.md) · [Agent 接入](docs/agent-access.md) · [贡献](CONTRIBUTING.md)

文脉是本机文章工作台，用于整理文章项目、版本、候选修改、审阅与发布准备。它由 Vinext/Vite、Cloudflare Worker 和本地 D1 数据库组成，固定 origin 为 `http://[::1]:3000`。

## 能力与边界

- 管理文章、分支、修订、工作项、候选补丁、审阅证据和发布准备记录。
- 用角色、能力范围、短期凭据和可审计回执约束 Agent；候选、审批、合并和发布相互分离。
- 提供 Agent Gateway、MCP、Runner 与 Model Gateway 的本地工作流接口。
- 平台默认 `manual` / `not_connected`，不会自动登录、发送或公开发布。
- Model Gateway 不会自主触发；明确受控动作会向已配置固定 Provider 发送有界输入并接收结构化候选。配置或代码合同不证明连通或调用成功。

## Quick Start

需要 Node.js `>=22.13`。

```sh
git clone <repository-url> wenmai-studio
cd wenmai-studio
npm ci
npm run dev
```

打开 `http://[::1]:3000`。数据库绑定和故障处理见[快速开始](docs/getting-started.md)。

## 教程索引

| 主题 | 中文 | English |
| --- | --- | --- |
| 上手、日常流程、测试 | [快速开始](docs/getting-started.md) | [Getting started](docs/getting-started.en.md) |
| 组件、信任边界与数据 | [架构](docs/architecture.md) | [Architecture](docs/architecture.en.md) |
| Agent、MCP、Runner、模型调用 | [Agent 接入](docs/agent-access.md) | [Agent access](docs/agent-access.en.md) |
| 备份、迁移、运行、恢复 | [运维](docs/operations.md) | [Operations](docs/operations.en.md) |
| 贡献约定 | [贡献](CONTRIBUTING.md) | [Contributing](CONTRIBUTING.en.md) |

## 常用命令

```sh
npm run dev
npm run build
npm run start
npm run lint
npm run test:public
```

`npm run test:public` 是公开组合测试入口；`npm test` 与它等同，可能先构建再运行多个合同测试。主题脚本见 `package.json`；修改局部时先运行对应测试，合并前运行相称的更广检查。

## 安全与限制

这是本机工作流：不要将监听地址、浏览器会话或数据库暴露到不受信任网络。Provider 端点、凭据和密钥仅放在受保护的服务端环境或本机配置中，不能进入仓库、示例或任务载荷。发布准备不等于提交接受、目标记录核验或公开可见；每个状态需要独立证据。

## 许可

仓库公开可见不等于开源授权。本版本按 [Wenmai Source-Available Notice](LICENSE) 提供，仅供审阅与评估；除非另获权利人书面许可，不授予使用、修改、部署或再分发权利。
