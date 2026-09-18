---
channel: 节目名
title: 期名
guest: 嘉宾
published_at: 2026-09-01T00:00:00+00:00
duration_min: 60
source: bidclub
slug: bidclub-slug
url: https://
pick_status: candidate
priority: 3
transcript: true
article: ""
---

# {{title}}

> **{{channel}}** ｜ 嘉宾：{{guest}} ｜ 时长 {{duration_min}} 分钟 ｜ 播出 {{published_at}}

> [!tip]- 🎬 杂志短视频切片工坊（点击按需展开制作）
> 选好播客后，可在此直接展开制作 3:4 杂志短视频（暖奶油/墨绿刊印风）。成片自动沉淀至 `output/videos/`。
> 
> <iframe src="http://127.0.0.1:8787/?auto=1&url={{url_encoded}}" width="100%" height="820px" style="border-radius: 8px; border: 1px solid var(--background-modifier-border); box-shadow: 0 4px 16px rgba(0,0,0,0.06); background: var(--background-primary);"></iframe>
> 
> _也可点击笔记顶部状态栏右侧的「🎬 制作短视频」按钮随时唤出/收起，或打开：[[magazine-studio|🎬 独立全屏工作台]]。_

## 一句话摘要

{{英文 dek 原文 + 中文精炼}}

## 为什么值得听（选品理由）

{{命中什么主题 / 谁说的 / 为什么重要}}

## 状态

当前状态：`{{取 frontmatter 的 pick_status，新建默认 candidate}}`

> 以下为状态流转图例（说明可选值，**不代表本卡当前状态**）：
>
> `candidate`（候选）→ `selected`（已选，准备转录）→ `transcribed`（已转录）→ `published`（已发公众号）

- 转录稿：{{BidClub 已收录则 true，可用 get_episode(section=transcript) 直取；否则走 pod2wechat RSS/Whisper}}
- 公众号文章：{{发布后回填 article 字段}}

## 链接

- 源：{{url}}
