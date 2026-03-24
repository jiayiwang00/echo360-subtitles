(async function () {
  const CONFIG = {
    MIN_INTERVAL: 500,
    CACHE_LIMIT: 500,
    LOOKAHEAD_COUNT: 3,
    UI_UPDATE_INTERVAL: 100,
    PROGRESS_UPDATE_INTERVAL: 300,
    MATCH_TOLERANCE: 0.15,
    INITIAL_RETRY_DELAY: 3000,
    PRIORITY_FORWARD: 20,
    PRIORITY_BACKWARD: 5
  };

  if (window.__subtitleTranslatorRunning) {
    console.warn("脚本已在运行。先执行 window.__subtitleTranslatorCleanup() 再重跑。");
    return;
  }
  window.__subtitleTranslatorRunning = true;

  function cleanup() {
    window.__subtitleTranslatorRunning = false;
    try { clearInterval(window.__subtitleTimer); } catch {}
    try { clearInterval(window.__progressTimer); } catch {}
    try { window.__subtitleWorkerAbort = true; } catch {}
    try { document.getElementById("__subtitle_bilingual_overlay")?.remove(); } catch {}
    try { document.getElementById("__subtitle_translation_progress")?.remove(); } catch {}
    try { window.__subtitleVideo?.removeEventListener("seeked", window.__subtitleOnSeeked); } catch {}
    delete window.__subtitleTranslatorCleanup;
    delete window.__subtitleTimer;
    delete window.__progressTimer;
    delete window.__subtitleVideo;
    delete window.__subtitleOnSeeked;
    console.log("🧹 已清理脚本");
  }

  window.__subtitleTranslatorCleanup = cleanup;

  function findVttUrl() {
    const track = document.querySelector("track[kind='subtitles'], track[kind='captions']");
    if (track?.src) {
      console.log("✅ 从 <track> 找到 VTT:", track.src);
      return track.src;
    }

    const entries = performance.getEntriesByType("resource");

    for (const e of entries) {
      if (e.name.includes("captions") && e.name.endsWith(".vtt")) {
        console.log("✅ 从 network 找到 captions VTT:", e.name);
        return e.name;
      }
    }

    for (const e of entries) {
      if (e.name.endsWith(".vtt")) {
        console.log("✅ 从 network 找到 VTT:", e.name);
        return e.name;
      }
    }

    return null;
  }

  function waitForVideo(timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const timer = setInterval(() => {
        const v = document.querySelector("video");
        if (v) {
          clearInterval(timer);
          resolve(v);
          return;
        }
        if (Date.now() - start > timeoutMs) {
          clearInterval(timer);
          reject(new Error("等待 video 超时"));
        }
      }, 300);
    });
  }

  function toSec(t) {
    const [h, m, s] = t.split(":");
    return (+h) * 3600 + (+m) * 60 + parseFloat(s);
  }

  function normalizeText(text) {
    return (text || "").replace(/\s+/g, " ").trim();
  }

  function parseVTT(vtt) {
    const lines = vtt.split("\n");
    const subs = [];
    let cur = null;

    for (let rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith("WEBVTT") || line.startsWith("NOTE")) continue;

      if (line.includes("-->")) {
        const [start, end] = line.split(" --> ").map(s => s.trim());
        cur = {
          start: toSec(start),
          end: toSec(end),
          text: "",
          zh: null,
          status: "pending", // pending | queued | translating | done | failed
          error: null
        };
        subs.push(cur);
      } else if (cur) {
        const clean = line.replace(/<[^>]+>/g, "");
        cur.text += clean + " ";
      }
    }

    for (const s of subs) {
      s.text = normalizeText(s.text);
    }

    return subs.filter(s => s.text);
  }

  class LRUCache {
    constructor(limit = 500) {
      this.limit = limit;
      this.map = new Map();
    }
    get(key) {
      if (!this.map.has(key)) return null;
      const val = this.map.get(key);
      this.map.delete(key);
      this.map.set(key, val);
      return val;
    }
    set(key, val) {
      if (this.map.has(key)) this.map.delete(key);
      this.map.set(key, val);
      if (this.map.size > this.limit) {
        const firstKey = this.map.keys().next().value;
        this.map.delete(firstKey);
      }
    }
    has(key) {
      return this.map.has(key);
    }
    size() {
      return this.map.size;
    }
  }

  function percent(n, d) {
    if (!d) return "0.0%";
    return ((n / d) * 100).toFixed(1) + "%";
  }

  function elapsedMs(ms) {
    const s = Math.floor(ms / 1000);
    const mm = String(Math.floor(s / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    return `${mm}:${ss}`;
  }

  let vttUrl = findVttUrl();
  if (!vttUrl) {
    console.log("⏳ 首次未找到 VTT，等待后重试...");
    await new Promise(r => setTimeout(r, CONFIG.INITIAL_RETRY_DELAY));
    vttUrl = findVttUrl();
  }

  if (!vttUrl) {
    console.error("❌ 未找到 VTT");
    cleanup();
    return;
  }

  let video;
  try {
    video = await waitForVideo();
    window.__subtitleVideo = video;
    console.log("✅ 找到 video:", video);
  } catch (e) {
    console.error("❌", e);
    cleanup();
    return;
  }

  const subtitleDiv = document.createElement("div");
  subtitleDiv.id = "__subtitle_bilingual_overlay";
  Object.assign(subtitleDiv.style, {
    position: "fixed",
    left: "50%",
    bottom: "10%",
    transform: "translateX(-50%)",
    zIndex: "2147483647",
    maxWidth: "70%",
    padding: "10px 16px",
    color: "#fff",
    background: "rgba(0,0,0,0.68)",
    borderRadius: "10px",
    fontSize: "22px",
    lineHeight: "1.45",
    textAlign: "center",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    boxShadow: "0 6px 24px rgba(0,0,0,0.35)",
    pointerEvents: "none",
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
  });
  document.body.appendChild(subtitleDiv);

  const progressDiv = document.createElement("div");
  progressDiv.id = "__subtitle_translation_progress";
  Object.assign(progressDiv.style, {
    position: "fixed",
    top: "16px",
    right: "16px",
    zIndex: "2147483647",
    width: "360px",
    padding: "12px 14px",
    color: "#fff",
    background: "rgba(0,0,0,0.78)",
    borderRadius: "10px",
    fontSize: "13px",
    lineHeight: "1.5",
    whiteSpace: "pre-wrap",
    boxShadow: "0 6px 24px rgba(0,0,0,0.35)",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
  });
  document.body.appendChild(progressDiv);

  const cache = new LRUCache(CONFIG.CACHE_LIMIT);

  let subtitles = [];
  try {
    const res = await fetch(vttUrl);
    const text = await res.text();
    subtitles = parseVTT(text);
    console.log("✅ 字幕加载完成，共", subtitles.length, "条");
  } catch (e) {
    console.error("❌ VTT 加载失败", e);
    cleanup();
    return;
  }

  if (!subtitles.length) {
    console.error("❌ VTT 解析后为空");
    cleanup();
    return;
  }

  const stats = {
    total: subtitles.length,
    translated: 0,
    failed: 0,
    cacheHit: 0,
    requested: 0,
    currentQueueLength: 0,
    startedAt: Date.now(),
    lastTranslatedText: "",
    activeText: "",
    workerRunning: false,
    allDone: false,
    lastPriorityIndex: -1
  };

  const textToIndices = new Map();
  subtitles.forEach((sub, index) => {
    const key = sub.text;
    if (!textToIndices.has(key)) textToIndices.set(key, []);
    textToIndices.get(key).push(index);
  });

  let lastRequestTime = 0;
  window.__subtitleWorkerAbort = false;

  async function googleTranslate(text) {
    const url =
      `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data?.[0]?.map(x => x[0]).join("") || "";
  }

  async function translateRateLimited(text) {
    const now = Date.now();
    const wait = Math.max(0, CONFIG.MIN_INTERVAL - (now - lastRequestTime));
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastRequestTime = Date.now();
    stats.requested += 1;
    return googleTranslate(text);
  }

  const queue = [];
  const queuedTexts = new Set();
  const inFlightTexts = new Set();
  const scheduledUniqueTexts = new Set();

  function markAllSameText(text, updater) {
    const indices = textToIndices.get(text) || [];
    for (const i of indices) updater(subtitles[i], i);
  }

  function applyTranslationToAll(text, zh) {
    markAllSameText(text, sub => {
      sub.zh = zh;
      sub.status = "done";
      sub.error = null;
    });
  }

  function markFailedForAll(text, err) {
  markAllSameText(text, sub => {
    if (sub.status !== "done") {
      sub.status = "pending"; // ❗不是 failed
      sub.error = String(err?.message || err);
    }
  });

  // ❗延迟重新入队（避免疯狂请求）
  setTimeout(() => {
    enqueueText(text, false);
  }, 2000);
}

  function reprioritizeQueuedText(text) {
    const normalized = normalizeText(text);
    if (!normalized) return false;
    const idx = queue.indexOf(normalized);
    if (idx <= 0) return idx === 0;
    queue.splice(idx, 1);
    queue.unshift(normalized);
    stats.currentQueueLength = queue.length;
    return true;
  }

  function enqueueText(text, priority = false) {
    const normalized = normalizeText(text);
    if (!normalized) return;

    if (cache.has(normalized)) {
      const cached = cache.get(normalized);
      stats.cacheHit += 1;
      applyTranslationToAll(normalized, cached);
      return;
    }

    if (inFlightTexts.has(normalized)) return;

    if (queuedTexts.has(normalized)) {
      if (priority) reprioritizeQueuedText(normalized);
      return;
    }

    queuedTexts.add(normalized);

    markAllSameText(normalized, sub => {
      if (sub.status === "pending" || sub.status === "failed") {
        sub.status = "queued";
      }
    });

    if (priority) queue.unshift(normalized);
    else queue.push(normalized);

    stats.currentQueueLength = queue.length;
  }

  async function workerLoop() {
    if (stats.workerRunning) return;
    stats.workerRunning = true;

    while (window.__subtitleTranslatorRunning && !window.__subtitleWorkerAbort) {
      const nextText = queue.shift();
      stats.currentQueueLength = queue.length;

      if (!nextText) {
        if (!stats.allDone) {
          const allResolved = subtitles.every(s => s.status === "done" || s.status === "failed");
          if (allResolved) stats.allDone = true;
        }
        await new Promise(r => setTimeout(r, 200));
        continue;
      }

      queuedTexts.delete(nextText);
      inFlightTexts.add(nextText);

      markAllSameText(nextText, sub => {
        if (sub.status !== "done") sub.status = "translating";
      });

      try {
        const zh = await translateRateLimited(nextText);
        cache.set(nextText, zh);
        applyTranslationToAll(nextText, zh);
        stats.lastTranslatedText = nextText;
      } catch (e) {
        console.warn("翻译失败:", nextText, e);
        markFailedForAll(nextText, e);
      } finally {
        inFlightTexts.delete(nextText);
        stats.translated = subtitles.filter(s => s.status === "done").length;
        stats.failed = subtitles.filter(s => s.status === "failed").length;
        stats.currentQueueLength = queue.length;
      }
    }

    stats.workerRunning = false;
  }

  let cursor = 0;

  function getSubtitleIndexByTime(t) {
    const tol = CONFIG.MATCH_TOLERANCE;

    while (cursor < subtitles.length - 1 && t > subtitles[cursor].end + tol) cursor++;
    while (cursor > 0 && t < subtitles[cursor].start - tol) cursor--;

    const s = subtitles[cursor];
    if (s && t >= s.start - tol && t <= s.end + tol) return cursor;

    for (let i = Math.max(0, cursor - 5); i <= Math.min(subtitles.length - 1, cursor + 5); i++) {
      const x = subtitles[i];
      if (t >= x.start - tol && t <= x.end + tol) {
        cursor = i;
        return i;
      }
    }

    return -1;
  }

  function getBestTranslation(sub) {
    if (!sub || !sub.text) return null;
    if (sub.zh) return sub.zh;

    const cached = cache.get(sub.text);
    if (cached) {
      sub.zh = cached;
      sub.status = "done";
      return cached;
    }

    return null;
  }

  function renderSubtitle(sub) {
  if (!sub) {
    subtitleDiv.innerText = "";
    return;
  }

  const en = sub.text || "";
  const zh = getBestTranslation(sub);

  if (zh) {
    subtitleDiv.innerText = `${en}\n${zh}`;
  } else if (sub.status === "failed") {
    // ❗关键：失败时不要一直 loading
    subtitleDiv.innerText = `${en}\n（翻译失败）`;
  } else {
    subtitleDiv.innerText = `${en}\n⏳ 正在翻译…`;
  }
}

  function requestImmediateTranslationForIndex(index) {
    const sub = subtitles[index];
    if (!sub || !sub.text) return;

    if (sub.zh) return;

    const cached = cache.get(sub.text);
    if (cached) {
      sub.zh = cached;
      sub.status = "done";
      return;
    }

    if (sub.status === "translating") return;

    enqueueText(sub.text, true);
  }

  function boostLookahead(index) {
    for (let i = 0; i <= CONFIG.LOOKAHEAD_COUNT; i++) {
      const targetIndex = index + i;
      const s = subtitles[targetIndex];
      if (!s || !s.text) continue;

      if (s.zh) continue;

      const cached = cache.get(s.text);
      if (cached) {
        s.zh = cached;
        s.status = "done";
        continue;
      }

      enqueueText(s.text, i === 0);
    }
  }

  function enqueueWindowAround(index, forward = CONFIG.PRIORITY_FORWARD, backward = CONFIG.PRIORITY_BACKWARD) {
    if (index < 0) return;

    const current = subtitles[index];
    if (current?.text) enqueueText(current.text, true);

    for (let i = 1; i <= forward; i++) {
      const s = subtitles[index + i];
      if (s?.text) enqueueText(s.text, true);
    }

    for (let i = 1; i <= backward; i++) {
      const s = subtitles[index - i];
      if (s?.text) enqueueText(s.text, true);
    }
  }

  function enqueueRemainingFrom(index) {
    const orderedTexts = [];
    const localSeen = new Set();

    for (let i = index; i < subtitles.length; i++) {
      const text = subtitles[i]?.text;
      if (text && !localSeen.has(text)) {
        localSeen.add(text);
        orderedTexts.push(text);
      }
    }

    for (let i = 0; i < index; i++) {
      const text = subtitles[i]?.text;
      if (text && !localSeen.has(text)) {
        localSeen.add(text);
        orderedTexts.push(text);
      }
    }

    for (const text of orderedTexts) {
      if (!scheduledUniqueTexts.has(text)) {
        scheduledUniqueTexts.add(text);
        enqueueText(text, false);
      }
    }
  }

  const startIndex = getSubtitleIndexByTime(video.currentTime);
  if (startIndex !== -1) {
    console.log("✅ 从当前播放位置开始建立优先队列，index =", startIndex);
    enqueueWindowAround(startIndex, CONFIG.PRIORITY_FORWARD, CONFIG.PRIORITY_BACKWARD);
    enqueueRemainingFrom(startIndex);
    stats.lastPriorityIndex = startIndex;
  } else {
    console.log("⚠️ 当前时间没匹配到字幕，退回全文入队");
    for (const text of textToIndices.keys()) {
      scheduledUniqueTexts.add(text);
      enqueueText(text, false);
    }
  }

  workerLoop();

  window.__subtitleOnSeeked = () => {
    const idx = getSubtitleIndexByTime(video.currentTime);
    console.log("⏩ 用户跳转到:", video.currentTime, "index:", idx);

    if (idx !== -1) {
      enqueueWindowAround(idx, CONFIG.PRIORITY_FORWARD, CONFIG.PRIORITY_BACKWARD);
      enqueueRemainingFrom(idx);
      stats.lastPriorityIndex = idx;
    }
  };

  video.addEventListener("seeked", window.__subtitleOnSeeked);

  let lastIndex = -1;

  window.__subtitleTimer = setInterval(() => {
    if (!window.__subtitleTranslatorRunning) return;

    const t = video.currentTime;
    const index = getSubtitleIndexByTime(t);

    if (index === -1) {
      subtitleDiv.innerText = "";
      return;
    }

    const sub = subtitles[index];
    stats.activeText = sub.text;

    if (index !== lastIndex) {
      lastIndex = index;
      requestImmediateTranslationForIndex(index);
      boostLookahead(index);
    }

    renderSubtitle(sub);
  }, CONFIG.UI_UPDATE_INTERVAL);

  window.__progressTimer = setInterval(() => {
    if (!window.__subtitleTranslatorRunning) return;

    const uniqueTotal = textToIndices.size;
    const uniqueDone = [...textToIndices.keys()].filter(text => cache.has(text)).length;

    progressDiv.innerText =
`Bilingual Subtitle Translator
--------------------------------
VTT: ${vttUrl.slice(0, 72)}${vttUrl.length > 72 ? "..." : ""}
总字幕条数: ${stats.total}
唯一文本数: ${uniqueTotal}

已翻译: ${stats.translated}/${stats.total} (${percent(stats.translated, stats.total)})
唯一完成: ${uniqueDone}/${uniqueTotal} (${percent(uniqueDone, uniqueTotal)})
失败: ${stats.failed}
缓存命中: ${stats.cacheHit}
已发送请求: ${stats.requested}
队列剩余: ${queue.length}
进行中: ${inFlightTexts.size}
缓存大小: ${cache.size()}
当前优先中心: ${stats.lastPriorityIndex}
运行时间: ${elapsedMs(Date.now() - stats.startedAt)}

当前字幕:
${stats.activeText ? stats.activeText.slice(0, 90) : "(无)"}

最近完成:
${stats.lastTranslatedText ? stats.lastTranslatedText.slice(0, 90) : "(无)"}

状态: ${stats.allDone ? "✅ 全部翻译完成" : "⏳ 后台持续翻译中..."}`;
  }, CONFIG.PROGRESS_UPDATE_INTERVAL);

  console.log("✅ 脚本已启动");
  console.log("ℹ️ 停止脚本：window.__subtitleTranslatorCleanup()");
})();