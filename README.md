# WhatsApp Export Viewer

A fully client-side web app that renders WhatsApp chat exports (messages + media) in a WhatsApp Web-like UI.

## Features

- Load one or many WhatsApp export ZIPs (`.zip`)
- Load extracted export folders (`Load Folder` using directory picker)
- Drag and drop ZIPs or extracted files/folders into the window
- Conversation list with chat search
- Message search inside selected conversation
- Sender selection (`Me`) to control incoming/outgoing bubble alignment
- Inline media rendering for images, video, audio, stickers, and document links
- Handles multiline messages and common attachment markers:
  - `<Media omitted>`
  - `filename.ext (file attached)`
  - `<attached: filename.ext>`

## Run

No backend required.

1. Open `index.html` in a modern browser.
2. Click `Load ZIP(s)` or `Load Folder`.
3. Select a conversation in the left sidebar.

## Privacy

All parsing/rendering happens locally in your browser. No upload is performed by this app.
