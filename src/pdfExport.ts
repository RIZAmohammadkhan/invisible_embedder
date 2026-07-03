import {
  degrees,
  PDFDocument,
  rgb,
  StandardFonts,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";
import type {
  PDFDocumentProxy,
  PDFPageProxy,
  TextItem,
} from "pdfjs-dist/types/src/display/api";
import type { TextInsertion } from "./types";

const EXPORT_MAX_WIDTH = 1800;
const EXPORT_MIN_SCALE = 1.5;
const EXPORT_MAX_SCALE = 3;
const COPY_BATCH_SIZE = 24;
const TEXT_LAYER_OPACITY = 0;

type ExportProgressPhase = "copying" | "processing" | "saving";

type ExportProgress = {
  phase: ExportProgressPhase;
  pageNumber: number;
  totalPages: number;
};

type ExportOptions = {
  onProgress?: (progress: ExportProgress) => void;
};

type RenderedPage = {
  canvas: HTMLCanvasElement;
  widthPoints: number;
  heightPoints: number;
  release: () => void;
};

type PdfRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type TextChunk = {
  text: string;
  x: number;
  y: number;
  size: number;
  rotate: number;
};

export async function exportAtsIncreasedPdf(
  originalBytes: ArrayBuffer,
  pdfDoc: PDFDocumentProxy,
  insertions: TextInsertion[],
  options: ExportOptions = {},
) {
  const sourcePdf = await PDFDocument.load(originalBytes);
  const outputPdf = await PDFDocument.create();
  const textFont = await outputPdf.embedFont(StandardFonts.Helvetica);
  const insertionsByPage = groupInsertionsByPage(insertions);
  const totalPages = pdfDoc.numPages;

  outputPdf.setTitle("Unknown");
  outputPdf.setCreator("Unknown");
  outputPdf.setProducer("Unknown");

  for (let pageIndex = 0; pageIndex < totalPages; ) {
    const pageInsertions = insertionsByPage.get(pageIndex) ?? [];

    if (pageInsertions.length === 0) {
      const copiedIndexes: number[] = [];

      while (
        pageIndex < totalPages &&
        !insertionsByPage.has(pageIndex) &&
        copiedIndexes.length < COPY_BATCH_SIZE
      ) {
        copiedIndexes.push(pageIndex);
        pageIndex += 1;
      }

      options.onProgress?.({
        phase: "copying",
        pageNumber: copiedIndexes.at(-1)! + 1,
        totalPages,
      });

      const copiedPages = await outputPdf.copyPages(sourcePdf, copiedIndexes);
      for (const copiedPage of copiedPages) {
        outputPdf.addPage(copiedPage);
      }

      await yieldToBrowser();
      continue;
    }

    options.onProgress?.({
      phase: "processing",
      pageNumber: pageIndex + 1,
      totalPages,
    });

    const pdfPage = await pdfDoc.getPage(pageIndex + 1);
    let renderedPage: RenderedPage | null = null;

    try {
      renderedPage = await renderPageForExport(pdfPage);
      const pngBytes = await canvasToPngBytes(renderedPage.canvas);
      const image = await outputPdf.embedPng(pngBytes);
      const outputPage = outputPdf.addPage([
        renderedPage.widthPoints,
        renderedPage.heightPoints,
      ]);

      outputPage.drawImage(image, {
        x: 0,
        y: 0,
        width: renderedPage.widthPoints,
        height: renderedPage.heightPoints,
      });

      const textChunks = await getSelectableTextChunks(
        pdfPage,
        renderedPage,
        [],
      );

      for (const chunk of textChunks) {
        try {
          outputPage.drawText(chunk.text, {
            x: chunk.x,
            y: chunk.y,
            size: chunk.size,
            font: textFont,
            color: rgb(0, 0, 0),
            opacity: TEXT_LAYER_OPACITY,
            rotate: degrees(chunk.rotate),
          });
        } catch {
          // Built-in PDF fonts cannot encode every script. The visual page image
          // is still correct; unsupported invisible text is skipped.
        }
      }

      drawInvisibleInsertions(
        outputPage,
        pageInsertions,
        renderedPage,
        textFont,
      );
    } finally {
      renderedPage?.release();
      pdfPage.cleanup();
    }

    pageIndex += 1;
    await yieldToBrowser();
  }

  options.onProgress?.({
    phase: "saving",
    pageNumber: totalPages,
    totalPages,
  });
  await yieldToBrowser();

  return outputPdf.save();
}

function groupInsertionsByPage(insertions: TextInsertion[]) {
  return insertions.reduce<Map<number, TextInsertion[]>>((grouped, insertion) => {
    if (insertion.text.trim().length === 0) {
      return grouped;
    }

    const current = grouped.get(insertion.pageIndex) ?? [];
    current.push(insertion);
    grouped.set(insertion.pageIndex, current);
    return grouped;
  }, new Map());
}

async function renderPageForExport(page: PDFPageProxy) {
  const baseViewport = page.getViewport({ scale: 1 });
  const scale = clamp(
    EXPORT_MAX_WIDTH / baseViewport.width,
    EXPORT_MIN_SCALE,
    EXPORT_MAX_SCALE,
  );
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { alpha: false });

  if (!context) {
    throw new Error("Could not create a canvas context for PDF export.");
  }

  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);

  // Ensure background is white before rendering
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);

  await page.render({ canvas, canvasContext: context, viewport }).promise;

  return {
    canvas,
    widthPoints: baseViewport.width,
    heightPoints: baseViewport.height,
    release: () => releaseCanvas(canvas),
  };
}

