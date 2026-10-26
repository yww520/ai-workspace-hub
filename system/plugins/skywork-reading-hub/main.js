var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

var main_exports = {};
__export(main_exports, {
  default: () => SkyworkReadingHubPlugin
});
module.exports = __toCommonJS(main_exports);

var { Plugin, ItemView, WorkspaceLeaf, Notice, Setting, PluginSettingTab, setIcon, MarkdownView, TFile, requestUrl, Modal, Component } = require("obsidian");
var { ViewPlugin, Decoration } = require("@codemirror/view");
var { RangeSetBuilder } = require("@codemirror/state");

const VIEW_TYPE_READING_COMPANION = "skywork-reading-companion";

const DEFAULT_SETTINGS = {
  aiApiUrl: "https://api.deepseek.com/v1",
  aiApiKey: "",
  aiModel: "deepseek-chat",
  aiPrompt: `你是一位专业的内容主编与研究员。请为以下文章生成深度结构化总结，语言为中文：\n1. 【一句话精髓】：用一句话抓住核心主旨；\n2. 【核心观点与论据】：列出 3-5 个最重要的要点或数据；\n3. 【关键启示与行动建议】：给出 2-3 条对读者最有价值的洞察。\n\n请使用清晰的 Markdown 列表输出。`,
  highlightFormat: "markdown",
  enableStatusBar: true,
  enableSelectionBubble: true,
  autoInsertSummary: false,
  foldExpanded: []
};

function inferCategoryFromPath(path) {
  if (path.includes("/inbox")) return "📥 Inbox 待处理";
  if (path.includes("/output/research")) return "🔬 深度研究";
  if (path.includes("/output/screen")) return "🔍 筛选发现";
  if (path.includes("/output/pod2wiki") || path.includes("/podcasts")) return "🎙️ 播客纪要";
  if (path.includes("/output/podcast-picks")) return "🎯 播客选品";
  if (path.includes("/output/daily-watch") || path.includes("/ai-signal") || path.includes("/monitoring")) return "📊 日报监控";
  if (path.includes("/wiki/sources")) return "📚 Sources 知识库";
  return "📄 笔记";
}

// --- Live Preview Tag Hider (CM6 Extension) ---
const TAG_REGEX = /(<mark\s+class="(?:hl-|srh-hl-)(yellow|green|blue|purple|orange)">)([\s\S]*?)(<\/mark>)|(<u\s+class="(?:hl-|srh-hl-)(?:red|underline)">)([\s\S]*?)(<\/u>)/gi;

function buildTagDecorations(view) {
  const builder = new RangeSetBuilder();
  const cursor = view.state.selection.main.head;
  const doc = view.state.doc;
  for (const { from, to } of view.visibleRanges) {
    const text = doc.sliceString(from, to);
    TAG_REGEX.lastIndex = 0;
    let match;
    while ((match = TAG_REGEX.exec(text)) !== null) {
      const matchFrom = from + match.index;
      const matchTo = matchFrom + match[0].length;
      const isMark = !!match[1];
      const openTag = isMark ? match[1] : match[4];
      const content = isMark ? match[2] : match[5];
      const closeTag = isMark ? match[3] : match[6];
      const color = (isMark ? match[2] : "red").toLowerCase();
      const colorClass = `srh-hl-${color}`;

      const isCursorInside = cursor >= matchFrom && cursor <= matchTo;
      if (!isCursorInside) {
        // Hide start tag
        builder.add(matchFrom, matchFrom + openTag.length, Decoration.replace({}));
        // Apply styling to content
        builder.add(matchFrom + openTag.length, matchTo - closeTag.length, Decoration.mark({ class: colorClass }));
        // Hide end tag
        builder.add(matchTo - closeTag.length, matchTo, Decoration.replace({}));
      }
    }
  }
  return builder.finish();
}

