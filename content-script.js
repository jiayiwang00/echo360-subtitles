(async function() {
  // -------------------------------
  // 1️⃣ 配置 VTT 链接
  // -------------------------------
  const vttUrl = "https://captions.echo360.net.au/b370837d-e9e1-4f4a-ade4-6e6c5d8d4460/captions-19a08dff-db9d-4a19-aa8a-36104a05cdad-20260312061153.vtt"; // 替换成你抓到的 VTT 链接

  // -------------------------------
  // 2️⃣ 全局变量
  // -------------------------------
  let subtitles = [];
  let lastText = "";

  // -------------------------------
  // 3️⃣ 等待视频加载
  // -------------------------------
  function waitForVideo() {
    return new Promise(resolve => {
      const interval = setInterval(() => {
        const video = document.querySelector("video");
        if (video) {
          clearInterval(interval);
          resolve(video);
        }
      }, 500);
    });
  }

  const video = await waitForVideo();
  console.log("视频加载完成:", video);

  // -------------------------------
  // 4️⃣ 创建字幕层
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
  div.style.textAlign = "center";
  div.style.maxWidth = "60%";
  div.style.wordWrap = "break-word";
  div.style.zIndex = 2147483647;
  document.body.appendChild(div);

  // -------------------------------
  // 5️⃣ 工具函数：时间转换
  // -------------------------------
  function toSec(t) {
    const [h, m, s] = t.split(":");
    return (+h)*3600 + (+m)*60 + parseFloat(s);
  }

  // -------------------------------
  // 6️⃣ 解析 VTT 文件
  // -------------------------------
  function parseVTT(vtt) {
    const lines = vtt.split("\n");
    const subs = [];
    let current = null;
    for (let line of lines) {
      line = line.trim();
      if (!line || line.startsWith("WEBVTT") || line.startsWith("NOTE")) continue;
      if (line.includes("-->")) {
        const [start, end] = line.split(" --> ");
        current = { start: toSec(start), end: toSec(end), text: "" };
        subs.push(current);
      } else if (current) {
        current.text += line.replace(/<[^>]+>/g,"") + " ";
      }
    }
    return subs;
  }

  // -------------------------------
  // 7️⃣ 加载并解析 VTT
  // -------------------------------
  try {
    const res = await fetch(vttUrl);
    const text = await res.text();
    subtitles = parseVTT(text);
    console.log("字幕解析完成", subtitles);
  } catch(err) {
    console.error("VTT 加载失败", err);
    return;
  }

  // -------------------------------
  // 8️⃣ 实时显示英文字幕
  // -------------------------------
  setInterval(() => {
    const t = video.currentTime;
    const sub = subtitles.find(s => t >= s.start && t <= s.end);
    if (!sub) {
      div.innerText = ""; // 没有字幕时清空
      lastText = "";
      return;
    }
    const newText = sub.text.trim();
    if (newText !== lastText) {
      div.innerText = newText;
      lastText = newText;
    }
  }, 100);

})();