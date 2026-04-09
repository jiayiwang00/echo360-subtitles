[English](./README.en.md)

# Echo360 Subtitle Translator

这是一个用于 `Echo360` 的 Chrome 扩展。它会自动读取页面上的 `.vtt` 字幕文件，并在视频播放时显示双语字幕。

Note: This code was generated with AI assistance [ChatGPT/Codex]

## 功能

- 自动查找当前页面的视频和字幕资源
- 将字幕翻译为双语显示
- 支持多语言目标翻译：
  简体中文、繁体中文、西班牙语、法语、德语、日语、韩语、俄语、阿拉伯语、葡萄牙语
- 在扩展 popup 中切换目标语言
- 使用缓存减少重复翻译请求
- 针对随机跳转做了优先队列和并发优化，优先翻译当前时间点附近字幕
- 在 popup 中显示精简版翻译进度

## 适用范围

当前扩展只在 `https://echo360.net.au/*` 页面下生效。

## 安装方式

1. 下载或克隆本项目到本地。
2. 打开 Chrome 浏览器，在地址栏输入 `chrome://extensions/`。
3. 打开右上角的“开发者模式”。
4. 点击“加载已解压的扩展程序”。
5. 选择当前项目目录，确保其中包含 `manifest.json`。

## 使用方式

1. 将项目作为 Chrome 扩展加载。
2. 打开 Echo360 视频页面。
3. 等待扩展自动读取字幕并开始翻译。
4. 点击浏览器工具栏中的扩展图标，打开 popup。
5. 在下拉框中选择目标语言，点击“翻译”。
6. 播放视频或跳转到任意时间点，扩展会优先翻译当前附近的字幕。

## 项目结构

- `manifest.json`：Chrome 扩展配置
- `content-script.js`：页面集成、字幕渲染、视频事件监听
- `translator-engine.js`：翻译调度引擎，包括并发、队列、缓存、重试和语言切换逻辑
- `popup/`：扩展 popup 界面和样式

## 开发提示

- 修改扩展代码后，需要在 `chrome://extensions/` 中重新加载扩展。
- 重新加载扩展后，建议同时刷新 Echo360 视频页面，确保旧的 content script 被替换。
