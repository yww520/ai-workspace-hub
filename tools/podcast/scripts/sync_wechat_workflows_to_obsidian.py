#!/usr/bin/env python3
"""
sync_wechat_workflows_to_obsidian.py

将 WorkBuddy (po d 空间) 中完成的微信文稿 (article.md) 同步沉淀到 Obsidian 知识库 (wiki/sources/)，
并自动反哺更新 output/podcast-picks/ 对应单集的状态 (transcribed / published) 与文稿引用链接 (article)。

用法：
    python3 sync_wechat_workflows_to_obsidian.py --dry-run
    python3 sync_wechat_workflows_to_obsidian.py --apply
"""

import argparse
import glob
import json
import os
import re
import sys

DEFAULT_WF_DIR = "/Users/clawbot/workbuddy-ai/po d/.workbuddy-ai/workflows/wechat"
DEFAULT_VAULT_ROOT = "/Users/clawbot/AI/skywork/ai-workspace-hub"


def clean_yaml_scalar(val):
    if val is None:
        return '""'
    s = str(val).replace("\\", "\\\\").replace('"', '\\"')
    s = re.sub(r"[\r\n\t]+", " ", s).strip()
    return f'"{s}"'


from urllib.parse import urlparse


def extract_yt_id(url):
    if not url:
        return None
    m = re.search(r"(?:v=|\/embed\/|\/watch\?v=|\/shorts\/|youtu\.be\/)([a-zA-Z0-9_-]{11})", url)
    return m.group(1) if m else None


def normalize_url(url):
    if not url:
        return ""
    u = url.strip().split("#")[0]
    yt = extract_yt_id(u)
    if yt:
        return f"youtube:{yt}"
    p = urlparse(u)
    return (p.netloc + p.path.rstrip("/")).lower()


def load_podcast_picks(picks_dir):
    pick_files = glob.glob(os.path.join(picks_dir, "*.md"))
    picks_data = []
    for pf in pick_files:
        try:
            content = open(pf, encoding="utf-8").read()
        except Exception:
            continue
        m_url = re.search(r"^url:\s*\"?([^\n\"]+)\"?", content, re.MULTILINE)
        m_slug = re.search(r"^slug:\s*\"?([^\n\"]+)\"?", content, re.MULTILINE)
        m_title = re.search(r"^title:\s*\"?([^\n\"]+)\"?", content, re.MULTILINE)
        m_title_zh = re.search(r"^title_zh:\s*\"?([^\n\"]+)\"?", content, re.MULTILINE)
        m_date = re.search(r"^date:\s*([^\n]+)", content, re.MULTILINE)
        m_status = re.search(r"^pick_status:\s*([^\n]+)", content, re.MULTILINE)
        m_guest = re.search(r"^guest:\s*\"?([^\n\"]+)\"?", content, re.MULTILINE)
        m_dur = re.search(r"^duration_min:\s*([0-9]+)", content, re.MULTILINE)
        m_art = re.search(r"^article:\s*\"?([^\n\"]*)\"?", content, re.MULTILINE)

        picks_data.append({
            "path": pf,
            "filename": os.path.basename(pf),
            "url": m_url.group(1).strip() if m_url else "",
            "slug": m_slug.group(1).strip() if m_slug else "",
            "title": m_title.group(1).strip() if m_title else "",
            "title_zh": m_title_zh.group(1).strip() if m_title_zh else "",
            "date": m_date.group(1).strip() if m_date else "",
            "status": m_status.group(1).strip() if m_status else "candidate",
            "guest": m_guest.group(1).strip() if m_guest else "",
            "duration_min": m_dur.group(1).strip() if m_dur else "",
            "article": m_art.group(1).strip() if m_art else "",
            "content": content,
        })
    return picks_data