const livePreviewTagHider = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = buildTagDecorations(view);
    }
    update(update) {
      if (update.docChanged || update.viewportChanged || update.selectionSet) {
        this.decorations = buildTagDecorations(update.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations
  }
);

// --- Floating Selection Bubble Toolbar ---
class SelectionBubble {
  constructor(app, getSettings) {
    this.app = app;
    this.getSettings = getSettings;
    this.bubbleEl = document.createElement("div");
    this.bubbleEl.className = "srh-bubble";
    this.bubbleEl.style.display = "none";
    document.body.appendChild(this.bubbleEl);
    this.noteCardEl = null;
    this.currentRange = null;
    this.currentSelectedText = "";
    this.currentView = null;
    this.isShowing = false;

    this.renderButtons();
    this.registerEvents();
  }

  renderButtons() {
    this.bubbleEl.empty();
    const items = [
      { id: "yellow", title: "黄色划线 (核心观点)", colorDot: "#fde047" },
      { id: "green", title: "绿色划线 (数据事实)", colorDot: "#86efac" },
      { id: "blue", title: "蓝色划线 (概念背景)", colorDot: "#93c5fd" },
      { id: "purple", title: "紫色划线 (金句启发)", colorDot: "#d8b4fe" },
      { id: "underline", title: "红色下划线 (重点/警示)", icon: "underline" },
      { id: "clear", title: "清除划线", icon: "eraser" }
    ];

    for (const item of items) {
      const btn = this.bubbleEl.createEl("button", {
        cls: "srh-bubble-btn",
        attr: { "aria-label": item.title, title: item.title }
      });
      if (item.colorDot) {
        const dot = btn.createSpan({ cls: "srh-color-dot" });
        dot.style.backgroundColor = item.colorDot;
      } else if (item.icon) {
        setIcon(btn, item.icon);
      }
      btn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.applyHighlight(item.id);
      });
    }

    this.bubbleEl.createDiv({ cls: "srh-bubble-divider" });

    // Note / Marginalia Button
    const noteBtn = this.bubbleEl.createEl("button", {
      cls: "srh-bubble-btn srh-btn-text",
      attr: { "aria-label": "写想法 / 批注", title: "写想法 / 批注" }
    });
    setIcon(noteBtn, "message-square-plus");
    noteBtn.createSpan({ text: "批注" });
    noteBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.openNoteCard();
    });

    // AI Explain Button
    const aiBtn = this.bubbleEl.createEl("button", {
      cls: "srh-bubble-btn srh-btn-text",
      attr: { "aria-label": "AI 深度解读", title: "AI 深度解读" }
    });
    setIcon(aiBtn, "sparkles");
    aiBtn.createSpan({ text: "AI 解读" });
    aiBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.explainWithAi();
    });

    // Copy Quote Button
    const copyBtn = this.bubbleEl.createEl("button", {
      cls: "srh-bubble-btn",
      attr: { "aria-label": "复制引用", title: "复制引用" }
    });
    setIcon(copyBtn, "copy");
    copyBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.copyQuote();
    });
  }

  registerEvents() {
    document.addEventListener("mouseup", this.onMouseUp.bind(this));
    document.addEventListener("mousedown", this.onMouseDown.bind(this));
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.hide();
    });
    window.addEventListener("scroll", () => this.hide(), true);
  }

  onMouseDown(e) {
    if (this.bubbleEl.contains(e.target)) return;
    if (this.noteCardEl && this.noteCardEl.contains(e.target)) return;
    this.hide();
  }

  onMouseUp(e) {
    if (this.bubbleEl.contains(e.target)) return;
    if (this.noteCardEl && this.noteCardEl.contains(e.target)) return;
    const settings = this.getSettings();
    if (!settings.enableSelectionBubble) return;

    window.setTimeout(() => {
      const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!activeView) {
        this.hide();
        return;
      }
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) {
        this.hide();
        return;
      }
      const text = selection.toString().trim();
      if (!text || text.length === 0) {
        this.hide();
        return;
      }
      const range = selection.getRangeAt(0);
      const container = activeView.containerEl;
      if (!container.contains(range.commonAncestorContainer)) {
        this.hide();
        return;
      }

      this.currentRange = range.cloneRange();
      this.currentSelectedText = text;
      this.currentView = activeView;
      this.showAtRange(range);
    }, 20);
  }

  showAtRange(range) {
    const rect = range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      this.hide();
      return;
    }
    this.bubbleEl.style.display = "flex";
    const bubbleRect = this.bubbleEl.getBoundingClientRect();
    let top = rect.top - bubbleRect.height - 8;
    let left = rect.left + (rect.width - bubbleRect.width) / 2;
    if (top < 10) top = rect.bottom + 8;
    if (left < 10) left = 10;
    if (left + bubbleRect.width > window.innerWidth - 10) {
      left = window.innerWidth - bubbleRect.width - 10;
    }
    this.bubbleEl.style.top = `${top + window.scrollY}px`;
    this.bubbleEl.style.left = `${left + window.scrollX}px`;
    this.isShowing = true;
  }

  hide() {
    this.bubbleEl.style.display = "none";
    this.isShowing = false;
    if (this.noteCardEl) {
      this.noteCardEl.remove();
      this.noteCardEl = null;
    }
  }

  applyHighlight(type) {
    if (!this.currentView) return;
    const editor = this.currentView.editor;
    const selected = editor.getSelection();
    const text = selected || this.currentSelectedText;
    if (!text) return;

    const settings = this.getSettings();
    let replacement = text;

    if (type === "clear") {
      // Strip highlights & tags
      replacement = text
        .replace(/^==([\s\S]*?)==$/, "$1")
        .replace(/<mark\s+class="[^"]*">([\s\S]*?)<\/mark>/gi, "$1")
        .replace(/<u\s+class="[^"]*">([\s\S]*?)<\/u>/gi, "$1");
    } else if (type === "yellow") {
      replacement = settings.highlightFormat === "markdown" 
        ? `==${text}==` 
        : `<mark class="srh-hl-yellow">${text}</mark>`;
    } else if (type === "green") {
      replacement = `<mark class="srh-hl-green">${text}</mark>`;
    } else if (type === "blue") {
      replacement = `<mark class="srh-hl-blue">${text}</mark>`;
    } else if (type === "purple") {
      replacement = `<mark class="srh-hl-purple">${text}</mark>`;
    } else if (type === "underline") {
      replacement = `<u class="srh-hl-red">${text}</u>`;
    }

    editor.replaceSelection(replacement);
    this.hide();
  }

  openNoteCard() {
    if (this.noteCardEl) this.noteCardEl.remove();
    if (!this.currentRange || !this.currentView) return;

    const rect = this.currentRange.getBoundingClientRect();
    const card = document.createElement("div");
    card.className = "srh-note-card";
    card.innerHTML = `
      <div class="srh-note-title">添加想法 / 批注</div>
      <div class="srh-note-quote">"${this.currentSelectedText.slice(0, 30)}${this.currentSelectedText.length > 30 ? "..." : ""}"</div>
      <textarea class="srh-note-textarea" placeholder="写下你的思考、疑问或行动建议... (按 Enter 提交)"></textarea>
      <div class="srh-note-actions">
        <button class="srh-note-cancel">取消</button>
        <button class="srh-note-save">保存</button>
      </div>
    `;

    document.body.appendChild(card);
    this.noteCardEl = card;

    let top = rect.bottom + 8;
    let left = rect.left;
    if (left + 290 > window.innerWidth - 10) left = window.innerWidth - 300;
    if (top + 160 > window.innerHeight) top = rect.top - 170;

    card.style.top = `${top + window.scrollY}px`;
    card.style.left = `${left + window.scrollX}px`;

    const textarea = card.querySelector("textarea");
    const saveBtn = card.querySelector(".srh-note-save");
    const cancelBtn = card.querySelector(".srh-note-cancel");

    textarea.focus();

    const doSave = () => {
      const note = textarea.value.trim();
      if (!note) {
        this.hide();
        return;
      }
      const editor = this.currentView.editor;
      const selected = editor.getSelection();
      const text = selected || this.currentSelectedText;
      const replacement = `<mark class="srh-hl-yellow">${text}</mark> ^[💭 ${note}]`;
      editor.replaceSelection(replacement);
      new Notice("💡 批注已添加");
      this.hide();
    };

    saveBtn.addEventListener("click", doSave);
    cancelBtn.addEventListener("click", () => this.hide());
    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        doSave();
      } else if (e.key === "Escape") {
        this.hide();
      }
    });
  }

  async explainWithAi() {
    const text = this.currentSelectedText;
    const settings = this.getSettings();
    if (!settings.aiApiKey) {
      new Notice("请先在「知识阅读台」设置中配置 AI API Key。", 5000);
      return;
    }
    this.hide();
    new Notice("🤖 正在请求 AI 解读选中文本...", 3000);

    try {
      const resp = await requestUrl({
        url: `${settings.aiApiUrl.replace(/\/+$/, "")}/chat/completions`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${settings.aiApiKey}`
        },
        body: JSON.stringify({
          model: settings.aiModel || "deepseek-chat",
          messages: [
            {
              role: "system",
              content: "你是一位精辟深刻的知识助手。请用最凝练、易懂的中文解释用户选中的文本：抓住核心含义、指出背后的关键逻辑或背景事实，控制在 150 字以内。"
            },
            {
              role: "user",
              content: text
            }
          ],
          temperature: 0.3
        })
      });

      const data = resp.json;
      const answer = data?.choices?.[0]?.message?.content || "无返回结果";
      new AiExplainModal(this.app, text, answer).open();
    } catch (err) {
      new Notice(err instanceof Error ? err.message : "AI 请求失败，请检查网络或配置");
    }
  }

  copyQuote() {
    if (!this.currentView?.file) return;
    const file = this.currentView.file;
    const quote = `> "${this.currentSelectedText}"\n> —— 来自《[[${file.basename}]]》`;
    navigator.clipboard.writeText(quote);
    new Notice("📋 已复制引用");
    this.hide();
  }

  destroy() {
    this.bubbleEl.remove();
    if (this.noteCardEl) this.noteCardEl.remove();
  }
}

// --- AI Explain Modal ---
class AiExplainModal extends Modal {
  constructor(app, selectedText, explanation) {
    super(app);
    this.selectedText = selectedText;
    this.explanation = explanation;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "🤖 AI 深度解读" });
    const quoteEl = contentEl.createDiv({ cls: "srh-ai-box" });
    quoteEl.style.maxHeight = "120px";
    quoteEl.style.borderLeft = "3px solid var(--interactive-accent)";
    quoteEl.setText(this.selectedText);

    const bodyEl = contentEl.createDiv({ cls: "srh-ai-box" });
    bodyEl.style.marginTop = "12px";
    bodyEl.style.whiteSpace = "pre-wrap";
    bodyEl.setText(this.explanation);

    const actions = contentEl.createDiv({ cls: "srh-note-actions" });
    actions.style.marginTop = "12px";
    const copyBtn = actions.createEl("button", { text: "复制解读" });
    copyBtn.onclick = () => {
      navigator.clipboard.writeText(this.explanation);
      new Notice("已复制");
      this.close();
    };
  }
  onClose() {
    this.contentEl.empty();
  }
}

// --- AI Summary Modal ---
class AiSummaryModal extends Modal {
  constructor(app, title, summary, onInsert) {
    super(app);
    this.title = title;
    this.summary = summary;
    this.onInsert = onInsert;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: `✨ 《${this.title}》AI 深度总结` });
    const box = contentEl.createDiv({ cls: "srh-ai-box" });
    box.style.whiteSpace = "pre-wrap";
    box.style.maxHeight = "360px";
    box.setText(this.summary);

    const actions = contentEl.createDiv({ cls: "srh-note-actions" });
    actions.style.marginTop = "14px";

    const insertBtn = actions.createEl("button", { cls: "srh-note-save", text: "📥 插入到笔记文首" });
    insertBtn.onclick = async () => {
      await this.onInsert();
      new Notice("已插入到笔记顶部！");
      this.close();
    };

    const copyBtn = actions.createEl("button", { text: "📋 复制" });
    copyBtn.onclick = () => {
      navigator.clipboard.writeText(this.summary);
      new Notice("已复制到剪贴板！");
    };

    const closeBtn = actions.createEl("button", { cls: "srh-note-cancel", text: "关闭" });
    closeBtn.onclick = () => this.close();
  }
  onClose() {
    this.contentEl.empty();
  }
}

// --- Document Top Reading Status Banner ---
class ReadingStatusBar {
  constructor(app, getSettings) {
    this.app = app;
    this.getSettings = getSettings;
    this.activeBanners = new Map();
  }

  updateForView(view) {
    const settings = this.getSettings();
    if (!settings.enableStatusBar) {
      this.removeForView(view);
      return;
    }
    const file = view.file;
    if (!file || file.extension !== "md") {
      this.removeForView(view);
      return;
    }

    let banner = this.activeBanners.get(view);
    if (!banner) {
      banner = document.createElement("div");
      banner.className = "srh-status-banner";
      const parent = view.contentEl.querySelector(".view-header") || view.containerEl;
      parent.insertAdjacentElement("afterend", banner);
      this.activeBanners.set(view, banner);
    }

    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
    const currentStatus = fm["read_status"] || "未读";
    const category = inferCategoryFromPath(file.path);

    banner.empty();

    // Left: Category + Status Pills
    const left = banner.createDiv({ cls: "srh-banner-left" });
    const catBadge = left.createSpan({ cls: "srh-category-badge" });
    catBadge.setText(category);

    const pills = left.createDiv({ cls: "srh-status-pills" });
    const statuses = [
      { id: "未读", label: "📄 未读" },
      { id: "精读", label: "⭐ 精读" },
      { id: "已读", label: "✅ 已读" },
      { id: "跳过", label: "⏭️ 跳过" }
    ];

    for (const st of statuses) {
      const pill = pills.createEl("button", {
        cls: `srh-pill ${currentStatus === st.id ? "active" : ""}`,
        text: st.label
      });
      pill.onclick = async () => {
        try {
          await this.app.fileManager.processFrontMatter(file, (data) => {
            data["read_status"] = st.id;
          });
          new Notice(`已标记为「${st.id}」`);
          this.updateForView(view);
        } catch (e) {
          new Notice("更新状态失败");
        }
      };
    }

    // 选品卡片专属：pick_status 状态流转药丸（仅对 output/podcast-picks 下的卡片渲染）
    if (file.path.includes("/output/podcast-picks")) {
      const currentPick = fm["pick_status"] || "candidate";
      const pickWrap = left.createDiv({ cls: "srh-status-pills srh-pick-pills" });
      pickWrap.createSpan({ cls: "srh-pick-label", text: "选品：" });
      const pickStatuses = [
        { id: "candidate", label: "🎯 候选" },
        { id: "selected", label: "📌 已选" },
        { id: "transcribed", label: "📝 已转录" },
        { id: "published", label: "🚀 已发布" }
      ];
      for (const ps of pickStatuses) {
        const pill = pickWrap.createEl("button", {
          cls: `srh-pill srh-pill-pick ${currentPick === ps.id ? "active" : ""}`,
          text: ps.label
        });
        pill.onclick = async () => {
          try {
            await this.app.fileManager.processFrontMatter(file, (data) => {
              data["pick_status"] = ps.id;
            });
            new Notice(`选品状态已设为「${ps.id}」`);
            this.updateForView(view);
            // metadataCache 更新有延迟，稍后再刷一次，确保高亮跟着走
            setTimeout(() => this.updateForView(view), 200);
          } catch (e) {
            new Notice("更新选品状态失败");
          }
        };
      }
    }

    // Right: Action Buttons (WorkBuddy, Video, AI Summary)
    const right = banner.createDiv({ cls: "srh-banner-right" });

    const isPodcastPick = file.path.includes("/output/podcast-picks") || Boolean(fm["pick_status"]) || Boolean(fm["channel"]);
    if (isPodcastPick) {
      // 1. WorkBuddy 转录按钮 (绿色)
      const wbBtn = right.createEl("button", { cls: "srh-banner-btn srh-btn-workbuddy", attr: { title: "唤起 WorkBuddy 启动转录流水线" } });
      setIcon(wbBtn, "mic");
      wbBtn.createSpan({ text: "WorkBuddy 转录" });
      wbBtn.onclick = async () => {
        const channel = srhToText(fm["channel"]);
        const title = srhToText(fm["title_zh"]) || srhToText(fm["title"]) || file.basename;
        const guest = srhToText(fm["guest"]);
        const url = srhToText(fm["url"]);
        const origTitle = srhToText(fm["title"]);

        let targetWbUrl = "";
        try {
          const fileText = await this.app.vault.read(file);
          const m = fileText.match(/workbuddy-ai:\/\/task\?[^\s\)\"\'>]+/);
          if (m) targetWbUrl = m[0];
        } catch (err) {}

        if (!targetWbUrl) {
          const cleanTitle = (title || "").trim();
          const titleStr = cleanTitle.startsWith("《") && cleanTitle.endsWith("》") ? cleanTitle : `《${cleanTitle}》`;
          const origSuffix = origTitle && origTitle !== cleanTitle ? `（原标题：${origTitle}）` : "";
          let prompt = `请在 po d 空间使用 podcast-to-wechat-workflow 对${titleStr}${origSuffix}进行转录与深度改写`;
          if (url) prompt += `，源链接为：${url}`;
          const params = new URLSearchParams({
            action: "start",
            cwd: "/Users/clawbot/workbuddy-ai/po d",
            prompt: prompt
          });
          targetWbUrl = `workbuddy-ai://task?${params.toString()}`;
        }

        try {
          await this.app.fileManager.processFrontMatter(file, (data) => {
            data["pick_status"] = "selected";
          });
          this.updateForView(view);
        } catch (err) {}

        window.location.href = targetWbUrl;
        new Notice("🚀 正在唤出 WorkBuddy（po d 空间）发起转录，状态已设为「已选」！");
      };

      // 2. 制作短视频按钮 (红色)
      const videoBtn = right.createEl("button", { cls: "srh-banner-btn srh-btn-video", attr: { title: "打开 3:4 杂志短视频工坊" } });
      setIcon(videoBtn, "video");
      videoBtn.createSpan({ text: "制作短视频" });
      videoBtn.onclick = () => {
        const url = srhToText(fm["url"]);
        if (url) {
          const targetUrl = `http://127.0.0.1:8787/?auto=1&url=${encodeURIComponent(url)}`;
          window.open(targetUrl, "_blank");
          new Notice("🎬 正在唤起 3:4 杂志短视频工坊...");
        } else {
          window.open("http://127.0.0.1:8787", "_blank");
        }
      };
    }

    // 3. AI 总结按钮
    const aiBtn = right.createEl("button", { cls: "srh-banner-ai-btn" });
    setIcon(aiBtn, "sparkles");
    aiBtn.createSpan({ text: "AI 总结" });
    aiBtn.onclick = () => this.generateAiSummary(file);
  }

  async generateAiSummary(file) {
    const settings = this.getSettings();
    if (!settings.aiApiKey) {
      new Notice("请先在「知识阅读台」设置中配置 AI API Key。", 5000);
      return;
    }
    new Notice("✨ 正在为《" + file.basename + "》生成 AI 结构化总结...", 4000);
    try {
      const content = await this.app.vault.read(file);
      const resp = await requestUrl({
        url: `${settings.aiApiUrl.replace(/\/+$/, "")}/chat/completions`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${settings.aiApiKey}`
        },
        body: JSON.stringify({
          model: settings.aiModel || "deepseek-chat",
          messages: [
            { role: "system", content: settings.aiPrompt || DEFAULT_SETTINGS.aiPrompt },
            { role: "user", content: `请总结文章《${file.basename}》：\n\n${content.slice(0, 18000)}` }
          ],
          temperature: 0.3
        })
      });

      const summary = resp.json?.choices?.[0]?.message?.content || "无总结内容";

      const doInsert = async () => {
        await this.app.vault.process(file, (text) => {
          const callout = `> [!abstract] 🤖 AI 深度总结\n` + 
            summary.split("\n").map((l) => `> ${l}`).join("\n") + `\n\n`;
          const fmMatch = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
          if (fmMatch) {
            return fmMatch[0] + "\n" + callout + text.slice(fmMatch[0].length);
          }
          return callout + text;
        });
      };

      if (settings.autoInsertSummary) {
        await doInsert();
        new Notice("✨ AI 总结已插入到笔记顶部！");
      } else {
        new AiSummaryModal(this.app, file.basename, summary, doInsert).open();
      }
    } catch (err) {
      new Notice(err instanceof Error ? err.message : "AI 请求失败");
    }
  }

  removeForView(view) {
    const banner = this.activeBanners.get(view);
    if (banner) {
      banner.remove();
      this.activeBanners.delete(view);
    }
  }

  destroy() {
    for (const b of this.activeBanners.values()) b.remove();
    this.activeBanners.clear();
  }
}

// --- Reading Companion Side Panel View ---
class ReadingCompanionView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.currentFile = null;
    this.cachedSummary = "";
  }

  getViewType() {
    return VIEW_TYPE_READING_COMPANION;
  }

  getDisplayText() {
    return "阅读助手";
  }

  getIcon() {
    return "book-open";
  }

  async onOpen() {
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.refresh())
    );
    this.registerEvent(
      this.app.metadataCache.on("changed", () => this.refresh())
    );
    await this.refresh();
  }

  async refresh() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("srh-companion-view");

    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    const file = activeView?.file || this.app.workspace.getActiveFile();

    if (!file || file.extension !== "md") {
      container.createDiv({
        cls: "srh-empty-state",
        text: "请在中间打开任意一篇 Markdown 笔记，阅读助手将实时呈现其状态、划线与 AI 洞察。"
      });
      return;
    }

    this.currentFile = file;

    // Header
    const header = container.createDiv({ cls: "srh-panel-header" });
    const title = header.createDiv({ cls: "srh-panel-title" });
    setIcon(title, "book-marked");
    title.createSpan({ text: file.basename });
    header.createDiv({ cls: "srh-panel-subtitle", text: `路径：${file.path}` });

    // Section 1: Note Meta & Status
    const metaCard = container.createDiv({ cls: "srh-card" });
    metaCard.createDiv({ cls: "srh-card-header", text: "📊 笔记与阅读状态" });

    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
    const status = fm["read_status"] || "未读";

    const catRow = metaCard.createDiv({ cls: "srh-meta-row" });
    catRow.createSpan({ text: "分类：" });
    catRow.createSpan({ cls: "srh-meta-val", text: inferCategoryFromPath(file.path) });

    const statRow = metaCard.createDiv({ cls: "srh-meta-row" });
    statRow.createSpan({ text: "状态：" });
    const pills = statRow.createDiv({ cls: "srh-status-pills" });
    for (const s of ["未读", "精读", "已读", "跳过"]) {
      const btn = pills.createEl("button", {
        cls: `srh-pill ${status === s ? "active" : ""}`,
        text: s
      });
      btn.onclick = async () => {
        await this.app.fileManager.processFrontMatter(file, (data) => {
          data["read_status"] = s;
        });
        new Notice(`已设为「${s}」`);
        this.refresh();
      };
    }

    // 选品卡片专属：pick_status 状态流转（仅对 output/podcast-picks 下的卡片渲染）
    if (file.path.includes("/output/podcast-picks")) {
      const pickStatus = fm["pick_status"] || "candidate";
      const pickRow = metaCard.createDiv({ cls: "srh-meta-row" });
      pickRow.createSpan({ text: "选品：" });
      const pickPills = pickRow.createDiv({ cls: "srh-status-pills" });
      const pickOptions = [
        { id: "candidate", label: "🎯 候选" },
        { id: "selected", label: "📌 已选" },
        { id: "transcribed", label: "📝 已转录" },
        { id: "published", label: "🚀 已发布" }
      ];
      for (const ps of pickOptions) {
        const btn = pickPills.createEl("button", {
          cls: `srh-pill srh-pill-pick ${pickStatus === ps.id ? "active" : ""}`,
          text: ps.label
        });
        btn.onclick = async () => {
          try {
            await this.app.fileManager.processFrontMatter(file, (data) => {
              data["pick_status"] = ps.id;
            });
            new Notice(`选品状态已设为「${ps.id}」`);
            this.refresh();
          } catch (e) {
            new Notice("更新选品状态失败");
          }
        };
      }
    }

    // Section 2: AI Summary
    const aiCard = container.createDiv({ cls: "srh-card" });
    const aiHeader = aiCard.createDiv({ cls: "srh-card-header" });
    aiHeader.createSpan({ text: "✨ AI 智能速读" });
    const sumBtn = aiHeader.createEl("button", { cls: "srh-banner-ai-btn", text: "生成总结" });

    const aiBox = aiCard.createDiv({ cls: "srh-ai-box" });
    if (this.cachedSummary) {
      aiBox.setText(this.cachedSummary);
    } else {
      aiBox.addClass("empty");
      aiBox.setText("点击上方「生成总结」按钮，一键提炼核心论点与启示。");
    }

    sumBtn.onclick = async () => {
      const settings = this.plugin.settings;
      if (!settings.aiApiKey) {
        new Notice("请先在插件设置中配置 AI API Key。");
        return;
      }
      aiBox.removeClass("empty");
      aiBox.setText("🤖 正在深度分析中，请稍候...");
      try {
        const content = await this.app.vault.read(file);
        const resp = await requestUrl({
          url: `${settings.aiApiUrl.replace(/\/+$/, "")}/chat/completions`,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${settings.aiApiKey}`
          },
          body: JSON.stringify({
            model: settings.aiModel || "deepseek-chat",
            messages: [
              { role: "system", content: settings.aiPrompt || DEFAULT_SETTINGS.aiPrompt },
              { role: "user", content: `请总结文章《${file.basename}》：\n\n${content.slice(0, 18000)}` }
            ],
            temperature: 0.3
          })
        });
        const summary = resp.json?.choices?.[0]?.message?.content || "无总结内容";
        this.cachedSummary = summary;
        aiBox.setText(summary);
      } catch (err) {
        aiBox.setText("生成失败：" + (err instanceof Error ? err.message : String(err)));
      }
    };

    // Section 3: Highlights & Annotations List
    const hlCard = container.createDiv({ cls: "srh-card" });
    const hlHeader = hlCard.createDiv({ cls: "srh-card-header" });
    hlHeader.createSpan({ text: "📝 本文划线与批注" });
    const copyAllBtn = hlHeader.createEl("button", { cls: "srh-pill", text: "📋 复制全部" });

    const content = await this.app.vault.read(file);
    const highlights = this.extractHighlights(content);

    copyAllBtn.onclick = () => {
      if (highlights.length === 0) {
        new Notice("当前笔记暂无划线");
        return;
      }
      const text = highlights.map((h, i) => `${i + 1}. ${h.text}${h.note ? `\n   💭 想法：${h.note}` : ""}`).join("\n\n");
      navigator.clipboard.writeText(`### 《${file.basename}》划线笔记\n\n` + text);
      new Notice("📋 已复制所有划线笔记");
    };

    if (highlights.length === 0) {
      hlCard.createDiv({ cls: "srh-empty-state", text: "本文暂无划线。在正文中选中文本即可划线或做笔记。" });
    } else {
      for (const h of highlights) {
        const item = hlCard.createDiv({ cls: `srh-highlight-item srh-hl-${h.color}-item` });
        item.createDiv({ text: `"${h.text}"` });
        if (h.note) {
          item.createDiv({ cls: "srh-hl-note", text: `💭 ${h.note}` });
        }
        item.onclick = () => {
          this.jumpToHighlight(h.text);
        };
      }
    }
  }

  extractHighlights(content) {
    const list = [];
    // 1. Native markdown highlights ==...==
    const mdRegex = /==([\s\S]*?)==/g;
    let m;
    while ((m = mdRegex.exec(content)) !== null) {
      if (m[1].trim()) {
        list.push({ color: "yellow", text: m[1].trim(), note: null });
      }
    }
    // 2. HTML marks & underlines with footnotes
    const htmlRegex = /(?:<mark\s+class="(?:hl-|srh-hl-)(yellow|green|blue|purple|orange)">([\s\S]*?)<\/mark>|<u\s+class="(?:hl-|srh-hl-)(?:red|underline)">([\s\S]*?)<\/u>)(?:\s*\^?\[💭\s*([^\]]+)\])?/gi;
    while ((m = htmlRegex.exec(content)) !== null) {
      const isMark = !!m[1];
      const color = (isMark ? m[1] : "red").toLowerCase();
      const text = (isMark ? m[2] : m[3]).trim();
      const note = m[4] ? m[4].trim() : null;
      if (text) {
        list.push({ color, text, note });
      }
    }
    return list;
  }

  jumpToHighlight(text) {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!activeView) return;
    const editor = activeView.editor;
    const doc = editor.getValue();
    const idx = doc.indexOf(text);
    if (idx !== -1) {
      const pos = editor.offsetToPos(idx);
      editor.setCursor(pos);
      editor.scrollIntoView({ from: pos, to: pos }, true);
      editor.focus();
    }
  }
}

