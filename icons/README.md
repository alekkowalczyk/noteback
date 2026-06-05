# Icons

`icon128.png` (128×128, RGBA) is the bundled extension icon. It's wired into
`manifest.json` in two places:

```jsonc
"icons": {
  "128": "icons/icon128.png"          // chrome://extensions + Web Store listing
},
"action": {
  "default_title": "Noteback",
  "default_popup": "src/popup/popup.html",
  "default_icon": {
    "128": "icons/icon128.png"        // the toolbar button users click
  }
}
```

Chrome auto-downscales the single 128 to whatever smaller size it needs (16/32/48
for the toolbar and the extensions management page). That's fine to ship.

## Optional: crisper small sizes

A 128 downscaled to a 16px toolbar icon can look slightly soft. For sharper small
renders, add dedicated PNGs and list them alongside the 128 in **both** the
`icons` and `action.default_icon` maps:

```jsonc
"icons": {
  "16": "icons/icon-16.png",
  "32": "icons/icon-32.png",
  "48": "icons/icon-48.png",
  "128": "icons/icon128.png"
}
```

Art direction: a highlighter mark over a document with a small return/back arrow
("note it → send it back").
