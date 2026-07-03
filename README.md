# Invisible Embedder

A fully client-side PDF editor for adding ATS-focused text to a resume while keeping the visual document clean. It renders your PDF in the browser, lets you embed keywords (by hand or with a local AI), and exports a PDF where the added text is visually invisible but still readable by Applicant Tracking Systems.

## Stack

- React + Vite + TypeScript
- PDF.js for in-browser PDF rendering (pinned to `5.4.394`)
- pdf-lib for writing the downloaded PDF
- Tailwind CSS for the interface
- Ollama (local, optional) for Automatic keyword extraction
- Cloudflare Pages for static deployment

## Two modes

The app has a two-pane layout: controls on the left, your resume on the right.

1. **Manual Mode** — turn on the text tool, click anywhere on the page, type your keyword(s), click **Process**, then **Export**. Works everywhere, no setup, no AI.
2. **Automatic (AI) Mode** — paste a Job Description; a **local** AI (Ollama, default model `qwen2.5:1.5b`) finds the skills in the JD that are missing from your resume and places them in the empty space near your **Skills** section. You can review/remove any before exporting.

Processed text becomes visually invisible in the editor unless focused.

## Export behavior

Pages with typed text are rebuilt as a page image. The inserted text is written into the PDF using a color sampled from the page pixels beneath each character, so it visually blends into the background instead of showing up. Existing PDF text is preserved as an invisible, selectable layer on processed pages.

This is visual concealment for ATS-style text insertion — not cryptographic redaction or content removal.

## Local development

```bash
npm install
npm run dev
```

Open the printed `http://localhost:5173` in a desktop browser (the app is desktop-only by design).

> The first run may re-optimize dependencies. If you ever see a blank page after changing dependencies, clear Vite's cache: `rm -rf node_modules/.vite`.

## Automatic Mode: the local AI (Ollama)

Automatic mode runs an AI model **on your own machine** via [Ollama](https://ollama.com). This keeps it free and completely private — your resume and the job description never leave your computer. Because of that, **Automatic mode requires a local Ollama setup; it cannot run on the hosted site.** (Manual mode has no such requirement.)

### Easiest: one-click setup (when running locally)

When you run the project locally (`npm run dev`), the Automatic panel shows a **"Set up Automatic Mode"** button. Clicking it will, streaming progress into the UI:

1. Install Ollama if it isn't already (Linux/macOS — you may be prompted for your password in the terminal).
2. Start the Ollama server with browser access enabled (`OLLAMA_ORIGINS=*`).
3. Download the default model (`qwen2.5:1.5b`, ~1 GB, one-time).

When it finishes, paste a Job Description and click **Analyze & Embed**.

> This button only exists in local development. The Node dev server is what runs those commands — a browser can't install software, so the deployed static site never exposes this and instead shows a "run locally" notice. (Endpoints: `GET /api/ollama/status`, `POST /api/ollama/setup`, defined in `vite.config.ts` and active only under `npm run dev`.)

### Manual setup (or on Windows)

```bash
# 1. Install Ollama from https://ollama.com/download
# 2. Pull a small, fast model:
ollama pull qwen2.5:1.5b
# 3. Run the server so the browser app can reach it:
OLLAMA_ORIGINS='*' ollama serve
```

If Ollama is already running as a background service, set the origin permanently instead (Linux/systemd):

```bash
sudo mkdir -p /etc/systemd/system/ollama.service.d
printf '[Service]\nEnvironment="OLLAMA_ORIGINS=*"\n' | sudo tee /etc/systemd/system/ollama.service.d/override.conf
sudo systemctl daemon-reload && sudo systemctl restart ollama
```

`OLLAMA_ORIGINS` is required so the web page is allowed to call Ollama (CORS). Use `*` for any origin, or your specific site, e.g. `https://your-app.pages.dev`.

### Choosing a model

Use the **🧠 (brain) icon** in the top bar to change the model. Good small/fast options:

| Model | Size | Notes |
|-------|------|-------|
| `qwen2.5:1.5b` (default) | ~1 GB | Best balance of speed, size, and quality |
| `llama3.2:1b` | ~1.3 GB | Very fast |
| `qwen2.5:0.5b` | ~0.4 GB | Fastest/smallest; occasionally noisier |

The app requests deterministic, length-capped output and keeps the model warm (`keep_alive`) so back-to-back analyses stay fast.

## Deploying to Cloudflare Pages

Build settings:

- Framework preset: **Vite**
- Build command: `npm run build`
- Build output directory: `dist`

No server or environment variables are required. PDF.js character maps and fonts are bundled into the build automatically.

**On the deployed site:** Manual mode, PDF rendering, and Export all work with no setup. Automatic mode will show a prompt explaining that it needs a local AI — a visitor can either run Ollama themselves (with `OLLAMA_ORIGINS` pointing at your domain) or, for the smoothest experience, clone and run the project locally to use the one-click setup.