// --- Bases 可折叠分组视图 (srh-fold) ---
// Obsidian 原生 Bases 的 cards/table/list 视图都是「模型驱动 + 绝对定位」的虚拟滚动，
// 分组标题不可点击折叠。这里通过官方 registerBasesView API 注册一个普通文档流的视图，
// 以 groupBy 属性（播客候选 = 日期）为类别把条目归到一天一组，默认全部收起，
// 点日期标题展开即可看到当天每一期的标题/节目/嘉宾/时长/摘要/原文链接。
// 展开状态持久化到插件设置，随重载保留。

function srhResolveImageUrl(app, url, sourceFilePath) {
  if (!url) return '';
  const s = String(url).trim().replace(/^\[\[/, '').replace(/\]\]$/, '').replace(/^\"|\"$/g, '');
  if (!s) return '';
  if (/^(https?:|\/\/|data:)/i.test(s)) {
    return s.startsWith('//') ? 'https:' + s : s;
  }
  try {
    const file = app.metadataCache.getFirstLinkpathDest(s, sourceFilePath || '') || app.vault.getAbstractFileByPath(s);
    if (file) {
      return app.vault.getResourcePath(file);
    }
    if (app.vault.adapter && typeof app.vault.adapter.getResourcePath === 'function') {
      return app.vault.adapter.getResourcePath(s);
    }
  } catch (e) {}
  return '';
}

function srhExtractThumbnail(app, fm, file) {
  let thumb = srhToText(fm.thumbnail_url) || srhToText(fm.cover) || srhToText(fm.cover_url) || srhToText(fm.image) || srhToText(fm.banner);
  if (!thumb && fm.url) {
    const u = String(fm.url);
    const m = u.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/i);
    if (m && m[1]) {
      thumb = 'https://img.youtube.com/vi/' + m[1] + '/hqdefault.jpg';
    }
  }
  return srhResolveImageUrl(app, thumb, file && file.path);
}

