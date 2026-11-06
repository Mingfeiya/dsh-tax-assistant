# 智税助手（DSH 插件）

在 DeepSeek Harness 左侧栏增加一个「智税助手」入口：登录业务系统账号后，在面板里与 AI 助手对话，顶部可切换四个助手。

- 客服智能体（`analysis-agent`）、业务处理 AI（`business-agent`）、税务问答 AI（`tax-qa-agent`）——走 Java Agent 接口
- 通用业务助手（`enterprise-agent`）——走 Python 服务，SSE 流式输出、生成文件可下载

## 安装

从 Git 仓库直接安装（仓库根目录就是本包）：

```bash
dsh plugin add git+https://github.com/<你的账号>/dsh-tax-assistant.git
```

或在 Harness 里打开 **插件 → 添加插件**，在输入框里粘贴同一个 Git 地址，点 **安装**，然后刷新页面。

如果这个包已经发布到 npm，也可以只填包名：

```bash
dsh plugin add dsh-tax-assistant
```

> 升级方式：先在插件列表里卸载，再重新安装一次（Git 来源的插件不走增量更新）。

## 首次使用

1. 左侧栏点「智税助手」，面板显示登录卡片。
2. 输入业务系统账号密码登录（登录请求由 Harness 进程转发到登录地址，返回的 token 保存在 Host 侧，浏览器只持有一个随机会话号）。
3. 登录成功后即可对话；顶部中间的下拉框切换助手，每个助手各自记忆自己最近一次的会话。
4. 「会话」查看历史，「设置」里可以改登录地址、Java 接口地址、Python 服务地址与 entry。

## 默认配置

| 配置项 | 默认值 |
| --- | --- |
| 登录地址 | `https://taxapi.ebmtax.com:4434/api/login/` |
| Java Agent 地址 | `http://www.ebmtax.com/agent-api` |
| 默认助手 | `business-agent` |
| 通用业务助手地址 | `http://127.0.0.1:2091` |
| 通用业务助手 entry | `general` |

配置保存在面板的 localStorage 里，不写入 Harness 配置，也不上传。

## 能力

- 账号登录、按助手注册能力（菜单 + 权限），登录失效自动回到登录页
- 会话列表 / 历史消息 / 删除会话（Java 侧）
- 业务补参表单内联渲染与提交（必填校验、下拉、多选、复选、单选、远程选项）
- 写操作前的「确认并继续」卡片（`pendingActions` 确认 / 取消）
- 通用业务助手：SSE 流式输出、进度提示、生成文件（docx/xlsx/pdf）下载
- 中英双语界面，跟随 Harness 语言

## 已知限制

- Java 三个助手的接口是整段返回 JSON，因此它们是「等待 → 一次性出现」，只有通用业务助手是流式。
- 通用业务助手不支持业务补参表单与确认卡片（那是 Java 侧的能力），也不支持删除会话。
- `file` 类型的表单字段需要在业务系统里上传附件，面板内不上传文件。
- 面板不缓存确认卡片：历史会话里只能看到已归档的消息，进行中的确认需要在当前会话里完成。

## 实现说明

- `index.js`（Host）：注册 `/agent-chat/api/*` 路由，作为同源代理转发登录、聊天、历史、表单、确认、文件下载请求，并为流式回答提供 `/chat-stream` SSE 出口。
- `client.js`（Web）：向 `main` 插槽注册面板、向 `sidebar.panellist` 注册左侧栏图标，用 Harness 主题变量绘制 UI。
- 没有运行时依赖，不需要构建步骤。

## 许可

MIT
