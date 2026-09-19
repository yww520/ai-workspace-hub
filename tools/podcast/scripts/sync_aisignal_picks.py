#!/usr/bin/env python3
"""把 ai-signal 主源（benboer/ai-signal payload）里的播客落成 Obsidian 播客选品候选 md。

与 sync_bidclub_picks.py 并行：bidclub 卡片 source=bidclub，本脚本 source=ai-signal。
去重键：① YouTube 视频 ID；② 规范化标题前缀匹配（兼容 bidclub 截断标题）。
目的：把 ai-signal 主源里、但 bidclub 还没有的播客也列入播客候选板，避免漏看。

用法：
  python sync_aisignal_picks.py [--days 14] [--out DIR] [--payload PATH] [--dry-run]

行为：
  1. 读 ai-signal payload 的 podcasts 字段
  2. 与 output/podcast-picks 下所有现有卡片去重（标题/YouTube ID 比对）
  3. 落盘 {date}-{slug}.md，frontmatter source=ai-signal，pick_status=candidate

退出码：0 成功（含"无新增"）；非 0 抓取/解析失败。
"""

import argparse
import datetime as _dt
import glob
import html
import json
import os
import re
import sys
import urllib.parse

DEFAULT_OUT = os.environ.get(
    "PODCAST_PICKS_DIR",
    os.path.join(os.getcwd(), "output", "podcast-picks"),
)
DEFAULT_PAYLOAD = os.path.expanduser("~/.ai-signal/payload/payload.json")


# ---------- YAML 序列化（与 sync_bidclub_picks.py 保持一致）----------
def yaml_str(v):
    if v is None:
        return '""'
    s = str(v).replace("\\", "\\\\").replace('"', "'")
    s = re.sub(r"[\r\n\t]+", " ", s).strip()
    return '"' + s + '"'


_ISO_DT = re.compile(
    r"^\d{4}-\d{2}-\d{2}"
    r"(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$"
)


def yaml_date(v):
    s = str(v or "").strip()
    return s if _ISO_DT.match(s) else yaml_str(s)