const SRH_FOLD_VIEW_TYPE = "srh-fold";

function srhPad2(n) {
  return String(n).padStart(2, "0");
}

// 把 frontmatter 里的日期值（Obsidian 会把 ISO 日期解析成 Date 对象）统一成 YYYY-MM-DD
function srhDateKey(v) {
  if (v instanceof Date) {
    return `${v.getFullYear()}-${srhPad2(v.getMonth() + 1)}-${srhPad2(v.getDate())}`;
  }
  const s = v === undefined || v === null ? "" : String(v).trim();
  const m = s.match(/^\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : s;
}

function srhToText(v) {
  if (v === undefined || v === null) return "";
  if (Array.isArray(v)) return v.map((x) => srhToText(x)).filter(Boolean).join(", ");
  if (v instanceof Date) return srhDateKey(v);
  return String(v);
}

// ⚠️ 关键：Bases 的视图配置里，属性 id 是「带前缀」的。
// obsidian.asar 里的 xY() 实现：
//   e.startsWith("note."|"formula."|"file.") ? e : ("file"===e ? "file.file" : "note."+e)
// 所以 config.groupBy.property 拿到的是 "note.date"，
// config.getOrder() 拿到的是 ["note.title_zh", ...]。
// 不剥前缀就会变成 fm["note.date"] === undefined —— 所有条目掉进「未分组」。
function srhPropKey(p) {
  if (p === undefined || p === null) return "";
  if (typeof p === "string") {
    return p.startsWith("note.") ? p.slice(5) : p;
  }
  if (typeof p === "object") {
    const t = p.type;
    const n = p.name;
    if (typeof n === "string") return t && t !== "note" ? t + "." + n : n;
    if (typeof p.toString === "function") {
      const s = String(p);
      if (s && s !== "[object Object]") return s.startsWith("note.") ? s.slice(5) : s;
    }
  }
  return "";
}

function srhIsNoteProp(k) {
  return !!k && !k.startsWith("file.") && !k.startsWith("formula.");
}

// 播出时间：frontmatter 里是未加引号的 ISO → Obsidian 会解析成 Date 对象。
// 用 UTC 取值可以原样还原成 frontmatter 里写的那个时刻（避免本地时区偏移带来的误读）。
function srhFormatTime(v) {
  if (v instanceof Date) {
    return (
      `${v.getUTCFullYear()}-${srhPad2(v.getUTCMonth() + 1)}-${srhPad2(v.getUTCDate())} ` +
      `${srhPad2(v.getUTCHours())}:${srhPad2(v.getUTCMinutes())} UTC`
    );
  }
  const s = srhToText(v);
  if (!s) return "";
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
  if (!m) return s;
  let tz = "";
  if (/Z$/.test(s) || /\+00:00$/.test(s)) tz = " UTC";
  else {
    const z = s.match(/([+-]\d{2}:?\d{2})$/);
    if (z) tz = " " + z[1];
  }
  return `${m[1]} ${m[2]}${tz}`;
}

// 把「核心观点」的 markdown bullet 列表解析成 [{head, body}]
// 每条形如：- **加粗结论** 后面的解释
function srhParsePoints(md, limit) {
  const out = [];
  const text = String(md || "");
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("- ") && !line.startsWith("* ")) continue;
    let rest = line.slice(2).trim();
    let head = "";
    const m = rest.match(/^\*\*(.+?)\*\*([\s\S]*)$/);
    if (m) {
      head = m[1].trim();
      rest = m[2].trim();
    }
    const body = rest.replace(/\*\*/g, "").trim();
    if (head || body) out.push({ head, body });
    if (limit && out.length >= limit) break;
  }
  return out;
}

