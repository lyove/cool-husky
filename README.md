<h1 align="center">🚀 CoolHusky</h1>
<p align="center">Web Extension to download audio, videos and images from website</p>
<div align="center">
  <a href="https://github.com/lyove/cool-husky/blob/master/LICENSE">
    <img src="https://img.shields.io/github/license/lyove/cool-husky.svg" alt="LICENSE" />
  </a>
</div>

<hr />

❤️ it? ⭐️ it on [GitHub](https://github.com/lyove/cool-husky) about it.

## Features

- Cross Browser Support (Web-Extensions API)
- Browser Tailored Manifest generation
- Vite for fast builds and HMR
- Automatic build on code changes
- Auto packs browser specific build files
- SASS/SCSS styling with CSS Modules
- TypeScript by default
- ES6 modules support
- React 19 with automatic JSX runtime
- ESLint 9 flat config with Prettier

## Tech Stack

- **Bundler**: [Vite](https://vitejs.dev/) 7
- **UI**: [React](https://react.dev/) 19
- **Language**: [TypeScript](https://www.typescriptlang.org/) 5.9
- **Styling**: SCSS with CSS Modules
- **Linting**: ESLint 9 (flat config) + Prettier
- **Manifest**: localized in [`config/vite-plugin-wext-manifest/`](./config/vite-plugin-wext-manifest/)

## Browser Support

This starter uses **Manifest V3** for all browsers.

| Chrome | Firefox | Opera | Edge | Brave |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 88+ (Jan 2021)                                                                                | 112+ (Apr 2023)                                                                                  | 74+ (Chromium-based)                                                                       | 88+ (Chromium-based)                                                                    | Latest (Chromium-based)                                                                    |

> **Note**: Firefox 112+ is required for Manifest V3 support with ES modules in background scripts.
>
> Need to support older Firefox versions? See [Firefox MV2 Guide](docs/FIREFOX_MV2.md) for using Manifest V2 with Firefox.


## 🚀 Quick Start

Ensure you have [Node.js](https://nodejs.org) 20 or later installed.

Then run the following:

```bash
# Install dependencies
npm install

# Start development server
npm run dev:chrome    # For Chrome
npm run dev:firefox   # For Firefox

# Build for production
npm run build:chrome  # Build Chrome extension
npm run build:firefox # Build Firefox addon
npm run build         # Build for all browsers
```

## Project Structure

```
source/
├── Background/        # Service worker (Chrome MV3) / Background script (Firefox)
├── ContentScript/     # Content scripts (injected into web pages)
├── Popup/             # Extension popup UI
├── Options/           # Options page UI
├── components/        # Shared React components
├── styles/            # Global styles and variables
├── types/             # TypeScript type definitions
├── utils/             # Utility functions
├── public/            # Static assets (icons, etc.)
└── manifest.json      # Extension manifest template
```

## Development

### Loading the Extension

#### Chrome

1. Navigate to `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select `extension/chrome` directory

#### Firefox

1. Navigate to `about:debugging`
2. Click "This Firefox"
3. Click "Load Temporary Add-on"
4. Select `extension/firefox/manifest.json`

### Content Scripts

Content scripts are automatically bundled as IIFE (Immediately Invoked Function Expression) to ensure compatibility with the browser's content script execution environment, which doesn't support ES modules.

### Browser-Specific Manifest

The manifest uses vendor prefixes to generate browser-specific configurations:

```json
{
  "__chrome__name": "My Chrome Extension",
  "__firefox__name": "My Firefox Addon",
  "__chrome|firefox__description": "Works on both!"
}
```

See the localized plugin at [`config/vite-plugin-wext-manifest/`](./config/vite-plugin-wext-manifest/) for more details.

## Scripts

| Script              | Description                              |
| ------------------- | ---------------------------------------- |
| `npm run dev:chrome`  | Start dev server for Chrome            |
| `npm run dev:firefox` | Start dev server for Firefox           |
| `npm run build:chrome`| Build production Chrome extension      |
| `npm run build:firefox`| Build production Firefox addon        |
| `npm run build`       | Build for all browsers                 |
| `npm run lint`        | Run ESLint                             |
| `npm run lint:fix`    | Run ESLint with auto-fix               |

## Linting & TypeScript Config

- ESLint & Prettier Configuration - localized in [`config/eslint/`](./config/eslint/)
- TypeScript Configuration - localized in [`tsconfig.base.json`](./tsconfig.base.json)

## Bugs

Please file an issue [here](https://github.com/lyove/cool-husky/issues/new) for bugs, missing documentation, or unexpected behavior.

## License

MIT © [Lyove](https://github.com/lyove/cool-husky)
