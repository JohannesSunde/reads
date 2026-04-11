# r*e*ads

A minimal RSVP speed reader, installable as a PWA, offline-first, with optional invite-only Supabase sync.

![reads logo](icons/icon-192.png)

## Features

- **RSVP reading** - word-by-word display with ORP (Optimal Recognition Point) focal letter highlighted in red
- **Local library** - save multiple texts directly in the browser
- **Optional cloud sync** - invited users can sync library items, noteworthy passages, and reading progress across devices
- **File import** - drag-and-drop or browse `.txt`, `.md`, `.pdf`, and `.epub` files
- **EPUB chapters** - chapter-aware import with a simple chapter picker in the reader
- **Bundled helpers** - JSZip and PDF.js are vendored in `libs/` so the app is self-contained
- **Reading stats** - position, elapsed time, estimated time remaining
- **Resume** - picks up exactly where you left off
- **Themes** - dark (default) and warm cream light mode
- **Installable PWA** - works fully offline after first load
- **Keyboard shortcuts** - see Settings tab

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Space` | Play / pause |
| `← →` | Skip ±5 words |
| `Shift ← →` | Skip sentence |
| `↑ ↓` | ±50 wpm |
| `M` | Mark current sentence as noteworthy |
| `R` | Restart current text |

## Deploy to GitHub Pages

1. Push this folder to a GitHub repository
2. Go to **Settings -> Pages**
3. Set source to **Deploy from branch -> main -> / (root)**
4. Visit `https://<your-username>.github.io/<repo-name>/`

The app will be installable from the browser's address bar or the "Add to Home Screen" prompt on mobile.

## Optional Supabase sync

The app still works fully locally without any backend configuration.

To enable invite-only cloud sync:

1. Apply the SQL migration in `supabase/migrations/20260411_init_reads_sync.sql`
2. Disable self-signup in Supabase Auth
3. Add your GitHub Pages URL to the allowed Auth URLs
4. Put your Supabase publishable key in `supabase-config.js`
5. Invite users manually from the Supabase dashboard

See `supabase/README.md` for the recommended beta cap and operating model.

## Local development

Just open `index.html` directly, or run any static server:

```bash
npx serve .
# or
python3 -m http.server 8080
```

> Note: The service worker requires HTTPS or `localhost` to register. On GitHub Pages this works automatically.

## File structure

```text
reads/
├── index.html      # App shell
├── style.css       # All styles
├── app.js          # All logic
├── libs/           # Vendored JSZip and PDF.js browser builds
├── supabase/       # SQL migration and setup notes
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