// 从笔记正文里抽出某个 `## 小节` 的内容（到下一个 `## ` 为止）
function srhExtractSection(body, heading) {
  const lines = String(body || "").split("\n");
  const out = [];
  let inside = false;
  for (const ln of lines) {
    if (ln.startsWith("## ")) {
      inside = ln.trim() === "## " + heading;
      continue;
    }
    if (inside) out.push(ln);
  }
  return out.join("\n").trim();
}

class SrhFoldBasesView extends Component {
  constructor(controller, containerEl, plugin) {
    super();
    this.controller = controller;
    this.plugin = plugin || null;
    this.app = controller.app;
    this.type = SRH_FOLD_VIEW_TYPE;
    this.rootEl = containerEl.createDiv({ cls: "srh-fold-container", attr: { tabIndex: 0 } });
    // 记录「已展开」的日期分组；默认为空 = 全部收起
    this.expanded = new Set(this.loadExpanded());
    this.groupEls = new Map();
    this.bodyCache = new Map(); // path -> 正文「核心观点」小节文本
    this.loadToken = 0;
  }

  // --- 展开状态持久化（存到插件设置，随重载保留）---
  loadExpanded() {
    try {
      const v = this.plugin && this.plugin.settings && this.plugin.settings.foldExpanded;
      return Array.isArray(v) ? v : [];
    } catch (e) {
      return [];
    }
  }

