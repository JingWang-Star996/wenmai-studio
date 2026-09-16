# 快速开始与日常流程

[English](getting-started.en.md) · [首页](../README.md)

## 安装与启动

准备 Node.js `>=22.13`，在仓库根目录执行：

```sh
npm ci
npm run dev
```

打开 `http://[::1]:3000`。若应用报告 D1 `DB` binding 不可用，先检查本机开发配置是否提供该绑定；不要用示例密钥或外部端点绕过错误。

首次在干净副本中运行 `dev`、`build` 或 `start` 时，文脉会从 `data/*.example.json` 生成只含一篇合成演示文章的本地索引。生成操作只补齐不存在的 `*.generated.json`，不会覆盖你已有的文章索引或能力清单。也可以单独运行 `npm run data:bootstrap` 检查这一过程。

## 日常编辑循环

1. 新建或选择文章项目，并确认当前分支与工作项。
2. 将修改作为候选、修订或补丁记录；保留输入、工件摘要与审阅依据。
3. 由独立的审批步骤决定是否接纳候选，再执行受控的合并步骤。
4. 用 `npm run lint` 和相关主题测试检查改动；需要公开完整回归时运行 `npm run test:public`（`npm test` 等同该组合）。
5. 发布仅能作为人工准备流程：核验目标仍为 `manual` / `not_connected`，并停在提交前，除非另有当前批次的明确授权与回执链。

## 构建与运行

```sh
npm run build
npm run start
```

开发时使用 `npm run dev`；不要假设生产绑定、Provider 或外部平台已配置。配置、秘密和可用性必须由当前运行环境独立验证。

## 测试选择

`package.json` 列出按领域拆分的 `test:*` 脚本，例如 Agent 访问、模型路由、Runner、MCP、导入和平台目标。运行与所改范围匹配的脚本；在准备整合时运行 `npm run test:public`（`npm test` 等同）。测试通过只证明该检查覆盖的合同，不证明外部服务、登录或发布结果。

## 下一步

阅读[架构](architecture.md)理解信任边界；需要自动化候选工作时阅读[Agent 接入](agent-access.md)；维护数据时阅读[运维](operations.md)。
