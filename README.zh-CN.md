# pi 扩展

[English](README.md) | [简体中文](README.zh-CN.md)

本目录包含 [pi](https://github.com/earendil-works/pi-coding-agent) 的官方扩展。每个扩展是一个独立包，通过 pi 的 `ExtensionAPI` 挂载附加功能。

## 2.0.0 系列发布（2026-08-25）

子代理生态的一次协调大版本更新：

- **[@fyeeme/pi-subagents 2.0.0](./pi-subagents)** —— 扇出引擎首次发布 npm（subagent 工具、调度核心、实时代理 UI、工作流提示词预设）；使用方通过版本固定的 npm 依赖组合其扩展工厂。
- **[@fyeeme/pi-review 2.0.0](./pi-review)** —— 三明治重构：方法论技能 + 数据化编排提示词 + 12 个内置 finder/cleaner/verifier 代理，组合 pi-subagents 使用。
- **[@fyeeme/pi-ask-user 2.0.0](./pi-ask-user)** —— 首次发布 npm：oh-my-pi 的分页 `ask` 对话迁移到 pi 扩展 API。

pi-review 不依赖 npm 包 pi-subagents —— 需要扇出时请单独安装；未安装时，扇出档位降级为单遍审查。

## 扩展列表

| 包 | 说明 |
|---|---|
| [pi-ask-user](./pi-ask-user) | oh-my-pi 的 `ask` 工具迁移为 pi 扩展 —— 分页 ask 对话（复核页、备注、Markdown/代码预览、超时倒计时）、旧版逐问题选择路径与 omp 结果语义的源码级移植 |
| [pi-goal](./pi-goal) | 基于 mitsuhiko/agent-stuff goal.ts 重写的 goal 模式 —— 会话日志持久化的长时目标，含 `get_goal`/`create_goal`/`update_goal` 三工具、`/goal` 命令、2M 默认 token 预算记账、自动续跑回合，以及严格的完成/受阻审计 |
| [pi-mermaid-viewer](./pi-mermaid-viewer) | 把会话中的 Mermaid 图渲染为 HTML 页面并在默认浏览器打开 |
| [pi-notify](./pi-notify) | 桌面通知，重写自 mitsuhiko/agent-stuff `notify.ts` —— `agent_end` 时发 OSC 777 通知，正文取最后一条助手消息（纯文本化 markdown、去终端序列、截断 200 字符） |
| [pi-subagents](./pi-subagents) | 通用 `subagent` 工具（单发/并行/链式），三源代理发现、共享调度核心与实时代理 UI |
| [pi-review](./pi-review) | 审查与清理资产 —— 声明式提示词模板之上的 `/review` 与 `/simplify` 调度器，附方法论技能与 finder/cleaner 代理定义 |
| [pi-serena-hooks](./pi-serena-hooks) | Serena 桥接 —— 把 pi 扩展事件接线到 `serena-hooks` CLI（`activate` / `remind` / `cleanup`），引导代理优先使用 Serena 符号工具，阻断裸 read/grep 连发 |
| [pi-session-name](./pi-session-name) | 用 LLM 生成短标题自动命名会话，便于 `pi --resume` 列表扫读 |
| [pi-statusline](./pi-statusline) | 富自定义状态栏，替换默认页脚 |
| [pi-todo](./pi-todo) | 文件式 todo，重写自 mitsuhiko/agent-stuff `todos.ts` —— `todo` 工具（`list`/`list-all`/`get`/`create`/`update`/`append`/`delete`/`claim`/`release`）作用于 `.pi/todos` 下的 markdown 文件，带每条 todo 锁、`settings.json` 垃圾回收配置，以及 `/todos` 交互管理器 |
| [pi-virtual-model](./pi-virtual-model) | 虚拟模型路由 —— `glm-5.3-auto` 按请求是否含图片，在 `glm-5.3` 与 `glm-5.3-flash` 之间切换；时钟切换：工作日北京时间 14:00–18:00 用 `glm-5.3-flash`，其余时间用 `glm-5.3-auto` |
| [sessions-web](./sessions-web) | 本地会话历史的只读 Web 查看器 —— `/session-web` 在 `127.0.0.1` 上提供服务，数据来自 `~/.pi/agent/sessions/` |

## 安装

从 npm 安装（推荐）：

```bash
# 全局（用户级）安装 —— 所有项目可用
pi install npm:@fyeeme/<name>

# 项目级安装 —— 写入 .pi/settings.json
pi install -l npm:@fyeeme/<name>

# 单次试用，不写入配置
pi -e npm:@fyeeme/<name>
```

其他包管理命令：`pi list` 查看已配置的包，`pi remove <source>` 移除一个包，`pi update --extensions` 对齐安装状态。

手动安装：把包复制到 `~/.pi/agent/extensions/`（全局）或 `.pi/extensions/`（按项目）。具体步骤见各扩展的 README。