  saveExpanded() {
    try {
      if (!this.plugin || !this.plugin.settings) return;
      this.plugin.settings.foldExpanded = Array.from(this.expanded);
      void this.plugin.saveSettings();
    } catch (e) {
      /* 忽略持久化失败，不影响使用 */
    }
  }

  // --- Bases 视图生命周期 ---
  onload() {
    if (this.data) this.render();
  }

  onunload() {}

  onResize() {}

  // 核心观点在笔记正文的 `## 核心观点` 小节里（1~2KB 的 bullet 列表，
  // 放 frontmatter 会把换行压掉、也会撑爆 Properties 面板）。
  // 所以先并发读一遍正文缓存下来，再渲染；读失败不影响其余字段。
  async onDataUpdated() {
    const token = (this.loadToken = (this.loadToken || 0) + 1);
    try {
      await this.loadBodies();
    } catch (e) {
      this.bodyCache = new Map();
    }
    if (token !== this.loadToken) return; // 期间数据又变了，放弃这次
    this.render();
  }

  async loadBodies() {
    const cache = new Map();
    const entries = (this.data && this.data.data) || [];
    const vault = this.app && this.app.vault;
    if (!vault || typeof vault.cachedRead !== "function") {
      this.bodyCache = cache;
      return;
    }
    await Promise.all(
      entries.map((e) => {
        const f = e && e.file;
        if (!f) return Promise.resolve();
        return vault.cachedRead(f).then(
          (txt) => {
            cache.set(f.path, srhExtractSection(txt, "核心观点"));
          },
          () => {}
        );
      })
    );
    this.bodyCache = cache;
  }

  focus() {
    this.rootEl.focus({ preventScroll: true });
  }

  getEphemeralState() {
    return {};
  }

  setEphemeralState() {}

  // 结果菜单会调用，必须存在
  getViewActions() {
    return [];
  }

  copyToClipboard() {
    const txt = (this.data?.data || [])
      .map((e) => e && e.file && e.file.path)
      .filter(Boolean)
      .join("\n");
    try {
      void navigator.clipboard.writeText(txt);
      new Notice(`已复制 ${txt ? txt.split("\n").length : 0} 条笔记路径`);
    } catch (e) {
      new Notice("复制失败");
    }
  }

  exportTable() {
    const rows = [["标题", "节目", "嘉宾", "播出日期", "路径"]];
    for (const e of this.data?.data || []) {
      const f = e && e.file;
      if (!f) continue;
      const fm = this.fmOf(f);
      rows.push([
        srhToText(fm.title_zh) || f.basename,
        srhToText(fm.channel),
        srhToText(fm.guest),
        srhToText(fm.date),
        f.path
      ]);
    }
    const csv = rows
      .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    return { toCSV: () => csv };
  }

  // 数据更新钩子：控制器赋值 this.data / this.config 后调用
  onDataUpdated() {
    this.render();
  }

  // --- 取值辅助 ---
  fmOf(file) {
    try {
      const cache = this.app.metadataCache.getFileCache(file);
      return (cache && cache.frontmatter) || {};
    } catch (e) {
      return {};
    }
  }

  groupProp() {
    const key = srhPropKey(this.config && this.config.groupBy && this.config.groupBy.property);
    return srhIsNoteProp(key) ? key : "date";
  }

  orderProps() {
    try {
      const o = this.config && this.config.getOrder && this.config.getOrder();
      if (Array.isArray(o) && o.length) {
        const keys = o.map(srhPropKey).filter(srhIsNoteProp);
        if (keys.length) return keys;
      }
    } catch (e) {
      /* 回退到默认 */
    }
    return ["title_zh", "tldr_zh", "channel", "guest"];
  }

  // --- 渲染 ---
  render() {
    try {
      this.renderInner();
    } catch (e) {
      console.error("[skywork-reading-hub] 折叠视图渲染失败", e);
      this.rootEl.empty();
      this.rootEl.createDiv({
        cls: "srh-fold-error",
        text: "折叠视图渲染失败：" + (e && e.message ? e.message : String(e))
      });
      this.renderFallback();
    }
  }

