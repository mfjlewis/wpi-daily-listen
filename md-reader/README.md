# MD Reader

A small installable web app for reading, editing, highlighting and exporting Markdown files on a phone.
Everything runs in the browser and documents are stored only on the device.

**Features**
- Read mode: fonts (Serif, Sans, Book, Clear, Mono), text size, line spacing, margins, left/justified text
- Themes: Auto, Light, Sepia, Gray, Dark, Black, or any custom background color
- Find in document, with match count and next/previous
- Highlighter in four colors: select text and tap **Highlight**, tap a highlight to remove it.
  Highlights are saved in the Markdown (`==text==` or `<mark class="hl-green">…</mark>`), so they carry into exports
- Edit mode with a formatting toolbar; autosaves
- Multiple documents, each reopening where you left off
- Export to **Word (.docx)**, **PDF**, **HTML** and **Markdown**, by download or the phone's share sheet
- Works offline once loaded; on Android you can share a `.md` file straight to the installed app

**Put it on your home screen**
- iPhone: open the page in Safari, tap Share, then **Add to Home Screen**
- Android: open the page in Chrome, tap ⋮, then **Install app** / **Add to Home screen**

When updating the app files, bump `VERSION` in `sw.js` so installed copies pick up the change.
