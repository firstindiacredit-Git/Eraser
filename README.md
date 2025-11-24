# Realtime Paste Pad

A small React + Vite experience where multiple people can paste and type together and see the text update instantly across every open browser tab.

## Features

- Shared textarea that syncs keystrokes and paste events through Socket.IO.
- Presence hint that lights up whenever someone else is typing.
- Character counter so you know how large the shared payload is.

## Getting started

```bash
npm install
npm run server   # starts the Socket.IO relay on :4000
npm run dev      # starts the Vite dev server on :5173
```

Prefer one command? Use:

```bash
npm run dev:full
```

## Configuration

- The client expects the relay at `http://localhost:4000`. Override it with `VITE_SOCKET_URL` for builds/previews.
- You can also change the relay port via `VITE_SOCKET_PORT` or `PORT` when running `npm run server`.

## Scripts

- `npm run dev` – Vite dev server.
- `npm run server` – Socket.IO relay.
- `npm run dev:full` – run both in parallel (uses `concurrently`).
- `npm run build` – production build of the UI.
- `npm run preview` – preview the production build.
- `npm run lint` – ESLint.

## Notes

- The relay keeps only the latest text in memory; restart it to clear content.
- Authentication, history, and persistence are intentionally omitted—plug in your own backend if needed.
