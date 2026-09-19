#!/usr/bin/env python3
"""把 BidClub 最新英文单集落成 Obsidian 播客选品候选 md。

用途：播客选品看板的数据同步层。被「BidClub 每日播客更新日报」自动化调用，
也支持手动运行做种子导入。

用法：
  python sync_bidclub_picks.py [--days 3] [--limit 30] [--out DIR] [--no-translate]

行为：
  1. 调 bidclub.ai REST API 拿最新英文单集（lang=EN）
  2. 按 slug 去重（目标目录已存在含该 slug 的 md 则跳过）
  3. 对每条拉取中文 dek_alt / title_alt（除非 --no-translate）
  4. 落盘 {date}-{slug}.md，frontmatter 带结构化字段，供 Obsidian Bases 筛选流转

退出码：0 成功（含"无新增"）；非 0 抓取失败。
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.request
import urllib.parse

API_LIST = "https://bidclub.ai/api/v1/episodes"
API_EP = "https://bidclub.ai/api/v1/episodes/{}"
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"}

DEFAULT_OUT = os.environ.get(
    "PODCAST_PICKS_DIR",
    os.path.join(os.getcwd(), "output", "podcast-picks"),
)


def http_json(url, timeout=25):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def yaml_str(v):
    """把任意字符串安全地序列化成 YAML 双引号标量。"""
    if v is None:
        return '""'
    s = str(v).replace("\\", "\\\\").replace('"', "'")
    s = re.sub(r"[\r\n\t]+", " ", s).strip()
    return '"' + s + '"'


# ISO 日期/时间：不加引号，让 Obsidian 识别为 Date 类型。
# 必须与 Obsidian 自身规范化 frontmatter 的行为一致——否则同一属性会
# 出现「部分字符串、部分日期」的混合类型，导致 Bases 的 groupBy/sort 不可靠。
_ISO_DT = re.compile(
    r"^\d{4}-\d{2}-\d{2}"
    r"(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$"
)


def yaml_date(v):
    """ISO 日期/时间原样输出（不加引号）；非 ISO 值退回带引号字符串。"""
    s = str(v or "").strip()
    return s if _ISO_DT.match(s) else yaml_str(s)


def slug_to_filename(date, slug):
    return f"{date}-{slug}.md"


def make_workbuddy_transcribe_url(channel, title, guest, url):
    cwd = "/Users/clawbot/workbuddy-ai/po d"
    prompt = f"""请在 po d 空间使用 podcast-to-wechat-workflow 对以下播客进行转录与深度改写：

【单集信息】
- 播客频道：{channel}
- 播客标题：{title}
- 嘉宾：{guest}
- 源链接：{url}

