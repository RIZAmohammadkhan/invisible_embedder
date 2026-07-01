import { Maximize2, Move, X } from "lucide-react";
import { forwardRef, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";
import { pdfjsLib } from "./pdfWorker";
import type { TextInsertion } from "./types";

const RENDER_SCALE = 1.5;
const MAX_PARALLEL_PAGE_RENDERS = getMaxParallelPageRenders();
const DEFAULT_TEXT_BOX_WIDTH = 0.34;
const DEFAULT_TEXT_BOX_HEIGHT = 0.04;
const MIN_TEXT_BOX_WIDTH = 0.08;
const MIN_TEXT_BOX_HEIGHT = 0.025;

let activePageRenders = 0;
const pageRenderQueue: Array<() => void> = [];

type PageSize = {
  width: number;
  height: number;
};

type PdfPageViewProps = {
  pdfDoc: PDFDocumentProxy;
  pageIndex: number;
  insertions: TextInsertion[];
  disabled: boolean;
  insertionMode: boolean;
  activeInsertionId: string | null;
  shouldRender: boolean;
  scale: number;
  onCreateInsertion: (insertion: Omit<TextInsertion, "id" | "status">) => void;
  onUpdateInsertion: (id: string, text: string) => void;
  onUpdateInsertionLayout: (
    id: string,
    layout: Partial<Pick<TextInsertion, "x" | "y" | "width" | "height">>,
  ) => void;
  onFocusInsertion: (id: string) => void;
  onRemoveInsertion: (id: string) => void;
};

export const PdfPageView = forwardRef<HTMLElement, PdfPageViewProps>(
  function PdfPageView(
    {
      pdfDoc,
      pageIndex,
      insertions,
      disabled,
      insertionMode,
      activeInsertionId,
      shouldRender,
      scale,
      onCreateInsertion,
      onUpdateInsertion,
      onUpdateInsertionLayout,
      onFocusInsertion,
      onRemoveInsertion,
    },
    ref,
  ) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const textLayerRef = useRef<HTMLDivElement>(null);
    const [isRendering, setIsRendering] = useState(true);
    const [pageSize, setPageSize] = useState<PageSize>({
      width: 612,
      height: 792,
    });

    useEffect(() => {
      let cancelled = false;
      let releaseRenderSlot: (() => void) | null = null;
      let renderTask: { cancel: () => void; promise: Promise<unknown> } | null =
        null;
      let textLayer: { cancel: () => void; render: () => Promise<unknown> } | null =
        null;
      const canvas = canvasRef.current;
      const textLayerContainer = textLayerRef.current;

      if (!shouldRender) {
        setIsRendering(false);
        textLayerContainer?.replaceChildren();
        if (canvas) {
          releaseCanvas(canvas);
        }

        return () => {
          cancelled = true;
        };
      }

      async function renderPage() {
        setIsRendering(true);

        if (!canvas || !textLayerContainer) {
          return;
        }

        const page = await pdfDoc.getPage(pageIndex + 1);

        try {
          releaseRenderSlot = await acquirePageRenderSlot();

          if (cancelled) {
            return;
          }

          const viewport = page.getViewport({ scale: RENDER_SCALE });
          const context = canvas.getContext("2d", { alpha: false });

          if (!context) {
            return;
          }

          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          setPageSize({
            width: viewport.width,
            height: viewport.height,
          });

          // Ensure background is white before rendering
          context.fillStyle = "#ffffff";
          context.fillRect(0, 0, canvas.width, canvas.height);

          renderTask = page.render({ canvas, canvasContext: context, viewport });
          textLayerContainer.replaceChildren();
          textLayerContainer.style.setProperty(
            "--total-scale-factor",
            String(RENDER_SCALE),
          );
          textLayer = new pdfjsLib.TextLayer({
            container: textLayerContainer,
            textContentSource: page.streamTextContent({
              includeMarkedContent: true,
              disableNormalization: true,
            }),
            viewport,
          });

          await Promise.all([renderTask.promise, textLayer.render()]);

          if (!cancelled) {
            setIsRendering(false);
          }
        } finally {
          page.cleanup();
          releaseRenderSlot?.();
          releaseRenderSlot = null;
        }
      }

      void renderPage().catch((error) => {
        if (!cancelled && error?.name !== "RenderingCancelledException") {
          console.error(error);
          setIsRendering(false);
        }
      });

      return () => {
        cancelled = true;
        renderTask?.cancel();
        textLayer?.cancel();
        textLayerContainer?.replaceChildren();
        if (canvas) {
          releaseCanvas(canvas);
        }
        releaseRenderSlot?.();
      };
    }, [pageIndex, pdfDoc, shouldRender]);

    function handlePagePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
      if (disabled || !insertionMode) {
        return;
      }

      const target = event.target as HTMLElement;
      if (target.closest(".insertion-box")) {
        return;
      }

      const bounds = event.currentTarget.getBoundingClientRect();
      const x = clamp((event.clientX - bounds.left) / bounds.width);
      const y = clamp((event.clientY - bounds.top) / bounds.height);

      onCreateInsertion({
        pageIndex,
        x: Math.min(x, 1 - DEFAULT_TEXT_BOX_WIDTH),
        y: Math.min(y, 1 - DEFAULT_TEXT_BOX_HEIGHT),
        width: DEFAULT_TEXT_BOX_WIDTH,
        height: DEFAULT_TEXT_BOX_HEIGHT,
        text: "",
        fontSize: 10,
      });
    }

    return (
      <article className="page-shell" ref={ref} data-page-index={pageIndex}>
        <div className="page-title">
          <span>Page {pageIndex + 1}</span>
          {shouldRender && isRendering ? (
            <span>Rendering...</span>
          ) : (
            <span>{insertions.length} text items</span>
          )}
        </div>
        <div className="page-canvas-wrap">
          <div
            className="page-frame"
            onPointerDown={handlePagePointerDown}
            style={{
              width: pageSize.width * scale,
              height: pageSize.height * scale,
            }}
          >
            {shouldRender ? (
              <>
                <canvas ref={canvasRef} className="pdf-canvas" />
                <div
                  ref={textLayerRef}
                  className="textLayer"
                />
                <div className="insertion-layer">
                  {insertions.map((insertion) => (
                    <InsertionBox
                      key={insertion.id}
                      insertion={insertion}
                      scale={scale}
                      active={insertion.id === activeInsertionId}
                      disabled={disabled}
                      onFocus={onFocusInsertion}
                      onUpdate={onUpdateInsertion}
                      onUpdateLayout={onUpdateInsertionLayout}
                      onRemove={onRemoveInsertion}
                    />
                  ))}
                </div>
              </>
            ) : (
              <div className="page-placeholder" />
            )}
          </div>
        </div>
      </article>
    );
  },
);