# ---------- 工具 ----------
def norm(s):
    if not s:
        return ""
    s = s.lower()
    s = re.sub(r"[^a-z0-9\u4e00-\u9fff]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def yt_id(u):
    if not u:
        return None
    m = re.search(r"(?:youtu\.be/|v=|/embed/|/shorts/)([A-Za-z0-9_-]{11})", u)
    return m.group(1) if m else None


def parse_duration(s):
    """'HH:MM:SS' / 'MM:SS' / 秒数(int) -> 分钟 int。"""
    if s is None:
        return 0
    if isinstance(s, (int, float)):
        return int(s // 60) if s > 1000 else int(s)
    s = str(s).strip()
    m = re.match(r"^(?:(\d+):)?(\d+):(\d+)$", s)
    if m:
        h = int(m.group(1) or 0)
        return h * 60 + int(m.group(2)) + (1 if int(m.group(3)) >= 30 else 0)
    try:
        return int(float(s) // 60)
    except Exception:
        return 0


_TAG = re.compile(r"<[^>]+>")
_ENT = re.compile(r"&(?:[a-zA-Z]+|#\d+);")


def strip_html(s, limit=400):
    if not s:
        return ""
    s = _TAG.sub(" ", s)
    s = _ENT.sub(" ", s)
    s = html.unescape(s)
    s = re.sub(r"\s+", " ", s).strip()
    if len(s) > limit:
        s = s[:limit].rstrip() + "…"
    return s


def derive_slug(e):
    link = e.get("link") or e.get("audio_url") or ""
    y = yt_id(link)
    if y:
        return "yt-" + y
    seg = link.rstrip("/").split("/")[-1]
    seg = seg.split("?")[0]
    seg = re.sub(r"[^a-zA-Z0-9\-]", "-", seg).strip("-").lower()
    if seg:
        return seg
    return "ep-" + re.sub(r"[^a-z0-9]", "-", (e.get("guid") or e.get("title") or "x").lower()).strip("-")


def slug_to_filename(date, slug):
    return f"{date}-{slug}.md"


# ---------- 去重指纹（读现有卡片）----------
def load_existing(out_dir):
    titles = set()
    yt = set()
    files = set()
    for f in glob.glob(os.path.join(out_dir, "*.md")):
        files.add(os.path.basename(f))
        txt = open(f, encoding="utf-8").read()
        mt = re.search(r"^title:\s*(.*)$", txt, re.M)
        mu = re.search(r"^url:\s*(.*)$", txt, re.M)
        if mt:
            titles.add(norm(mt.group(1).strip().strip('"')))
        if mu:
            y = yt_id(mu.group(1))
            if y:
                yt.add(y)
    return titles, yt, files


def is_dup(title, link, existing_titles, existing_yt):
    nt = norm(title)
    if not nt:
        return False
    # 1) YouTube ID 命中
    y = yt_id(link)
    if y and y in existing_yt:
        return True
    # 2) 规范化标题精确匹配
    if nt in existing_titles:
        return True
    # 3) 标题前缀匹配（兼容 bidclub 截断标题：bidclub 可能只存前半段）
    for bt in existing_titles:
        if len(bt) >= 15 and (nt.startswith(bt) or bt.startswith(nt)):
            return True
    return False


# ---------- DeepSeek AI 翻译与提炼 ----------
DEEPSEEK_API_KEY = os.environ.get("DEEPSEEK_API_KEY", "")
DEEPSEEK_API_URL = os.environ.get("DEEPSEEK_API_URL", "https://api.deepseek.com/v1/chat/completions")


def ai_translate(title, desc, channel):
    """用 DeepSeek 把英文播客信息提炼并翻译为中文结构化信息。"""
    if not DEEPSEEK_API_KEY:
        return None
    prompt = f"""请将这档英文播客的信息翻译并提炼为中文结构化信息：
播客频道：{channel}
播客标题：{title}
播客简介：{desc[:1500]}

请仅以标准 JSON 格式输出，不要有任何额外文字、思考过程或 markdown 标记：
{{
  "title_zh": "精炼且吸引人的中文标题",
  "guest": "嘉宾姓名（若无法推断则空字符串）",
  "tldr_zh": "一句话中文摘要（约50-100字，客观精炼）",
  "points": ["核心观点1", "核心观点2", "核心观点3"]
}}
"""
    headers = {
        "Authorization": f"Bearer {DEEPSEEK_API_KEY}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": "deepseek-chat",
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.3,
        "response_format": {"type": "json_object"},
    }
    try:
        import urllib.request
        req = urllib.request.Request(DEEPSEEK_API_URL, json.dumps(payload).encode(), headers)
        with urllib.request.urlopen(req, timeout=20) as res:
            data = json.loads(res.read().decode())
            content = data["choices"][0]["message"]["content"]
            return json.loads(content)
    except Exception as e:
        print(f"[sync_aisignal_picks] AI 翻译跳过/失败 ({title[:20]}...): {e}", file=sys.stderr)
        return None


def make_workbuddy_transcribe_url(channel, title, guest, url):
    cwd = "/Users/clawbot/workbuddy-ai/po d"
    clean_title = (title or "").strip()
    if clean_title:
        title_str = clean_title if (clean_title.startswith("《") and clean_title.endswith("》")) else f"《{clean_title}》"
    else:
        title_str = "指定播客"
    prompt = f"请在 po d 空间使用 podcast-to-wechat-workflow 对{title_str}进行转录与深度改写"
    params = {
        "action": "start",
        "cwd": cwd,
        "prompt": prompt,
    }
    encoded = urllib.parse.urlencode(params, quote_via=lambda s, safe="", encoding=None, errors=None: urllib.parse.quote(s, safe=""))
    return f"workbuddy-ai://task?{encoded}"


# ---------- 落盘 ----------
def build_md(e, out_dir, translate=True):
    channel = e.get("channel") or ""
    title = e.get("title") or ""
    pub = e.get("pub_date") or ""
    date = pub[:10] if pub else _dt.date.today().isoformat()
    duration = parse_duration(e.get("duration"))
    slug = derive_slug(e)
    url = e.get("link") or e.get("audio_url") or ""
    raw_desc = strip_html(e.get("description"), limit=2500)

    y = yt_id(url)
    thumbnail_url = f"https://img.youtube.com/vi/{y}/hqdefault.jpg" if y else ""

    guest = ""
    if " | " in title:
        parts = title.split(" | ")
        if len(parts) >= 2:
            guest = parts[0].strip()

    title_zh = title
    tldr_zh = "（中文摘要待补）"
    points = []

    if translate and (title or raw_desc):
        info = ai_translate(title, raw_desc, channel)
        if info and isinstance(info, dict):
            title_zh = info.get("title_zh") or title_zh
            if info.get("guest") and not guest:
                guest = info.get("guest")
            tldr_zh = info.get("tldr_zh") or tldr_zh
            points = info.get("points") or []

    ta = bool(e.get("transcript_available"))
    pick_status = "candidate"
    heading = title_zh if title_zh != title else title
    wb_url = make_workbuddy_transcribe_url(channel, heading, guest, url)

    body = [
        "---",
        f"channel: {yaml_str(channel)}",
        f"title: {yaml_str(title)}",
        f"title_zh: {yaml_str(title_zh)}",
        f"tldr_zh: {yaml_str(tldr_zh)}",
        f"guest: {yaml_str(guest)}",
        f"published_at: {yaml_date(pub)}",
        f"date: {yaml_date(date)}",
        f"duration_min: {duration}",
        "source: ai-signal",
        f"slug: {yaml_str(slug)}",
        f"url: {yaml_str(url)}",
        f"thumbnail_url: {yaml_str(thumbnail_url)}",
        f"pick_status: {pick_status}",
        "priority: 3",
        f"transcript: {'true' if ta else 'false'}",
        'article: ""',
        "---",
        "",
        f"# {heading}",
        "",
        f"> **{channel}** ｜ 嘉宾：{guest or '—'} ｜ 时长 {duration} 分钟 ｜ 播出 {pub or '未验证'}",
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
        "> _点击后将自动唤出 WorkBuddy 切换到 `po d` 空间，并将精准转录与深度改写指令自动预填至输入框。也可点击笔记顶部状态栏右侧的 **「🎙️ WorkBuddy 转录」** 按钮一键直达。_",
        "",
        "## 一句话摘要",
        "",
        tldr_zh,
        "",
        "## 核心观点",
        "",
    ]
    if points:
        for p in points:
            body.append(f"- **{p}**" if not p.startswith("-") else p)
    else:
        body.append("（核心观点待补）")

    body.extend([
        "",
        "## 英文原文",
        "",
        raw_desc if raw_desc else "（无英文简介）",
        "",
        "## 状态",
        "",
        f"当前状态：`{pick_status}`",
        "",
        "> 以下为状态流转图例（说明可选值，**不代表本卡当前状态**）：",
        ">",
        "> `candidate`（候选）→ `selected`（已选）→ `transcribed`（已转录）→ `published`（已发公众号）",
        "",
        "- 数据来源：ai-signal 主源（benboer/ai-signal），与 bidclub 去重后独立成卡",
        '- 公众号文章：（发布后回填 frontmatter 的 `article`）',
        "",
        "## 链接",
        "",
        f"- 源：{url}",
        "",
    ])
    path = os.path.join(out_dir, slug_to_filename(date, slug))
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(body))
    return path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=14, help="只落 pub_date 在最近 N 天内的单集")
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--payload", default=DEFAULT_PAYLOAD)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--no-translate", action="store_true", help="跳过 AI 中文翻译")
    args = ap.parse_args()

    if not os.path.exists(args.payload):
        print(f"[sync_aisignal_picks] payload 不存在: {args.payload}", file=sys.stderr)
        return 2
    try:
        p = json.load(open(args.payload, encoding="utf-8"))
        pods = (p.get("podcasts") if isinstance(p, dict) else p) or []
    except Exception as e:
        print(f"[sync_aisignal_picks] payload 解析失败: {e}", file=sys.stderr)
        return 2

    os.makedirs(args.out, exist_ok=True)
    exist_titles, exist_yt, exist_files = load_existing(args.out)

    _now = _dt.datetime.now(_dt.timezone.utc)
    _cutoff = _now - _dt.timedelta(days=args.days)

    created = skipped_dup = skipped_old = skipped_nodate = failed = 0
    plan = []
    for e in pods:
        title = e.get("title") or ""
        link = e.get("link") or e.get("audio_url") or ""
        pub = e.get("pub_date") or ""
        date = pub[:10]
        if not title:
            continue
        # 日期过滤
        if date:
            try:
                _pub = _dt.datetime.fromisoformat(pub.replace("Z", "+00:00"))
                if _pub < _cutoff:
                    skipped_old += 1
                    continue
            except Exception:
                pass
        else:
            skipped_nodate += 1  # 无发布日期的也保留（按今天日期落）
        # 去重
        if is_dup(title, link, exist_titles, exist_yt):
            skipped_dup += 1
            continue
        # 文件名已存在（同 slug）
        slug = derive_slug(e)
        fn = slug_to_filename(date or _dt.date.today().isoformat(), slug)
        if fn in exist_files:
            skipped_dup += 1
            continue
        plan.append((e, date, slug, fn))

    if args.dry_run:
        print(f"[sync_aisignal_picks] dry-run：拟新增 {len(plan)} 张，跳过 重复={skipped_dup} 过期={skipped_old} 无日期={skipped_nodate}")
        for e, d, s, fn in plan:
            print(f"  + {fn}  [{e.get('channel')}] {e.get('title')}")
        return 0

    for e, date, slug, fn in plan:
        try:
            build_md(e, args.out, translate=not args.no_translate)
            created += 1
            print(f"  + {fn}")
        except Exception as ex:
            print(f"[sync_aisignal_picks] 落盘失败 {slug}: {ex}", file=sys.stderr)
            failed += 1

    print(f"[sync_aisignal_picks] 完成：新增 {created} / 跳过(重复){skipped_dup} / 过期{skipped_old} / 无日期{skipped_nodate} / 失败{failed}")
    return 0 if failed == 0 else 3


if __name__ == "__main__":
    sys.exit(main())