【转录与成稿要求】
1. 启动 podcast-to-wechat-workflow 播客转录流程（若 BidClub 已收录逐字稿则直接获取，否则下载音频/调用 ASR 进行精准转录）；
2. 全面提取核心论点、论据与金句，保留全部事实细节与专业术语，严禁缩水删减；
3. 执行高质量问答式与深度叙事改写，过滤口语废话与口头禅，保持人物真实语感与表达生动性；
4. 结尾信息规范：附带完整的单集信息（遵守单一「- 翻译自：{channel}《{title}》」与原文链接规范）；
5. 产出成稿沉淀到知识库，并准备启动排版工作台。"""
    params = {
        "action": "start",
        "cwd": cwd,
        "prompt": prompt,
    }
    encoded = urllib.parse.urlencode(params, quote_via=lambda s, safe="", encoding=None, errors=None: urllib.parse.quote(s, safe=""))
    return f"workbuddy-ai://task?{encoded}"


def build_md(ep, out_dir):
    channel = (ep.get("shows") or {}).get("name", "")
    title = ep.get("title") or ""
    title_zh = ep.get("title_alt") or ""
    guest = ep.get("title_orig") or ""
    published_at = ep.get("published_at") or ""
    date = (published_at[:10] if published_at else (ep.get("date") or "1970-01-01"))
    duration = ep.get("duration_min") or 0
    slug = ep.get("slug") or ""
    url = ep.get("source_url") or ep.get("youtube_url") or ""
    dek = ep.get("dek") or ""
    dek_zh = ep.get("dek_alt") or ""
    # 核心观点：中文 bullet 列表（每条为「**结论** + 解释」）
    key_points_zh = (ep.get("tldr_md_alt") or "").strip()
    thumb = ep.get("thumbnail_url") or ""

    heading = title_zh or title
    # 唯一真源：frontmatter 与正文「当前状态」都读这个变量，避免两处不一致
    pick_status = "candidate"
    wb_url = make_workbuddy_transcribe_url(channel, heading, guest, url)

    body = [
        "---",
        f"channel: {yaml_str(channel)}",
        f"title: {yaml_str(title)}",
        f"title_zh: {yaml_str(title_zh)}",
        f"tldr_zh: {yaml_str(dek_zh)}",
        f"guest: {yaml_str(guest)}",
        f"published_at: {yaml_date(published_at)}",
        f"date: {yaml_date(date)}",
        f"duration_min: {duration}",
        "source: bidclub",
        f"slug: {yaml_str(slug)}",
        f"url: {yaml_str(url)}",
        f"thumbnail_url: {yaml_str(thumb)}",
        f"pick_status: {pick_status}",
        "priority: 3",
        "transcript: true",
        'article: ""',
        "---",
        "",
        f"# {heading}",
        "",
        f"> **{channel}** ｜ 嘉宾：{guest} ｜ 时长 {duration} 分钟 ｜ 播出 {published_at}",
        "",
        "> [!tip]- 🎬 杂志短视频切片工坊（点击按需展开制作）",
        "> 选好播客后，可在此直接展开制作 3:4 杂志短视频（暖奶油/墨绿刊印风）。成片自动沉淀至 `output/videos/`。",
        "> ",
        f'> <iframe src="http://127.0.0.1:8787/?auto=1&url={urllib.parse.quote(url, safe="")}" width="100%" height="820px" style="border-radius: 8px; border: 1px solid var(--background-modifier-border); box-shadow: 0 4px 16px rgba(0,0,0,0.06); background: var(--background-primary);"></iframe>',
        "> ",
        "> _也可点击笔记顶部状态栏右侧的「🎬 制作短视频」按钮随时唤出/收起，或打开：[[magazine-studio|🎬 独立全屏工作台]]。_",
        "",
        "> [!action] 🎙️ 决定制作本集？一键发起转录",
        f"> - **一键流转**：[🚀 **跳转 WorkBuddy 发起转录（po d 空间）**]({wb_url})",
        "> _点击后将自动唤出 WorkBuddy 切换到 `po d` 空间，并将本集标题、原链接与全套专业转录改写规范自动预填至输入框。也可点击笔记顶部状态栏右侧的 **「🎙️ WorkBuddy 转录」** 按钮一键直达。_",
        "",
        "## 一句话摘要",
        "",
        dek_zh if dek_zh else "（中文摘要待补）",
        "",
        "## 核心观点",
        "",
        key_points_zh if key_points_zh else "（核心观点待补）",
        "",
        "## 英文原文",
        "",
        dek,
        "",
        "## 状态",
        "",
        f"当前状态：`{pick_status}`",
        "",
        "> 以下为状态流转图例（说明可选值，**不代表本卡当前状态**）：",
        ">",
        "> `candidate`（候选）→ `selected`（已选）→ `transcribed`（已转录）→ `published`（已发公众号）",
        "",
        "- 转录稿：✅ BidClub 已收录，可用 `get_episode(section=transcript)` 直取",
        '- 公众号文章：（发布后回填 frontmatter 的 `article`）',
        "",
        "## 链接",
        "",
        f"- 源：{url}",
        "",
    ]
    path = os.path.join(out_dir, slug_to_filename(date, slug))
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(body))
    return path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=3, help="只落 published_at 在最近 N 天内的单集")
    ap.add_argument("--limit", type=int, default=40, help="从 API 拉取的单集条数")
    ap.add_argument("--out", default=DEFAULT_OUT, help="候选池目录")
    ap.add_argument("--no-translate", action="store_true", help="不拉中文 dek_alt/title_alt")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)

    try:
        listing = http_json(f"{API_LIST}?lang=EN&limit={args.limit}")
        episodes = listing.get("episodes", [])
    except Exception as e:
        print(f"[sync_bidclub_picks] 列表抓取失败: {type(e).__name__}: {e}", file=sys.stderr)
        return 2

    if not episodes:
        print("[sync_bidclub_picks] 无单集返回")
        return 0

    existing = set(os.listdir(args.out))
    created, skipped, failed = 0, 0, 0

    # 日期过滤：只落最近 N 天内的单集
    import datetime as _dt
    try:
        _now = _dt.datetime.now(_dt.timezone.utc)
        _cutoff = _now - _dt.timedelta(days=args.days)
    except Exception:
        _cutoff = None

    for ep in episodes:
        slug = ep.get("slug")
        date = (ep.get("published_at") or "")[:10]
        if not slug or not date:
            continue
        if _cutoff is not None and args.days > 0:
            try:
                _pub = _dt.datetime.fromisoformat(ep["published_at"].replace("Z", "+00:00"))
                if _pub < _cutoff:
                    skipped += 1
                    continue
            except Exception:
                pass
        fname = slug_to_filename(date, slug)
        if fname in existing:
            skipped += 1
            continue

        # 拉中文版
        if not args.no_translate:
            try:
                detail = http_json(API_EP.format(slug))
                ep["dek_alt"] = detail.get("dek_alt") or ""
                ep["title_alt"] = detail.get("title_alt") or ""
                # 核心观点（中文 bullet 列表）与封面图；列表接口不返回，只能从详情取
                ep["tldr_md_alt"] = detail.get("tldr_md_alt") or ""
                ep["thumbnail_url"] = detail.get("thumbnail_url") or ""
            except Exception:
                pass  # 中文失败不致命，保留英文
            time.sleep(0.15)

        try:
            build_md(ep, args.out)
            created += 1
        except Exception as e:
            print(f"[sync_bidclub_picks] 落盘失败 {slug}: {e}", file=sys.stderr)
            failed += 1

    print(f"[sync_bidclub_picks] 完成：新增 {created} / 跳过 {skipped} / 失败 {failed}，目录 {args.out}")
    return 0 if failed == 0 else 3


if __name__ == "__main__":
    sys.exit(main())
