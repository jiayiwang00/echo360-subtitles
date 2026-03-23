(async function() {

  // -------------------------------
  // 1️⃣ 自动寻找 VTT URL
  // -------------------------------
  function findVttUrl() {
    const track = document.querySelector("track[kind='subtitles'], track[kind='captions']");
    if (track && track.src) {
      console.log("✅ 从 <track> 找到 VTT:", track.src);
      return track.src;
    }

    const entries = performance.getEntriesByType("resource");
    for (let e of entries) {
      if (e.name.includes(".vtt")) {
        console.log("✅ 从 network 捕获 VTT:", e.name);
        return e.name;
      }
    }

    return null;
  }

  let vttUrl = findVttUrl();

  if (!vttUrl) {
    console.log("⏳ 等待视频加载后再试...");
    await new Promise(r => setTimeout(r, 3000));
    vttUrl = findVttUrl();
  }

  if (!vttUrl) {
    console.error("❌ 未找到 VTT");
    return;
  }

  // ================================
  // 2️⃣ 等待 video
  // ================================
  function waitForVideo() {
    return new Promise(resolve => {
      const i = setInterval(() => {
        const v = document.querySelector("video");
        if (v) {
          clearInterval(i);
          resolve(v);
        }
      }, 500);
    });
  }

  const video = await waitForVideo();

  // ================================
  // 3️⃣ UI 字幕层
  // ================================
  const div = document.createElement("div");
  div.style.position = "fixed";
  div.style.bottom = "10%";
  div.style.left = "50%";
  div.style.transform = "translateX(-50%)";
  div.style.color = "white";
  div.style.fontSize = "24px";
  div.style.background = "rgba(0,0,0,0.6)";
  div.style.padding = "8px 16px";
  div.style.borderRadius = "8px";
  div.style.zIndex = 2147483647;
  div.style.maxWidth = "60%";
  div.style.textAlign = "center";
  document.body.appendChild(div);

  // ================================
  // 4️⃣ VTT 解析
  // ================================
  function toSec(t) {
    const [h,m,s] = t.split(":");
    return (+h)*3600 + (+m)*60 + parseFloat(s);
  }

  function parseVTT(vtt) {
    const lines = vtt.split("\n");
    const subs = [];
    let cur = null;

    for (let line of lines) {
      line = line.trim();
      if (!line || line.startsWith("WEBVTT") || line.startsWith("NOTE")) continue;

      if (line.includes("-->")) {
        const [s,e] = line.split(" --> ");
        cur = { start: toSec(s), end: toSec(e), text: "" };
        subs.push(cur);
      } else if (cur) {
        cur.text += line.replace(/<[^>]+>/g,"") + " ";
      }
    }
    return subs;
  }

  // ================================
  // 5️⃣ 翻译模块（核心）
  // ================================
  class LRUCache {
    constructor(limit = 200) {
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
        const first = this.map.keys().next().value;
        this.map.delete(first);
      }
    }
  }

  const cache = new LRUCache(200);
  let lastRequestTime = 0;
  const MIN_INTERVAL = 500;
  let requestId = 0;

  async function googleTranslate(text) {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetch(url);
    const data = await res.json();
    return data[0].map(x => x[0]).join("");
  }

  async function translateSafe(text, apply) {
    if (!text) return;

    // 缓存
    const cached = cache.get(text);
    if (cached) {
      apply(cached);
      return;
    }

    // 限流
    const now = Date.now();
    const wait = Math.max(0, MIN_INTERVAL - (now - lastRequestTime));
    await new Promise(r => setTimeout(r, wait));
    lastRequestTime = Date.now();

    const id = ++requestId;

    try {
      const result = await googleTranslate(text);

      if (id !== requestId) return; // 防乱序

      cache.set(text, result);
      apply(result);

    } catch(e) {
      console.warn("翻译失败", e);
    }
  }

  // ================================
  // 6️⃣ 加载字幕
  // ================================
  let subtitles = [];

  try {
    const res = await fetch(vttUrl);
    const text = await res.text();
    subtitles = parseVTT(text);
    console.log("✅ 字幕加载完成", subtitles);
  } catch(e) {
    console.error("❌ VTT 加载失败", e);
    return;
  }

  // ================================
  // 7️⃣ 实时字幕 + 翻译
  // ================================
  let lastText = "";

  setInterval(() => {
    const t = video.currentTime;
    const sub = subtitles.find(s => t >= s.start && t <= s.end);

    if (!sub) {
      div.innerText = "";
      lastText = "";
      return;
    }

    const original = sub.text.trim();

    if (original !== lastText) {
      lastText = original;

      // 先显示英文（不卡）
      div.innerText = original;

      // 再翻译（异步）
      translateSafe(original, (zh) => {
        // 防止已经换句
        if (lastText === original) {
          div.innerText = original + "\n" + zh;
        }
      });
    }

  }, 100);

})();