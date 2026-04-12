# Echo360 Subtitle Translator

简体中文 | [English](./README.en.md)

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

1. 下载或克隆本项目到本地
2. 打开 Chrome 浏览器，在地址栏输入 `chrome://extensions/`
3. 打开右上角的“开发者模式”
4. 点击“加载已解压的扩展程序”
5. 选择当前项目目录，确保其中包含 `manifest.json`