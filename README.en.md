[中文](./README.md)

# Echo360 Subtitle Translator

This is a Chrome extension for `Echo360`. It automatically reads `.vtt` subtitle files from the page and displays bilingual subtitles during video playback.

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

## Usage

1. Load the project as a Chrome extension.
2. Open an Echo360 video page.
3. Wait for the extension to detect subtitles and start translating.
4. Click the extension icon in the browser toolbar to open the popup.
5. Select a target language from the dropdown and click `Translate`.
6. Play the video or jump to any timestamp. The extension will prioritize subtitles near the current playback position.

## Project Structure

- `manifest.json`: Chrome extension configuration
- `content-script.js`: page integration, subtitle rendering, and video event handling
- `translator-engine.js`: translation engine for concurrency, queues, caching, retries, and language switching
- `popup/`: popup UI files and styles

## Development Notes

- After changing extension code, reload the extension from `chrome://extensions/`.
- After reloading the extension, refresh the Echo360 page as well so the old content script is replaced.
