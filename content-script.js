(async function() {

  // -------------------------------
  // 1️⃣ 自动寻找 VTT URL
  // -------------------------------
  function findVttUrl() {
    // 方法1：从 <track> 标签找
    const track = document.querySelector("track[kind='subtitles'], track[kind='captions']");
    if (track && track.src) {
      console.log("✅ 从 <track> 找到 VTT:", track.src);
      return track.src;
    }

    // 方法2：扫描 performance 网络请求
    const entries = performance.getEntriesByType("resource");
    for (let e of entries) {
      if (e.name.includes(".vtt")) {
        console.log("✅ 从 network 捕获 VTT:", e.name);
        return e.name;
      }
    }

    console.warn("❌ 没找到 VTT");
    return null;
  }

  let vttUrl = findVttUrl();

  if (!vttUrl) {
    console.log("⏳ 等待视频加载后再试...");
    await new Promise(r => setTimeout(r, 3000));
    vttUrl = findVttUrl();
  }

  if (!vttUrl) {
    console.error("❌ 最终仍未找到 VTT");
    return;
  }

  // -------------------------------
  // 2️⃣ 等待 video
  // -------------------------------
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

  // -------------------------------
  // 3️⃣ 创建字幕层
  // -------------------------------
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
  document.body.appendChild(div);

  // -------------------------------
  // 4️⃣ 解析 VTT
  // -------------------------------
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

  // -------------------------------
  // 5️⃣ 加载字幕
  // -------------------------------
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

  // -------------------------------
  // 6️⃣ 实时显示
  // -------------------------------
  let last = "";

  setInterval(() => {
    const t = video.currentTime;
    const sub = subtitles.find(s => t >= s.start && t <= s.end);

    if (!sub) {
      div.innerText = "";
      last = "";
      return;
    }

    const txt = sub.text.trim();
    if (txt !== last) {
      div.innerText = txt;
      last = txt;
    }

  }, 100);

})();