# 投稿追踪 Manuscript Tracker

[English](README.md) | **简体中文**

> [!NOTE]
> 本项目由 [Claude Code](https://claude.com/claude-code) 生成，已经过人工验证和测试，仅用于教学目的。欢迎反馈：请[提交 issue](https://github.com/hanjiang98/AI_toy/issues)。

**在线使用：** https://hanjiang98.github.io/AI_toy/manuscript-tracker/

一个帮助科研人员记录期刊投稿的小网页。粘贴期刊系统发来的邮件（投稿成功、状态更新或审稿决定），页面会自动提取期刊、稿件编号、题目、日期、状态和修改截止日期。同一篇稿件的后续邮件会追加到它的时间线中。界面支持中文和英文。

## 功能

- 识别来自 IEEE（ScholarOne / Research Exchange）、Elsevier（Editorial Manager）和 Nature 系列（Springer Nature）的邮件。保存前可以核对识别结果。
- 自动把后续邮件归入对应稿件，支持 `.R1`、`R1`、`A` 等修改稿编号。
- 可按进行中、待修改、已录用、已结束筛选，显示投稿天数和修改截止倒计时。
- 支持 JSON 备份与导入，也可导出 CSV 用 Excel 打开。
- 可选：通过自己的 GitHub 账号在多台设备间同步。

## 隐私

- 每位访问者都有自己独立的列表，其他人（包括本页面作者）都看不到您的记录。
- 记录保存在您的浏览器中（`localStorage`）。没有服务器、没有统计分析，也没有第三方脚本。
- 邮件在浏览器本地由 [parser.js](parser.js) 解析。
- 不开启 GitHub 同步时，记录只保存在创建它的浏览器里，清除网站数据会丢失记录。请不时导出备份。

## 通过 GitHub 跨设备同步（可选）

记录可以保存在**您自己 GitHub 账号下的私有仓库**中。页面直接与 `api.github.com` 通信，不经过其他服务器，其他人也无法访问。

1. [创建一个私有仓库](https://github.com/new?name=manuscript-tracker-data&visibility=private)，例如 `manuscript-tracker-data`。
2. [创建细粒度个人访问令牌（fine-grained token）](https://github.com/settings/personal-access-tokens/new?name=Manuscript%20Tracker&contents=write&expires_in=365)：
   - **Repository access**：选择 *Only select repositories*，并选中第 1 步创建的仓库。
   - **Permissions**：把 *Contents* 设为 *Read and write*，其他权限都不需要。
3. 在页面上点击 **GitHub 同步**，填写仓库名并粘贴令牌。
4. 在其他设备上用同一个仓库重复第 3 步。令牌可以复用，也可以为每台设备单独创建。

页面只会往这个仓库写入一个文件 `manuscripts.json`。每次修改后、打开页面时以及切回标签页时都会自动同步。两台设备修改同一篇稿件时，以最近一次修改为准；删除的稿件在所有设备上都会被删除。

**安全说明**

- 页面拒绝同步到公开仓库。
- 令牌只保存在当前浏览器中。如果取消勾选“在此设备上记住”，则只在本次会话中有效。能使用您浏览器配置文件的人可以读取它，因此请只给令牌这一个仓库的权限并设置有效期。设备丢失时请[撤销令牌](https://github.com/settings/personal-access-tokens)。
- 页面设置了内容安全策略（CSP），只允许连接 `api.github.com`。
- 没有使用 GitHub OAuth 登录（“用 GitHub 登录”），因为它需要后端服务器保存客户端密钥，而本项目刻意不设服务器。

## 本地运行

下载 `manuscript-tracker` 文件夹，用浏览器打开 `index.html` 即可，无需安装或构建。从本地文件打开时也可以使用 GitHub 同步。

## 项目结构

| 文件 | 作用 |
|---|---|
| `index.html`、`styles.css` | 页面与样式 |
| `app.js` | 界面、存储与同步逻辑 |
| `i18n.js` | 中英文文本 |
| `parser.js` | 邮件解析（不依赖 DOM） |
| `github-sync.js` | GitHub REST 客户端、合并逻辑与同步器 |
| `tests/parser-test.html` | 解析器测试 |
| `tests/sync-test.html` | 合并与同步测试（使用模拟的 GitHub API） |
| `build-artifact.sh` | 可选：把页面打包成单个文件，用于发布为 claude.ai artifact |

## 测试

用浏览器打开 `tests/parser-test.html` 和 `tests/sync-test.html`。页面会列出每个测试用例，最后一行显示汇总，例如 `18/18 passed`。

## 参与贡献

欢迎提交 issue 和 pull request，尤其欢迎报告解析出错的邮件。

- **贴邮件之前，请删除姓名、邮箱地址、稿件题目和编号。**
- 修改 `parser.js` 时，请在 `tests/parser-test.html` 中补充测试用例。
- 保持项目零依赖：只用 HTML、CSS 和 JavaScript，不需要构建步骤。

## 许可证

[MIT](../LICENSE)。按“原样”提供，不作任何担保。请勿把本工具作为投稿记录的唯一来源。
