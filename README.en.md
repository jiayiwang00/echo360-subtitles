# Echo360 Subtitle Translator

English | [简体中文](./README.md)

**This is a Chrome extension for `Echo360`. It automatically reads `.vtt` subtitle files from the page and auto translate displays bilingual subtitles during video playback.**

Note: This code was generated with AI assistance [ChatGPT/Codex]

## Features

- Automatically detects the current page's video and subtitle resources
- Translates subtitles into bilingual on-screen captions
- Supports multiple target languages:
  Chinese (Simplified), Chinese (Traditional), Spanish, French, German, Japanese, Korean, Russian, Arabic, and Portuguese
- Lets users switch the target language from the extension popup
- Lets users choose free Google translation or use DeepSeek with an API key and model name
- Retries DeepSeek up to 10 consecutive failures before stopping and showing an API key/model warning, while Google continues retrying
- Hides the DeepSeek API key by default with an optional visibility toggle
- Uses small DeepSeek batches near playback and larger background batches to reduce requests and token usage
- Uses a dedicated single-subtitle fast lane after seeking instead of waiting for an in-progress background batch
- Uses caching to reduce duplicate translation requests
- Persists translations locally so refreshing or reopening subtitles does not consume API tokens again
- Optimized for random seeking with priority queues and concurrent translation workers
- Shows a simplified translation progress view in the popup

## Supported Site

This extension currently only runs on `https://echo360.net.au/*`.

## Installation

1. Download or clone this project locally.
2. Open Chrome and go to `chrome://extensions/`.
3. Turn on `Developer mode` in the top-right corner.
4. Click `Load unpacked`.
5. Select this project folder, making sure it contains `manifest.json`.