function InsertionBox({
  insertion,
  scale,
  active,
  disabled,
  onFocus,
  onUpdate,
  onUpdateLayout,
  onRemove,
}: {
  insertion: TextInsertion;
  scale: number;
  active: boolean;
  disabled: boolean;
  onFocus: (id: string) => void;
  onUpdate: (id: string, text: string) => void;
  onUpdateLayout: (
    id: string,
    layout: Partial<Pick<TextInsertion, "x" | "y" | "width" | "height">>,
  ) => void;
  onRemove: (id: string) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const lineCount = Math.max(1, insertion.text.split("\n").length);

  useEffect(() => {
    if (active && !disabled) {
      inputRef.current?.focus();
    }
  }, [active, disabled]);

  function handleMoveStart(event: ReactPointerEvent<HTMLButtonElement>) {
    beginLayoutDrag(event, "move");
  }

  function handleResizeStart(event: ReactPointerEvent<HTMLButtonElement>) {
    beginLayoutDrag(event, "resize");
  }

  function beginLayoutDrag(
    event: ReactPointerEvent<HTMLButtonElement>,
    mode: "move" | "resize",
  ) {
    if (disabled) {
      return;
    }

    const layer = boxRef.current?.closest(".insertion-layer");
    const bounds = layer?.getBoundingClientRect();

    if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    onFocus(insertion.id);

    const startClientX = event.clientX;
    const startClientY = event.clientY;
    const start = {
      x: insertion.x,
      y: insertion.y,
      width: insertion.width,
      height: insertion.height,
    };

    const handlePointerMove = (moveEvent: globalThis.PointerEvent) => {
      moveEvent.preventDefault();
      const deltaX = (moveEvent.clientX - startClientX) / bounds.width;
      const deltaY = (moveEvent.clientY - startClientY) / bounds.height;

      if (mode === "move") {
        onUpdateLayout(insertion.id, {
          x: clamp(start.x + deltaX, 0, 1 - start.width),
          y: clamp(start.y + deltaY, 0, 1 - start.height),
        });
        return;
      }

      onUpdateLayout(insertion.id, {
        width: clamp(start.width + deltaX, MIN_TEXT_BOX_WIDTH, 1 - start.x),
        height: clamp(start.height + deltaY, MIN_TEXT_BOX_HEIGHT, 1 - start.y),
      });
    };

    const endDrag = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
    };

    window.addEventListener("pointermove", handlePointerMove, { passive: false });
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
  }

  return (
    <div
      ref={boxRef}
      className={["insertion-box", insertion.status, active ? "active" : ""]
        .filter(Boolean)
        .join(" ")}
      style={{
        left: `${insertion.x * 100}%`,
        top: `${insertion.y * 100}%`,
        width: `${insertion.width * 100}%`,
        height: `${insertion.height * 100}%`,
        fontSize: `${insertion.fontSize * RENDER_SCALE * scale}px`,
      }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <button
        className="insertion-move"
        type="button"
        disabled={disabled}
        onPointerDown={handleMoveStart}
        aria-label="Move text"
        title="Move text"
      >
        <Move size={12} strokeWidth={2} aria-hidden="true" />
      </button>
      <textarea
        ref={inputRef}
        className="insertion-input"
        value={insertion.text}
        rows={lineCount}
        disabled={disabled}
        spellCheck={false}
        placeholder="Type text"
        onFocus={() => onFocus(insertion.id)}
        onChange={(event) => onUpdate(insertion.id, event.target.value)}
      />
      <button
        className="insertion-resize"
        type="button"
        disabled={disabled}
        onPointerDown={handleResizeStart}
        aria-label="Resize text"
        title="Resize text"
      >
        <Maximize2 size={11} strokeWidth={2} aria-hidden="true" />
      </button>
      <button
        className="insertion-remove"
        type="button"
        onClick={() => onRemove(insertion.id)}
        aria-label="Remove text"
        title="Remove text"
      >
        <X size={12} strokeWidth={2} aria-hidden="true" />
      </button>
    </div>
  );
}

function clamp(value: number, min = 0, max = 1) {
  return Math.min(Math.max(value, min), max);
}

function getMaxParallelPageRenders() {
  if (typeof navigator === "undefined") {
    return 2;
  }

  return Math.max(1, Math.min(2, Math.floor((navigator.hardwareConcurrency || 4) / 3)));
}

function acquirePageRenderSlot() {
  return new Promise<() => void>((resolve) => {
    const start = () => {
      activePageRenders += 1;
      let released = false;

      resolve(() => {
        if (released) {
          return;
        }

        released = true;
        activePageRenders -= 1;
        pageRenderQueue.shift()?.();
      });
    };

    if (activePageRenders < MAX_PARALLEL_PAGE_RENDERS) {
      start();
      return;
    }

    pageRenderQueue.push(start);
  });
}

function releaseCanvas(canvas: HTMLCanvasElement) {
  canvas.width = 1;
  canvas.height = 1;
}
