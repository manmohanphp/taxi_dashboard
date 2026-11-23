# TaxiGo Admin Dashboard

React and Vite frontend for TaxiGo administration, including drivers, verification, rides, customers, communications, pricing, and service areas.

## Prerequisites

- Node.js compatible with Vite 6: Node 18, 20, or 22 and later. Node 22 is a suitable choice; this project does not pin a version.
- npm, included with Node.js.
- A running TaxiGo backend and an admin account for features that require API access.

Check `node --version` and `npm --version`. If you already use nvm, select Node 22 with `nvm install 22` and `nvm use 22`. If `nvm` is not found, install a current Node.js release using your preferred Node installer or version manager, then open a new terminal and check the versions again.

## Install and configure

From this directory:

```sh
npm ci
```

`npm ci` installs from `package-lock.json` and replaces the existing `node_modules` directory. To retain the existing directory and allow npm to update the lockfile when resolving dependencies, use `npm install` instead.

Create `.env.local` with your backend base URL:

```dotenv
VITE_TAXIGO_API_BASE_URL=http://localhost:<backend-port>
```

Replace the placeholder with your local backend's actual port. For a development backend, use its authorized base URL instead. Restart Vite after changing this file. If the variable is omitted, the frontend falls back to `https://taxi.retradviews.com`. Vite exposes `VITE_` variables to browser code; do not put secrets in them.

## Run locally

```sh
npm run dev
```

Open http://localhost:5173. The server uses strict port 5173, so it fails if the port is occupied. To use another port:

```sh
npm run dev -- --port 5174
```

Stop the server with Ctrl+C.

## Tests, build and preview

```sh
npm test
npm run build
npm run preview
```

Vite prints the preview URL. Building creates `dist/`.

## Troubleshooting

- **`nvm: command not found`:** nvm is not available in this shell. Install Node by your preferred method, or install and configure nvm before using its commands.
- **Old Node or npm:** Check both versions in a new terminal. Node 10 and npm 6 are too old for this project's Vite and lockfile.
- **`vite: Permission denied`:** After installing a compatible Node and npm, run `npm ci` to replace the existing dependencies and restore the executable launcher. This removes and recreates `node_modules`.
- **Port already in use:** Stop the other process or specify a different port as shown above.
- **API or CORS errors:** Check `.env.local`, ensure the backend is running and reachable, and configure the backend to allow the frontend origin. No Vite proxy is configured.
- **Unexpected remote requests:** Set `VITE_TAXIGO_API_BASE_URL` explicitly; without it the app uses the remote fallback.
