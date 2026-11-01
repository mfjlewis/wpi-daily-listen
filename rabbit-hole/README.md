# Rabbit Hole (prototype)

A research archive you can listen to. Save a link (in any language) and it:

1. **Downloads the article** and keeps a snapshot of the original text and page.
2. **Pulls the citation details**: title (original + English), author, outlet, date, language, URL, date saved.
3. **Asks the Wayback Machine** to archive the page, so there's a citable copy if the original disappears.
4. **Translates it** paragraph by paragraph, keeping the original next to the translation.
5. **Writes a listening version** (abbreviations spelled out, page junk removed).
6. **Tags it** (people, places, organizations, topics) and **files it into a research thread** automatically.
7. **Plays it aloud**, remembering where you stopped. A whole thread can play back to back.

You can also add **screenshots** of passages you liked. Claude reads the text in the screenshot, works out which saved article and paragraph it came from, and adds a highlight with the screenshot attached. **Search** works by meaning, in English, across every language you've saved. Every source has a **Chicago-style citation** ready to copy.

## Where your data lives

Everything is stored as plain files in `DATA_DIR`:

```
data/items/<id>/item.md          readable: citation, summary, highlights, original + translation
data/items/<id>/item.json        same data, machine-readable
data/items/<id>/snapshot.html    the page as downloaded
data/items/<id>/screenshots/     your screenshots
data/threads/<id>.json           research threads and your notes
```

If the app goes away, the research doesn't. There's also a one-click JSON export in the library.

## Run it on your computer

Needs Node.js 20 or newer.

```bash
cd rabbit-hole
npm install
ANTHROPIC_API_KEY=sk-ant-... APP_TOKEN=pick-a-passphrase npm start
# open http://localhost:3000
```

Without `ANTHROPIC_API_KEY` it runs in **demo mode**. Everything works, but translation, tags, summaries and search are stand-ins and screenshots can't be read.

## Put it online (so it's on your phone)

Any host that runs a Node app or a Docker container **with a persistent disk** will work, for example Render, Railway or Fly.io. Set:

| Setting | Value |
|---|---|
| `ANTHROPIC_API_KEY` | your key from console.anthropic.com |
| `APP_TOKEN` | a passphrase you'll type once per device |
| `DATA_DIR` | a path on the persistent disk (e.g. `/data`) |

Then open the site in Chrome on Android, sign in, and choose **⋮ → Add to Home screen / Install app**. Once installed, **Rabbit Hole shows up in Android's share sheet**: share any article from Chrome, and it's saved.

## Things to know

- **Listening uses your device's built-in voices.** They're free, and Android's Google voices are decent. The app keeps the screen awake while playing, because Android pauses browser speech when the screen turns off. Better voices and real audio files that keep playing with the screen off are the next upgrade.
- **Translations are machine translations.** The app labels them that way and always keeps the original one tap away. Check the original before quoting.
- **Some sites block automated downloads** or are paywalled. The item then asks you to paste the article text; the link is still kept for the citation.
- **Cost:** each article is a few Claude calls (citation/tagging, translation, filing). Opus 5.5 is the default; set `RH_MODEL` to use a different model.

## Tests

```bash
npm test
```
