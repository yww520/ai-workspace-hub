# 知识阅读台 (Skywork Reading Hub) - Obsidian Plugin

专为 Skywork 及 AI Workspace Hub 打造的交互式阅读台增强插件：

- **5 列大图卡片并排视图**：在 Obsidian Bases 的 `srh-fold` 折叠分组视图中，按 5 列自适应网格展示 16:9 封面缩略图、标题、频道、时长与 TL;DR 摘要。
- **正文顶部状态栏快速操作**：
  - 🟢 **WorkBuddy 转录**：一键将笔记推进至「已选」状态并呼起 WorkBuddy 在 `po d` 空间执行 `podcast-to-wechat-workflow` 深度转录。
  - 🔴 **制作短视频**：一键调用本地 3:4 杂志短视频工坊（`http://127.0.0.1:8787`）。
  - 🟣 **AI 总结**：一键唤起智能总结。
- **全功能划线批注**：选中文字弹出浮动工具栏，支持多色高亮、想法便签记录、金句引用复制与 AI 词句解释。
- **阅读状态实时流转**：支持未读 / 已读 / 精读 / 跳过等状态一键写入 Frontmatter。

## 安装方式

将本目录下的 `manifest.json`、`main.js`、`styles.css` 复制到您的 Obsidian 仓库目录 `.obsidian/plugins/skywork-reading-hub/` 即可。