async function canvasToPngBytes(canvas: HTMLCanvasElement) {
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((result) => {
      if (!result) {
        reject(new Error("Could not encode the rendered page."));
        return;
      }

      resolve(result);
    }, "image/png");
  });

  return new Uint8Array(await blob.arrayBuffer());
}

async function getSelectableTextChunks(
  page: PDFPageProxy,
  renderedPage: RenderedPage,
  highlightRects: PdfRect[],
) {
  const textContent = await page.getTextContent({
    disableNormalization: true,
  });
  const chunks: TextChunk[] = [];

  for (const item of textContent.items) {
    if (!isTextItem(item) || item.str.length === 0 || item.width <= 0) {
      continue;
    }

    chunks.push(...splitTextItem(item, renderedPage, highlightRects));
  }

  return chunks;
}

function splitTextItem(
  item: TextItem,
  renderedPage: RenderedPage,
  highlightRects: PdfRect[],
) {
  const itemRect = textItemToPdfRect(item);
  const removedIntervals = highlightRects
    .filter((highlight) => intersectsVertically(itemRect, highlight))
    .map((highlight) => ({
      start: clamp(highlight.x - itemRect.x, 0, itemRect.width),
      end: clamp(highlight.x + highlight.width - itemRect.x, 0, itemRect.width),
    }))
    .filter((interval) => interval.end > interval.start)
    .sort((first, second) => first.start - second.start);
  const keptIntervals = invertIntervals(removedIntervals, itemRect.width);
  const matrix = item.transform.map(Number);
  const rotate = (Math.atan2(matrix[1] || 0, matrix[0] || 1) * 180) / Math.PI;
  const size = Math.max(item.height || matrix[3] || matrix[0] || 1, 1);

  return keptIntervals
    .map((interval) => intervalToTextChunk(item, interval, size, rotate))
    .filter((chunk): chunk is TextChunk => Boolean(chunk));
}

function intervalToTextChunk(
  item: TextItem,
  interval: { start: number; end: number },
  size: number,
  rotate: number,
) {
  const startRatio = interval.start / item.width;
  const endRatio = interval.end / item.width;
  const startIndex = clampIndex(Math.floor(startRatio * item.str.length), item.str);
  const endIndex = clampIndex(Math.ceil(endRatio * item.str.length), item.str);
  const text = item.str.slice(startIndex, endIndex);

  if (text.trim().length === 0) {
    return null;
  }

  const matrix = item.transform.map(Number);

  return {
    text,
    x: matrix[4] + interval.start,
    y: matrix[5],
    size,
    rotate,
  };
}

