# r*e*ads

A minimal RSVP speed reader — installable as a PWA, no backend, no dependencies.

![reads logo](icons/icon-192.png)

## Features

- **RSVP reading** — word-by-word display with ORP (Optimal Recognition Point) focal letter highlighted in red
- **Local library** — save multiple texts, all stored in `localStorage`
- **File import** — drag-and-drop or browse `.txt`, `.md`, `.pdf`, and `.epub` files
- **EPUB chapters** — chapter-aware import with a simple chapter picker in the reader
- **Bundled helpers** — JSZip and PDF.js are vendored in `libs/` so the app is self-contained
- **Reading stats** — position, elapsed time, estimated time remaining
- **Resume** — picks up exactly where you left off
- **Themes** — dark (default) and warm cream light mode
- **Installable PWA** — works fully offline after first load
- **Keyboard shortcuts** — see Settings tab

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Space` | Play / pause |
| `← →` | Skip ±5 words |
| `Shift ← →` | Skip sentence |
| `↑ ↓` | ±50 wpm |
| `R` | Restart current text |

## Deploy to GitHub Pages

1. Push this folder to a GitHub repository
2. Go to **Settings → Pages**
3. Set source to **Deploy from branch → main → / (root)**
4. Visit `https://<your-username>.github.io/<repo-name>/`

The app will be installable from the browser's address bar or the "Add to Home Screen" prompt on mobile.

## Local development

Just open `index.html` directly, or run any static server:

```bash
npx serve .
# or
python3 -m http.server 8080
```

> **Note:** The service worker requires HTTPS or `localhost` to register. On GitHub Pages this works automatically.

## File structure

```
reads/
├── index.html      # App shell
├── style.css       # All styles
├── app.js          # All logic
├── libs/           # Vendored JSZip and PDF.js browser builds
├── sw.js           # Service worker (offline support)
├── manifest.json   # PWA manifest
└── icons/
    ├── icon-32.png
    ├── icon-192.png
    └── icon-512.png
```

## Customisation

- **WPM range**: edit `min`/`max` on the `#wpm-slider` in `index.html`
- **Chunk sizes**: extend the `<select>` in settings and the `tokenize()` logic in `app.js`
- **Fonts**: swap the Google Fonts import in `index.html` and update the font-family variables in `style.css`