  renderFallback() {
    const box = this.rootEl.createDiv({ cls: "srh-fold-fallback" });
    for (const e of this.data?.data || []) {
      const f = e && e.file;
      if (!f) continue;
      const a = box.createEl("a", { text: f.basename });
      a.onclick = (ev) => {
        ev.preventDefault();
        this.app.workspace.openLinkText(f.path, "", false);
      };
    }
  }

  renderInner() {
    this.rootEl.empty();
    this.groupEls = new Map();
    const entries = (this.data && this.data.data) || [];
    if (entries.length === 0) {
      this.rootEl.createDiv({ cls: "srh-fold-empty", text: "没有符合条件的笔记" });
      return;
    }

    const gp = this.groupProp();
    const order = this.orderProps();
    const titleProp = order[0] || "title_zh";
    const tldrProp = order.includes("tldr_zh") ? "tldr_zh" : null;
    const metaProps = order.filter((p) => p !== titleProp && p !== tldrProp && p !== "duration_min");

    // 按 groupBy 属性分组；组顺序沿用 data.data 的既有排序（控制器已按 sort 排好）
    const groups = new Map();
    for (const entry of entries) {
      const f = entry && entry.file;
      if (!f) continue;
      const fm = this.fmOf(f);
      const key = srhDateKey(fm[gp]) || "未分组";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ file: f, fm });
    }

    // 顶部工具条
    const bar = this.rootEl.createDiv({ cls: "srh-fold-toolbar" });
    bar.createSpan({ cls: "srh-fold-total", text: `共 ${entries.length} 集 · ${groups.size} 天` });
    const btnAll = bar.createEl("button", { cls: "srh-fold-btn", text: "全部展开" });
    btnAll.onclick = () => {
      this.expanded = new Set(groups.keys());
      this.saveExpanded();
      this.syncAllGroupStates();
    };
    const btnNone = bar.createEl("button", { cls: "srh-fold-btn", text: "全部收起" });
    btnNone.onclick = () => {
      this.expanded.clear();
      this.saveExpanded();
      this.syncAllGroupStates();
    };

    const list = this.rootEl.createDiv({ cls: "srh-fold-list" });

    for (const [key, items] of groups) {
      const isOpen = this.expanded.has(key);
      const groupEl = list.createDiv({ cls: "srh-fold-group" + (isOpen ? " is-open" : "") });

      const head = groupEl.createDiv({ cls: "srh-fold-heading" });
      const caret = head.createSpan({ cls: "srh-fold-caret", text: isOpen ? "▾" : "▸" });
      head.createSpan({ cls: "srh-fold-key", text: key });
      head.createSpan({ cls: "srh-fold-count", text: `${items.length} 集` });
      // 点击只切换 class，不整树重绘 —— 保住滚动位置
      head.onclick = () => {
        if (this.expanded.has(key)) this.expanded.delete(key);
        else this.expanded.add(key);
        this.saveExpanded();
        this.syncGroupState(key);
      };

      const body = groupEl.createDiv({ cls: "srh-fold-body" });
      for (const { file, fm } of items) {
        const card = body.createDiv({ cls: "srh-fold-card" });

        // 1. Top: Large cover thumbnail (16:9)
        const thumbSrc = srhExtractThumbnail(this.app, fm, file);
        const thumbWrap = card.createDiv({ cls: "srh-fold-card-thumb-wrap" });
        if (thumbSrc) {
          const img = thumbWrap.createEl("img", { cls: "srh-fold-card-thumb" });
          img.src = thumbSrc;
          img.loading = "lazy";
          img.alt = srhToText(fm[titleProp]) || file.basename;
          img.onerror = () => {
            img.remove();
            const ph = thumbWrap.createDiv({ cls: "srh-fold-card-thumb-placeholder" });
            ph.createSpan({ text: "🎙️", cls: "srh-ph-icon" });
            ph.createSpan({ text: srhToText(fm.channel) || "Podcast", cls: "srh-ph-text" });
          };
        } else {
          const ph = thumbWrap.createDiv({ cls: "srh-fold-card-thumb-placeholder" });
          ph.createSpan({ text: "🎙️", cls: "srh-ph-icon" });
          ph.createSpan({ text: srhToText(fm.channel) || "Podcast", cls: "srh-ph-text" });
        }
        thumbWrap.onclick = (ev) => {
          ev.preventDefault();
          this.app.workspace.openLinkText(file.path, "", false);
        };

        // 2. Card Content Area
        const cardBody = card.createDiv({ cls: "srh-fold-card-body" });

        // Title
        const titleEl = cardBody.createDiv({ cls: "srh-fold-card-title" });
        const link = titleEl.createEl("a", {
          text: srhToText(fm[titleProp]) || srhToText(fm.title) || file.basename
        });
        link.onclick = (ev) => {
          ev.preventDefault();
          this.app.workspace.openLinkText(file.path, "", false);
        };

        // Meta (Channel · Duration · 原文 ↗)
        const meta = cardBody.createDiv({ cls: "srh-fold-card-meta" });
        const metaLeft = meta.createDiv({ cls: "srh-fold-card-meta-text" });
        const bits = metaProps.map((p) => srhToText(fm[p])).filter(Boolean);
        const dur = srhToText(fm.duration_min);
        if (dur) bits.push(`${dur} 分钟`);
        if (fm.transcript) bits.push("有转录");
        metaLeft.setText(bits.join(" · "));

        const url = srhToText(fm.url);
        if (url) {
          const src = meta.createEl("a", { cls: "srh-fold-src", text: "原文 ↗" });
          src.setAttribute("href", url);
          src.onclick = (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            window.open(url, "_blank");
          };
        }

        // TLDR Summary
        if (tldrProp) {
          const tldr = srhToText(fm[tldrProp]);
          if (tldr) cardBody.createDiv({ cls: "srh-fold-card-tldr", text: tldr });
        }

        card.onclick = (ev) => {
          if (ev.target.tagName === "A" || ev.target.closest("a")) return;
          ev.preventDefault();
          this.app.workspace.openLinkText(file.path, "", false);
        };
      }

      this.groupEls.set(key, { groupEl, caret });
    }
  }

  // 只更新某个分组的展开态（不重建 DOM）
  syncGroupState(key) {
    const rec = this.groupEls.get(key);
    if (!rec) return;
    const open = this.expanded.has(key);
    rec.groupEl.toggleClass("is-open", open);
    rec.caret.setText(open ? "▾" : "▸");
  }

  syncAllGroupStates() {
    for (const key of this.groupEls.keys()) this.syncGroupState(key);
  }
}

