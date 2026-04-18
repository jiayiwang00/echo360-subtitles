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
- Uses caching to reduce duplicate translation requests
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