def find_matching_pick(mf, d_name, picks_data):
    src_url = (mf.get("source_url") or "").strip()
    src_title = (mf.get("source_title") or "").strip()
    mf_title = (mf.get("title") or "").strip()
    mf_slug = (mf.get("slug") or d_name).strip()

    # 1. Exact URL match (supporting YouTube IDs and clean paths)
    wf_norm_u = normalize_url(src_url)
    if wf_norm_u:
        for p in picks_data:
            if p["url"] and normalize_url(p["url"]) == wf_norm_u:
                return p

    # 2. Exact slug match
    for p in picks_data:
        p_slug = p["slug"].lower()
        if p_slug and (p_slug == mf_slug.lower() or p_slug == d_name.lower()):
            return p

    # 3. Partial slug match
    s2 = re.sub(r"[^\w]+", "", d_name).lower()
    for p in picks_data:
        s1 = re.sub(r"[^\w]+", "", p["slug"]).lower()
        if len(s1) >= 15 and (s1 in s2 or s2 in s1 or s1[:20] == s2[:20]):
            return p

    # 4. Title match
    if src_title:
        src_t_clean = re.sub(r"[^\w\u4e00-\u9fa5]+", "", src_title).lower()
        if len(src_t_clean) >= 8:
            for p in picks_data:
                p_t_clean = re.sub(r"[^\w\u4e00-\u9fa5]+", "", p["title"]).lower()
                p_tzh_clean = re.sub(r"[^\w\u4e00-\u9fa5]+", "", p["title_zh"]).lower()
                if (src_t_clean in p_t_clean) or (p_t_clean and p_t_clean in src_t_clean):
                    return p
                if (src_t_clean in p_tzh_clean) or (p_tzh_clean and p_tzh_clean in src_t_clean):
                    return p

    if mf_title:
        mf_t_clean = re.sub(r"[^\w\u4e00-\u9fa5]+", "", mf_title).lower()
        if len(mf_t_clean) >= 8:
            for p in picks_data:
                p_tzh_clean = re.sub(r"[^\w\u4e00-\u9fa5]+", "", p["title_zh"]).lower()
                if (mf_t_clean in p_tzh_clean) or (p_tzh_clean and p_tzh_clean in mf_t_clean):
                    return p

    # 5. Sarah Guo special check
    if "sarah-guo" in d_name and "250" in d_name:
        for p in picks_data:
            if "sarah-guo" in p["filename"] and "250" in p["filename"]:
                return p

    return None


