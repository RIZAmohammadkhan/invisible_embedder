# ATS Increaser

A fully client-side PDF editor for adding ATS-focused text to a PDF while keeping the visual document clean.

## Stack

- React + Vite + TypeScript
- PDF.js for in-browser PDF rendering
- pdf-lib for writing the downloaded PDF
- Tailwind CSS for the interface
- Cloudflare Pages for static deployment

## Workflow

Users upload a PDF, turn on the text tool, click a page, type purple text, click **Process**, and export. Processed text becomes visually invisible in the editor unless focused.

## Export Behavior

Pages with typed text are rebuilt as a visual page image. The inserted text is written into the PDF using a color sampled from the page pixels beneath each character, so the text visually blends into the original background instead of becoming white. Existing PDF text is preserved as an invisible selectable layer on processed pages.

This is visual concealment for ATS-style text insertion, not cryptographic redaction or content removal.

## Local Development

```bash
npm install
npm run dev
```

## Cloudflare Pages

Use these build settings:

- Framework preset: Vite
- Build command: `npm run build`
- Build output directory: `dist`

No server or environment variables are required.
