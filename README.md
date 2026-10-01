# RepoSignal

RepoSignal turns a GitHub repository's open issues and pull requests into an evidence-backed maintainer attention queue. It ranks work, explains the signals behind each recommendation, spots related items, and builds a time-boxed action plan without posting or changing anything on GitHub.

## Features

- Live issues, pull requests, checks, reactions, changed files, and repository policies
- Inspectable priority scores and suggested maintainer actions
- Local semantic duplicate detection
- 15, 30, and 60-minute focus plans with Markdown export
- Optional token support for private repositories and higher GitHub API limits

## Run locally

Requires Node.js 20+ and Python 3.11+.

```powershell
npm install
python -m pip install -r requirements.txt
npm run dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). The development command starts both the web app and API.

For a production-style local run:

```powershell
npm start
```

Then open [http://127.0.0.1:4173](http://127.0.0.1:4173).

## Configuration

Public repositories work without setup. Set `GITHUB_TOKEN` on the server, or use the token field in the app, for private repositories and higher rate limits. Tokens entered in the app are used only for that request.

Scan history uses `reposignal.db` locally. Vercel uses temporary function storage, so hosted scan history may reset between function instances.

## Deploy

```powershell
vercel --prod
```

The Vite frontend and FastAPI functions are configured through `vercel.json`.