// --- Main Plugin Class ---
class SkyworkReadingHubPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    // Register CodeMirror 6 Live Preview tag hider
    this.registerEditorExtension(livePreviewTagHider);

    // Register Reading Companion Sidebar View
    this.registerView(
      VIEW_TYPE_READING_COMPANION,
      (leaf) => new ReadingCompanionView(leaf, this)
    );

    // Register custom Bases view: 可折叠分组
    // 原生 Bases 的 cards/table/list 分组标题不可折叠，这里用官方 API 注册一个可折叠视图。
    try {
      const ok = this.registerBasesView(SRH_FOLD_VIEW_TYPE, {
        name: "折叠分组",
        icon: "lucide-layers",
        factory: (controller, containerEl) => new SrhFoldBasesView(controller, containerEl, this)
      });
      if (!ok) console.warn("[skywork-reading-hub] Bases 核心插件未启用，折叠视图未注册");
    } catch (e) {
      console.warn("[skywork-reading-hub] registerBasesView 不可用（Obsidian 版本过旧？）", e);
    }

    // Register selection bubble & top reading status bar
    this.bubble = new SelectionBubble(this.app, () => this.settings);
    this.statusBar = new ReadingStatusBar(this.app, () => this.settings);

    // Register single Ribbon Icon for Reading Hub
    this.addRibbonIcon("book-open", "知识阅读台 (Reading Hub)", async () => {
      await this.openReadingHub();
    });

    // Workspace change listeners for status bar
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf?.view instanceof MarkdownView) {
          this.statusBar.updateForView(leaf.view);
        }
      })
    );
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (view && view.file === file) {
          this.statusBar.updateForView(view);
        }
      })
    );
    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (view && view.file?.path === file.path) {
          this.statusBar.updateForView(view);
        }
      })
    );

    this.app.workspace.onLayoutReady(() => {
      for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
        if (leaf.view instanceof MarkdownView) {
          this.statusBar.updateForView(leaf.view);
        }
      }
    });

    // Commands
    this.addCommand({
      id: "open-reading-hub",
      name: "打开知识阅读台 (Reading Hub)",
      callback: async () => {
        await this.openReadingHub();
      }
    });

    this.addCommand({
      id: "toggle-reading-companion",
      name: "切换右侧阅读助手抽屉",
      callback: async () => {
        await this.activateCompanionView();
      }
    });

    this.addCommand({
      id: "mark-read",
      name: "标记当前笔记为「已读」",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (file && file.extension === "md") {
          if (!checking) void this.updateCurrentReadStatus(file, "已读");
          return true;
        }
        return false;
      }
    });

    this.addCommand({
      id: "mark-starred",
      name: "标记当前笔记为「精读」",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (file && file.extension === "md") {
          if (!checking) void this.updateCurrentReadStatus(file, "精读");
          return true;
        }
        return false;
      }
    });

    this.addCommand({
      id: "mark-unread",
      name: "标记当前笔记为「未读」",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (file && file.extension === "md") {
          if (!checking) void this.updateCurrentReadStatus(file, "未读");
          return true;
        }
        return false;
      }
    });

    this.addCommand({
      id: "mark-skip",
      name: "标记当前笔记为「跳过」",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (file && file.extension === "md") {
          if (!checking) void this.updateCurrentReadStatus(file, "跳过");
          return true;
        }
        return false;
      }
    });

    this.addSettingTab(new SkyworkReadingHubSettingTab(this.app, this));
  }

  async openReadingHub() {
    // 1. Open reading-hub.md in main workspace
    const hubPath = "reading-hub.md";
    let file = this.app.vault.getAbstractFileByPath(hubPath);
    if (!file) {
      // Look for reading-hub.base or any reading-hub file
      const files = this.app.vault.getFiles();
      file = files.find((f) => f.name === "reading-hub.md" || f.name === "reading-hub.base");
    }

    if (file instanceof TFile) {
      let leaf = this.app.workspace.getLeavesOfType("markdown").find(
        (l) => l.view instanceof MarkdownView && l.view.file?.path === file.path
      );
      if (!leaf) {
        leaf = this.app.workspace.getLeaf(false);
        await leaf.openFile(file);
      }
      this.app.workspace.setActiveLeaf(leaf, { focus: true });
    } else {
      new Notice("未找到 reading-hub.md 入口文件");
    }

    // 2. Open / reveal right companion view
    await this.activateCompanionView();
  }

  async activateCompanionView() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_READING_COMPANION);
    if (leaves.length > 0) {
      this.app.workspace.revealLeaf(leaves[0]);
      return;
    }
    const rightLeaf = this.app.workspace.getRightLeaf(false);
    if (rightLeaf) {
      await rightLeaf.setViewState({
        type: VIEW_TYPE_READING_COMPANION,
        active: true
      });
      this.app.workspace.revealLeaf(rightLeaf);
    }
  }

  async updateCurrentReadStatus(file, status) {
    try {
      await this.app.fileManager.processFrontMatter(file, (fm) => {
        fm["read_status"] = status;
      });
      new Notice(`已更新阅读状态为：${status}`);
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (view && view.file === file) {
        this.statusBar.updateForView(view);
      }
    } catch (e) {
      new Notice("更新状态失败");
    }
  }

  onunload() {
    this.bubble?.destroy();
    this.statusBar?.destroy();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

// --- Settings Tab ---
class SkyworkReadingHubSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "知识阅读台 (Reading Hub) 交互设置" });

    new Setting(containerEl)
      .setName("启用选词划线工具条")
      .setDesc("在笔记中用鼠标选中文本时，自动在上方浮现多色划线、批注与 AI 解读气泡。")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.enableSelectionBubble).onChange(async (val) => {
          this.plugin.settings.enableSelectionBubble = val;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("启用正文顶部状态条")
      .setDesc("在每篇笔记顶部展示极简类别标签、未读/已读/精读/跳过药丸按钮及 AI 总结快捷操作。")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.enableStatusBar).onChange(async (val) => {
          this.plugin.settings.enableStatusBar = val;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("黄色划线首选语法")
      .setDesc("黄色划线保存为 Markdown 原生 ==文本== 还是 HTML 标签。推荐 Markdown，与原生渲染最兼容。")
      .addDropdown((d) =>
        d
          .addOption("markdown", "Markdown 语法 (==文本==) [推荐]")
          .addOption("html", "HTML 标签 (<mark>)")
          .setValue(this.plugin.settings.highlightFormat)
          .onChange(async (val) => {
            this.plugin.settings.highlightFormat = val;
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl("h3", { text: "🤖 AI 深度速读配置" });

    new Setting(containerEl)
      .setName("AI API URL")
      .setDesc("OpenAI 兼容接口基地址（如 DeepSeek、SiliconFlow、Kimi、OpenAI 等）。")
      .addText((t) =>
        t
          .setPlaceholder("https://api.deepseek.com/v1")
          .setValue(this.plugin.settings.aiApiUrl)
          .onChange(async (val) => {
            this.plugin.settings.aiApiUrl = val.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("AI API Key")
      .setDesc("调用 AI 接口的 API Key。")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setPlaceholder("sk-...")
          .setValue(this.plugin.settings.aiApiKey)
          .onChange(async (val) => {
            this.plugin.settings.aiApiKey = val.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("AI 模型名称")
      .setDesc("如 deepseek-chat, gpt-4o-mini, gemini-2.0-flash 等。")
      .addText((t) =>
        t
          .setPlaceholder("deepseek-chat")
          .setValue(this.plugin.settings.aiModel)
          .onChange(async (val) => {
            this.plugin.settings.aiModel = val.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("自动将总结插入笔记文首")
      .setDesc("开启后，点击总结将直接以 Callout 形式插入正文顶部，无需手动确认。")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autoInsertSummary).onChange(async (val) => {
          this.plugin.settings.autoInsertSummary = val;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("AI 总结提示词 (Prompt)")
      .setDesc("生成结构化总结的系统提示词。")
      .addTextArea((t) => {
        t.inputEl.rows = 6;
        t.inputEl.style.width = "100%";
        t.setValue(this.plugin.settings.aiPrompt).onChange(async (val) => {
          this.plugin.settings.aiPrompt = val;
          await this.plugin.saveSettings();
        });
      });
  }
}