def sync_workflows(wf_dir, vault_root, apply=False):
    import shutil
    wiki_sources_dir = os.path.join(vault_root, "wiki", "sources")
    picks_dir = os.path.join(vault_root, "output", "podcast-picks")
    vault_covers_dir = os.path.abspath(os.path.join(vault_root, "..", "covers"))
    os.makedirs(vault_covers_dir, exist_ok=True)

    os.makedirs(wiki_sources_dir, exist_ok=True)
    os.makedirs(picks_dir, exist_ok=True)

    picks_data = load_podcast_picks(picks_dir)
    print(f"Loaded {len(picks_data)} existing podcast pick notes from {picks_dir}")

    subdirs = sorted(os.listdir(wf_dir))
    created_articles = 0
    updated_picks = 0

    for d in subdirs:
        if d.startswith("_punk_cover_test") or d in ("input", ".DS_Store"):
            continue
        full_d = os.path.join(wf_dir, d)
        if not os.path.isdir(full_d):
            continue

        art_path = os.path.join(full_d, "article.md")
        if not os.path.isfile(art_path) or os.path.getsize(art_path) < 300:
            continue

        mf_path = os.path.join(full_d, "manifest.json")
        mf = {}
        if os.path.isfile(mf_path):
            try:
                with open(mf_path, encoding="utf-8") as f:
                    mf = json.load(f)
            except Exception:
                pass

        title = mf.get("title") or d
        draft_id = (mf.get("draft_media_id") or "").strip()
        is_published = bool(draft_id) or (mf.get("status") == "published")
        status_label = "published" if is_published else "transcribed"
        created_raw = mf.get("created_at") or mf.get("updated_at") or "2026-08-20"
        date_str = created_raw[:10]
        channel = mf.get("source_channel") or ""
        source_url = mf.get("source_url") or ""

        # Clean slug for filename
        clean_slug = re.sub(r"[^\w\u4e00-\u9fa5-]+", "-", d).strip("-")
        dest_filename = f"{date_str}-wechat-{clean_slug}.md"
        dest_path = os.path.join(wiki_sources_dir, dest_filename)

        # Match podcast pick
        matched_pick = find_matching_pick(mf, d, picks_data)

        # Check and copy cover
        wf_cover = os.path.join(full_d, "cover.png")
        cover_rel = ""
        if os.path.isfile(wf_cover) and os.path.getsize(wf_cover) > 1000:
            cov_name = f"{clean_slug}.png"
            dest_cov_path = os.path.join(vault_covers_dir, cov_name)
            if apply and (not os.path.isfile(dest_cov_path) or os.path.getsize(dest_cov_path) != os.path.getsize(wf_cover)):
                shutil.copy2(wf_cover, dest_cov_path)
            cover_rel = f"covers/{cov_name}"

        # Read article content
        with open(art_path, encoding="utf-8") as f:
            article_body = f.read()

        # Build frontmatter for wiki/sources
        tags = ["wechat", "published"] if is_published else ["wechat", "transcribed"]
        pick_ref = f"[[{matched_pick['filename']}]]" if matched_pick else ""

        frontmatter = [
            "---",
            f"title: {clean_yaml_scalar(title)}",
            f"title_zh: {clean_yaml_scalar(title)}",
            "type: source-summary",
            "domain: investing",
            f"channel: {clean_yaml_scalar(channel)}",
            f"sources: [{clean_yaml_scalar(source_url)}]",
            f"date: {date_str}",
            f"published_at: {date_str}",
            f"created: {date_str}",
            f"updated: {date_str}",
            f"tags: [{', '.join(tags)}]",
            f"wechat_draft_id: {clean_yaml_scalar(draft_id)}",
            f"pick_status: {status_label}",
            f'article: "[[{dest_filename}|{title}]]"',
        ]
        if cover_rel:
            frontmatter.append(f'cover: "{cover_rel}"')
            frontmatter.append(f'thumbnail_url: "{cover_rel}"')
        if pick_ref:
            frontmatter.append(f"podcast_pick: {clean_yaml_scalar(pick_ref)}")
        if matched_pick:
            if matched_pick.get("guest"):
                frontmatter.append(f"guest: {clean_yaml_scalar(matched_pick['guest'])}")
            if matched_pick.get("duration_min"):
                frontmatter.append(f"duration_min: {matched_pick['duration_min']}")
        frontmatter.append("---\n")

        # Strip existing leading H1 if it duplicates frontmatter title in unexpected ways, or keep intact
        full_article_content = "\n".join(frontmatter) + article_body.lstrip()

        # Write or preview wiki/sources article
        if not os.path.isfile(dest_path) or apply:
            if apply:
                with open(dest_path, "w", encoding="utf-8") as f:
                    f.write(full_article_content)
            created_articles += 1

        # Update matched podcast pick
        if matched_pick:
            p_path = matched_pick["path"]
            p_content = matched_pick["content"]
            new_target_status = "published" if is_published else "transcribed"
            wiki_link = f"[[{dest_filename}|{title}]]"

            # Check if needs update
            needs_update = False
            curr_status_m = re.search(r"^pick_status:\s*([^\n]+)", p_content, re.MULTILINE)
            curr_status = curr_status_m.group(1).strip() if curr_status_m else ""
            if curr_status != new_target_status:
                needs_update = True

            curr_art_m = re.search(r"^article:\s*\"?([^\n\"]*)\"?", p_content, re.MULTILINE)
            curr_art = curr_art_m.group(1).strip() if curr_art_m else ""
            if curr_art != wiki_link:
                needs_update = True

            if needs_update:
                updated_picks += 1
                if apply:
                    p_new = re.sub(
                        r"^pick_status:\s*[^\n]+",
                        f"pick_status: {new_target_status}",
                        p_content,
                        flags=re.MULTILINE,
                    )
                    p_new = re.sub(
                        r"^article:\s*\"?[^\n\"]*\"?",
                        f'article: "{wiki_link}"',
                        p_new,
                        flags=re.MULTILINE,
                    )
                    if re.search(r"^read_status:", p_new, re.MULTILINE):
                        p_new = re.sub(r"^read_status:\s*[^\n]+", "read_status: 已读", p_new, flags=re.MULTILINE)
                    else:
                        p_new = re.sub(r"^---\n", "---\nread_status: 已读\n", p_new, count=1)

                    if draft_id:
                        if re.search(r"^wechat_draft_id:", p_new, re.MULTILINE):
                            p_new = re.sub(r"^wechat_draft_id:\s*[^\n]+", f'wechat_draft_id: "{draft_id}"', p_new, flags=re.MULTILINE)
                        else:
                            p_new = re.sub(r"^---\n", f'---\nwechat_draft_id: "{draft_id}"\n', p_new, count=1)

                    # Update body state text
                    p_new = re.sub(
                        r"当前状态：`[^`]+`",
                        f"当前状态：`{new_target_status}`",
                        p_new,
                    )
                    p_new = re.sub(
                        r"- 公众号文章：[^\n]*",
                        f"- 公众号文章：{wiki_link}",
                        p_new,
                    )
                    with open(p_path, "w", encoding="utf-8") as f:
                        f.write(p_new)
                    matched_pick["content"] = p_new

        status_flag = "🚀 PUBLISHED" if is_published else "📝 TRANSCRIBED"
        pick_flag = f"🔗 {matched_pick['filename']}" if matched_pick else "📄 (独立文稿)"
        print(f"[{status_flag}] {date_str} | {dest_filename} | {title[:32]} | {pick_flag}")

    print("\n" + "=" * 60)
    print(f"Sync summary ({'APPLIED' if apply else 'DRY-RUN'}):")
    print(f"  - Total wechat articles processed: {created_articles}")
    print(f"  - Podcast picks updated: {updated_picks}")
    print("=" * 60)


def main():
    ap = argparse.ArgumentParser(description="Sync WorkBuddy wechat workflows to Obsidian Reading-Hub")
    ap.add_argument("--wf-dir", default=DEFAULT_WF_DIR, help="WorkBuddy workflows/wechat path")
    ap.add_argument("--vault-root", default=DEFAULT_VAULT_ROOT, help="Obsidian ai-workspace-hub path")
    ap.add_argument("--apply", action="store_true", help="Actually write files to Obsidian")
    args = ap.parse_args()

    sync_workflows(args.wf_dir, args.vault_root, apply=args.apply)


if __name__ == "__main__":
    main()