function textItemToPdfRect(item: TextItem): PdfRect {
  const matrix = item.transform.map(Number);
  const x = matrix[4];
  const y = matrix[5];

  return {
    x,
    y,
    width: item.width,
    height: Math.max(item.height || matrix[3] || matrix[0] || 1, 1),
  };
}

function drawInvisibleInsertions(
  outputPage: PDFPage,
  insertions: TextInsertion[],
  renderedPage: RenderedPage,
  font: PDFFont,
) {
  for (const insertion of insertions) {
    const size = insertion.fontSize;
    const lineHeight = size * 1.2;
    const x = insertion.x * renderedPage.widthPoints;
    const maxWidth = insertion.width * renderedPage.widthPoints;
    const firstBaseline =
      renderedPage.heightPoints - insertion.y * renderedPage.heightPoints - size;
    const lines = getWrappedInsertionLines(insertion.text, font, size, maxWidth);

    lines.forEach((line, lineIndex) => {
      drawInvisibleLine(
        outputPage,
        line,
        x,
        firstBaseline - lineIndex * lineHeight,
        size,
        font,
      );
    });
  }
}

function drawInvisibleLine(
  outputPage: PDFPage,
  line: string,
  x: number,
  y: number,
  size: number,
  font: PDFFont,
) {
  let cursor = x;

  for (const character of Array.from(line)) {
    const width = safeTextWidth(font, character, size);

    if (/\S/.test(character)) {
      try {
        // By setting opacity to 0, the text becomes perfectly transparent.
        // This allows the background image to show through pixel-by-pixel,
        // naturally blending with whatever is behind it (even if a character
        // straddles two different background colors).
        // It remains fully highlightable/selectable to ATS systems.
        outputPage.drawText(character, {
          x: cursor,
          y,
          size,
          font,
          color: rgb(0, 0, 0),
          opacity: 0,
        });
      } catch {
        // Standard fonts cannot encode every script; unsupported characters are skipped.
      }
    }

    cursor += width;
  }
}

function getWrappedInsertionLines(
  text: string,
  font: PDFFont,
  size: number,
  maxWidth: number,
) {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .flatMap((line) => wrapLineByWidth(line, font, size, maxWidth));
}

function wrapLineByWidth(
  line: string,
  font: PDFFont,
  size: number,
  maxWidth: number,
) {
  if (line.length === 0 || maxWidth <= 0) {
    return [line];
  }

  const lines: string[] = [];
  let current = "";
  let currentWidth = 0;

  for (const character of Array.from(line)) {
    const width = safeTextWidth(font, character, size);

    if (current && currentWidth + width > maxWidth) {
      lines.push(current);
      current = character;
      currentWidth = width;
      continue;
    }

    current += character;
    currentWidth += width;
  }

  lines.push(current);
  return lines;
}

function safeTextWidth(font: PDFFont, text: string, size: number) {
  try {
    return Math.max(font.widthOfTextAtSize(text, size), size * 0.3);
  } catch {
    return size * 0.5;
  }
}

function invertIntervals(
  removedIntervals: Array<{ start: number; end: number }>,
  width: number,
) {
  const kept: Array<{ start: number; end: number }> = [];
  let cursor = 0;

  for (const interval of removedIntervals) {
    if (interval.start > cursor) {
      kept.push({ start: cursor, end: interval.start });
    }
    cursor = Math.max(cursor, interval.end);
  }

  if (cursor < width) {
    kept.push({ start: cursor, end: width });
  }

  return kept;
}

function intersectsVertically(first: PdfRect, second: PdfRect) {
  const firstTop = first.y + first.height;
  const secondTop = second.y + second.height;

  return first.y < secondTop && firstTop > second.y;
}

function isTextItem(item: unknown): item is TextItem {
  return (
    typeof item === "object" &&
    item !== null &&
    "str" in item &&
    "transform" in item &&
    "width" in item &&
    "height" in item
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function clampIndex(index: number, text: string) {
  return Math.min(Math.max(index, 0), text.length);
}

function releaseCanvas(canvas: HTMLCanvasElement) {
  canvas.width = 1;
  canvas.height = 1;
}

function yieldToBrowser() {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, 0);
  });
}