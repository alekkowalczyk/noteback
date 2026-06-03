# Icons

No PNG icons are bundled in this scaffold, and **`manifest.json` intentionally
omits the `icons` / `action.default_icon` keys** so the extension loads unpacked
without missing-file errors.

Before publishing, add real PNGs here and re-add the keys to `manifest.json`:

```jsonc
"icons": {
  "16": "icons/icon-16.png",
  "32": "icons/icon-32.png",
  "48": "icons/icon-48.png",
  "128": "icons/icon-128.png"
},
"action": {
  "default_title": "Noteback",
  "default_popup": "src/popup/popup.html",
  "default_icon": {
    "16": "icons/icon-16.png",
    "32": "icons/icon-32.png"
  }
}
```

Suggested art: a highlighter mark over a document with a small return/back arrow
("note it → send it back").
