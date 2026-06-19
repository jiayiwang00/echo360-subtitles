# Echo360 Subtitle Translator

简体中文 | [English](./README.en.md)

**这是一个用于 `Echo360` 的 Chrome 扩展。它会自动读取页面的字幕文件，并在视频播放时自动翻译并显示双语字幕。**

Note: This code was generated with AI assistance [ChatGPT/Codex]

## 功能

- 自动查找当前页面的视频和字幕资源
- 将字幕翻译为双语显示
- 支持多语言目标翻译：
  简体中文、繁体中文、西班牙语、法语、德语、日语、韩语、俄语、阿拉伯语、葡萄牙语
- 在扩展 popup 中切换目标语言
- 在 popup 中选择免费的 Google 翻译，或填写 API Key 和模型名称后使用 DeepSeek 翻译
- DeepSeek 请求连续失败时最多重试 10 次，第 10 次仍失败才停止并在 popup 提示检查 API Key 或模型；Google 翻译仍会自动重试
- DeepSeek API Key 默认隐藏，可通过输入框旁的小眼睛切换显示
- DeepSeek 对当前字幕使用小批次、后台字幕使用大批次，减少请求次数和 Token 消耗
- 拖动进度条时使用独立的单条翻译快车道，不等待正在处理的后台大批次
- 使用缓存减少重复翻译请求
- 翻译结果会持久保存在浏览器本地，刷新或重新打开同一字幕时无需再次消耗 API Token
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
