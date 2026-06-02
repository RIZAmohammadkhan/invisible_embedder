import {
  ChevronLeft,
  ChevronRight,
  Download,
  FileUp,
  Minus,
  Plus,
  Trash2,
  Type,
  Undo2,
  Moon,
  Sun,
  Apple,
  Maximize,
  CheckCircle2,
  Heart,
  Github,
  Linkedin,
  Laptop,
} from "lucide-react";
import {
  ChangeEvent,
  FormEvent,
  createRef,
  useMemo,
  useRef,
  useState,
  useEffect,
  useCallback,
} from "react";
import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";
import { exportAtsIncreasedPdf } from "./pdfExport";
import { pdfjsLib } from "./pdfWorker";
import type { TextInsertion } from "./types";
import { PdfPageView } from "./PdfPageView";

type LoadState = "idle" | "loading" | "ready" | "saving" | "error";

const ZOOM_STEP = 0.15;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
const PAGE_RENDER_BUFFER = 2;
const SMOOTH_SCROLL_PAGE_LIMIT = 5;

/** 
 * Checks if the device is a true desktop/laptop.
 * It checks screen width AND OS type, explicitly catching iPads that spoof macOS.
 */
function checkIsDesktopDevice(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return true;
  }

  // 1. Ensure the window is wide enough (desktop/laptop typical width)
  const isWideEnough = window.innerWidth >= 1024;

  // 2. Check for standard mobile operating systems
  const ua = navigator.userAgent;
  const isMobileOS = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);

  // 3. Catch modern iPads that request desktop sites (they say they are Macs, but have touchpoints)
  // Windows touch-laptops are excluded from this specific check because their platform/UA is "Win32" / "Windows".
  const isIPadOS = 
    (/Mac/.test(navigator.platform) || /Mac/.test(ua)) && 
    navigator.maxTouchPoints > 1;

  // It is a desktop ONLY if it is wide enough AND not a mobile OS AND not an iPad OS
  return isWideEnough && !isMobileOS && !isIPadOS;
}

export default function App() {
  const [isDesktop, setIsDesktop] = useState(checkIsDesktopDevice);
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [fileName, setFileName] = useState("");
  const [insertions, setInsertions] = useState<TextInsertion[]>([]);
  const [activeInsertionId, setActiveInsertionId] = useState<string | null>(null);
  const [insertionMode, setInsertionMode] = useState(true);
  const [state, setState] = useState<LoadState>("idle");
  const [message, setMessage] = useState("");
  const [zoom, setZoom] = useState(1);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [nearViewportPages, setNearViewportPages] = useState<Set<number>>(
    () => new Set([0]),
  );
  const [isDark, setIsDark] = useState(() => {
    if (typeof window !== "undefined") {
      return document.documentElement.classList.contains("dark") || 
             window.matchMedia("(prefers-color-scheme: dark)").matches;
    }
    return false;
  });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const stackRef = useRef<HTMLDivElement>(null);
  const pdfDocRef = useRef<PDFDocumentProxy | null>(null);
  const pdfObjectUrlRef = useRef<string | null>(null);
  const loadSequenceRef = useRef(0);

  useEffect(() => {
    const handleResize = () => {
      setIsDesktop(checkIsDesktopDevice());
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    if (isDark) {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
  }, [isDark]);

  useEffect(() => {
    pdfDocRef.current = pdfDoc;
  }, [pdfDoc]);

  const releaseCurrentPdf = useCallback(() => {
    if (pdfDocRef.current) {
      void pdfDocRef.current.destroy();
      pdfDocRef.current = null;
    }

    if (pdfObjectUrlRef.current) {
      URL.revokeObjectURL(pdfObjectUrlRef.current);
      pdfObjectUrlRef.current = null;
    }
  }, []);

  useEffect(() => releaseCurrentPdf, [releaseCurrentPdf]);

  useEffect(() => {
    setPageInput(String(currentPage));
  }, [currentPage]);

  const draftCount = insertions.filter(
    (insertion) => insertion.status === "draft" && insertion.text.trim().length > 0,
  ).length;

  const pageNumbers = useMemo(
    () =>
      pdfDoc
        ? Array.from({ length: pdfDoc.numPages }, (_, pageIndex) => pageIndex)
        : [],
    [pdfDoc],
  );
  const totalPages = pdfDoc?.numPages ?? 0;
  const insertionsByPage = useMemo(() => {
    const grouped = new Map<number, TextInsertion[]>();

    for (const insertion of insertions) {
      const pageInsertions = grouped.get(insertion.pageIndex) ?? [];
      pageInsertions.push(insertion);
      grouped.set(insertion.pageIndex, pageInsertions);
    }

    return grouped;
  }, [insertions]);
  const renderedPageIndices = useMemo(
    () =>
      createBufferedPageSet(
        [...nearViewportPages, currentPage - 1],
        totalPages,
      ),
    [currentPage, nearViewportPages, totalPages],
  );

  // Create stable refs for each page article
  const pageRefs = useMemo(
    () => pageNumbers.map(() => createRef<HTMLElement>()),
    [pageNumbers],
  );

  useEffect(() => {
    if (!pdfDoc) {
      setNearViewportPages(new Set());
      return;
    }

    setNearViewportPages(new Set([0]));
  }, [pdfDoc]);

  // Track which page is visible via IntersectionObserver
  useEffect(() => {
    if (pageRefs.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const idx = Number(
              (entry.target as HTMLElement).dataset.pageIndex ?? 0,
            );
            setCurrentPage(idx + 1);
          }
        }
      },
      { threshold: 0.4 },
    );

    for (const ref of pageRefs) {
      if (ref.current) observer.observe(ref.current);
    }
    return () => observer.disconnect();
  }, [pageRefs]);

  // Keep only pages near the viewport rendered as canvases/text layers.
  useEffect(() => {
    if (pageRefs.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        setNearViewportPages((current) => {
          const next = new Set(current);
          let changed = false;

          for (const entry of entries) {
            const index = Number(
              (entry.target as HTMLElement).dataset.pageIndex ?? 0,
            );

            if (entry.isIntersecting) {
              if (!next.has(index)) {
                next.add(index);
                changed = true;
              }
            } else if (next.delete(index)) {
              changed = true;
            }
          }

          return changed ? next : current;
        });
      },
      { rootMargin: "1200px 0px", threshold: 0 },
    );

    for (const ref of pageRefs) {
      if (ref.current) observer.observe(ref.current);
    }

    return () => observer.disconnect();
  }, [pageRefs]);

  async function loadPdf(file: File) {
    const isPdf =
      file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");

    if (!isPdf) {
      setState("error");
      setMessage("Please choose a PDF file.");
      return;
    }

    setState("loading");
    setMessage("Loading PDF...");
    setFileName(file.name);
    setInsertions([]);
    setActiveInsertionId(null);
    setInsertionMode(true);
    setPdfDoc(null);
    setPdfFile(null);
    setZoom(1);
    setCurrentPage(1);
    setPageInput("1");
    setNearViewportPages(new Set([0]));
    loadSequenceRef.current += 1;
    const loadSequence = loadSequenceRef.current;
    releaseCurrentPdf();
    const objectUrl = URL.createObjectURL(file);

    try {
      const loadingTask = pdfjsLib.getDocument({
        url: objectUrl,
      });
      const loadedPdf = await loadingTask.promise;

      if (loadSequence !== loadSequenceRef.current) {
        await loadedPdf.destroy();
        URL.revokeObjectURL(objectUrl);
        return;
      }

      pdfDocRef.current = loadedPdf;
      pdfObjectUrlRef.current = objectUrl;
      setPdfFile(file);
      setPdfDoc(loadedPdf);
      setState("ready");
      setMessage(""); // Removed the load message since layout handles it
    } catch (error) {
      console.error(error);
      URL.revokeObjectURL(objectUrl);

      if (loadSequence === loadSequenceRef.current) {
        setState("error");
        setMessage("Could not open that PDF.");
        setPdfFile(null);
        setPdfDoc(null);
      }
    }
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) {
      void loadPdf(file);
    }
  }

  function createInsertion(insertion: Omit<TextInsertion, "id" | "status">) {
    const id = crypto.randomUUID();

    setInsertions((current) => [
      ...current,
      {
        ...insertion,
        id,
        status: "draft",
      },
    ]);
    setActiveInsertionId(id);
  }

  function updateInsertion(id: string, text: string) {
    setInsertions((current) =>
      current.map((insertion) =>
        insertion.id === id
          ? {
              ...insertion,
              text,
              status: "draft",
            }
          : insertion,
      ),
    );
  }

  function updateInsertionLayout(
    id: string,
    layout: Partial<Pick<TextInsertion, "x" | "y" | "width" | "height">>,
  ) {
    setInsertions((current) =>
      current.map((insertion) =>
        insertion.id === id
          ? {
              ...insertion,
              ...layout,
              status: "draft",
            }
          : insertion,
      ),
    );
  }

  function removeInsertion(id: string) {
    setInsertions((current) =>
      current.filter((insertion) => insertion.id !== id),
    );
    setActiveInsertionId((current) => (current === id ? null : current));
  }

  function processDrafts() {
    if (draftCount === 0) {
      setMessage("Type text first.");
      setTimeout(() => setMessage(""), 2000);
      return;
    }

    setInsertions((current) =>
      current
        .filter((insertion) => insertion.text.trim().length > 0)
        .map((insertion) =>
          insertion.status === "draft"
            ? { ...insertion, status: "processed" }
            : insertion,
      ),
    );
  }

  function undoLast() {
    setInsertions((current) => current.slice(0, -1));
    setActiveInsertionId(null);
  }

  function resetPdf() {
    loadSequenceRef.current += 1;
    releaseCurrentPdf();
    setPdfFile(null);
    setPdfDoc(null);
    setFileName("");
    setInsertions([]);
    setActiveInsertionId(null);
    setInsertionMode(true);
    setState("idle");
    setMessage("");
    setZoom(1);
    setCurrentPage(1);
    setPageInput("1");
    setNearViewportPages(new Set());
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  // ─── Zoom helpers ──────────────────────────────────────
  const zoomIn = useCallback(() => {
    setZoom((z) => Math.min(z + ZOOM_STEP, ZOOM_MAX));
  }, []);

  const zoomOut = useCallback(() => {
    setZoom((z) => Math.max(z - ZOOM_STEP, ZOOM_MIN));
  }, []);

  const zoomFit = useCallback(() => {
    setZoom(1);
  }, []);

  // ─── Page nav helpers ─────────────────────────────────
  const goToPage = useCallback(
    (page: number) => {
      const targetPage = clampPage(page, totalPages);

      if (!targetPage) {
        return;
      }

      setCurrentPage(targetPage);
      setPageInput(String(targetPage));
      setNearViewportPages((current) => {
        const next = new Set(current);
        next.add(targetPage - 1);
        return next;
      });

      const target = pageRefs[targetPage - 1]?.current;
      if (target) {
        const behavior =
          Math.abs(targetPage - currentPage) <= SMOOTH_SCROLL_PAGE_LIMIT
            ? "smooth"
            : "auto";
        target.scrollIntoView({ behavior, block: "start" });
      }
    },
    [currentPage, pageRefs, totalPages],
  );

  const prevPage = useCallback(() => {
    const p = Math.max(1, currentPage - 1);
    setCurrentPage(p);
    goToPage(p);
  }, [currentPage, goToPage]);

  const nextPage = useCallback(() => {
    const p = Math.min(totalPages, currentPage + 1);
    setCurrentPage(p);
    goToPage(p);
  }, [currentPage, totalPages, goToPage]);

  const commitPageInput = useCallback(() => {
    const parsedPage = Number(pageInput);
    const targetPage = clampPage(parsedPage, totalPages);

    if (!targetPage) {
      setPageInput(String(currentPage));
      return;
    }

    goToPage(targetPage);
  }, [currentPage, goToPage, pageInput, totalPages]);

  function handlePageSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    commitPageInput();
  }

  // ─── Save / Export ─────────────────────────────────────
  async function savePdf() {
    const exportInsertions = insertions.filter(
      (insertion) => insertion.text.trim().length > 0,
    );

    if (!pdfFile || !pdfDoc || exportInsertions.length === 0) {
      setMessage("Add at least one text item before saving.");
      setTimeout(() => setMessage(""), 2000);
      return;
    }

    setState("saving");
    setMessage("Reading source PDF...");

    try {
      const originalBytes = await pdfFile.arrayBuffer();
      const outputBytes = await exportAtsIncreasedPdf(
        originalBytes,
        pdfDoc,
        exportInsertions.map((insertion) => ({ ...insertion, status: "processed" })),
        {
          onProgress(progress) {
            if (progress.phase === "saving") {
              setMessage("Packaging PDF...");
              return;
            }

            setMessage(
              `${progress.phase === "processing" ? "Processing" : "Copying"} ${
                progress.pageNumber
              }/${progress.totalPages}...`,
            );
          },
        },
      );
      const pdfBuffer = new ArrayBuffer(outputBytes.byteLength);
      new Uint8Array(pdfBuffer).set(outputBytes);
      const blob = new Blob([pdfBuffer], { type: "application/pdf" });
      const safeName = fileName.replace(/\.pdf$/i, "") || "document";
      const exportFileName = `${safeName}-ats-increased.pdf`;

      // Standard download via anchor click
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = exportFileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);

      setInsertions((current) =>
        current
          .filter((insertion) => insertion.text.trim().length > 0)
          .map((insertion) => ({ ...insertion, status: "processed" })),
      );
      setState("ready");
      setMessage(""); // Clear message
    } catch (error) {
      console.error(error);
      setState("error");
      setMessage("Could not save the ATS-increased PDF.");
    }
  }

  // ─── Early Return if NOT Desktop / Laptop ────────────────
  if (!isDesktop) {
    return (
      <div 
        className="app-shell" 
        style={{ alignItems: 'center', justifyContent: 'center', padding: '1.5rem' }}
      >
        <div 
          className="glass-panel" 
          style={{ 
            display: 'flex', 
            flexDirection: 'column', 
            alignItems: 'center', 
            textAlign: 'center', 
            padding: '3rem 2rem', 
            maxWidth: '24rem', 
            borderRadius: 'var(--radius-lg)',
            gap: '1rem' 
          }}
        >
          <div style={{ background: 'var(--bg)', padding: '1rem', borderRadius: '50%', boxShadow: '0 1px 4px var(--border)' }}>
            <Laptop size={32} strokeWidth={1.5} />
          </div>
          <h2 style={{ fontSize: '1.25rem', fontWeight: 600, margin: 0 }}>
            Laptop Required
          </h2>
          <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', margin: 0, lineHeight: 1.5 }}>
            This application is optimized exclusively for desktop operating systems and larger screens. Please open it on a laptop or desktop computer to edit your PDFs.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      {/* ─── Header ────────────────────────────────────────── */}
      <header className="top-bar glass-panel">
        <div className="top-bar-left">
          <div className="app-title">
            <span>Invisible Embedder</span>
          </div>
          {fileName && <span className="file-name">{fileName}</span>}
        </div>

        {pdfDoc && (
          <div className="top-bar-center">
            <div className="controls-group" style={{ marginRight: '0.75rem' }}>
              <button className="ctrl-btn" onClick={prevPage} disabled={currentPage <= 1 || state === "saving"}>
                <ChevronLeft size={16} strokeWidth={1.5} />
              </button>
              <form className="page-jump-form" onSubmit={handlePageSubmit}>
                <input
                  className="ctrl-page-input"
                  type="number"
                  min={1}
                  max={totalPages}
                  value={pageInput}
                  onChange={(e) => setPageInput(e.target.value)}
                  onBlur={commitPageInput}
                  disabled={state === "saving"}
                />
                <span className="ctrl-page-total">/ {totalPages}</span>
              </form>
              <button className="ctrl-btn" onClick={nextPage} disabled={currentPage >= totalPages || state === "saving"}>
                <ChevronRight size={16} strokeWidth={1.5} />
              </button>
            </div>

            <div className="controls-group">
              <button className="ctrl-btn" onClick={zoomOut} disabled={zoom <= ZOOM_MIN}>
                <Minus size={14} strokeWidth={1.5} />
              </button>
              <span className="ctrl-label" style={{ width: '3rem' }}>{Math.round(zoom * 100)}%</span>
              <button className="ctrl-btn" onClick={zoomIn} disabled={zoom >= ZOOM_MAX}>
                <Plus size={14} strokeWidth={1.5} />
              </button>
              <button className="ctrl-btn" onClick={zoomFit}>
                <Maximize size={14} strokeWidth={1.5} />
              </button>
            </div>
          </div>
        )}

        <div className="top-bar-right">
          {message && <span className="status-text">{message}</span>}
          <button
            className="ctrl-btn"
            onClick={() => setIsDark((prev) => !prev)}
            aria-label="Toggle Theme"
          >
            {isDark ? <Sun size={16} strokeWidth={1.5} /> : <Moon size={16} strokeWidth={1.5} />}
          </button>
        </div>
      </header>

      {/* ─── Main Content ──────────────────────────────────── */}
      <input ref={fileInputRef} className="sr-only" type="file" accept="application/pdf" onChange={handleFileChange} />
      
      {!pdfDoc ? (
        <main className="workspace empty-workspace">
          <button
            type="button"
            className="drop-zone"
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const file = e.dataTransfer.files[0];
              if (file) void loadPdf(file);
            }}
          >
            <div className="drop-zone-icon">
              <FileUp size={32} strokeWidth={1.5} />
            </div>
            <span>Drop a PDF here</span>
          </button>

          {/* Minimalist Glass Footer */}
          <div className="empty-footer">
            <span>Made with</span>
            <Heart size={14} className="heart-icon" strokeWidth={2.5} />
            <span>by RMK</span>
            <div className="empty-footer-divider" />
            <div className="empty-footer-links">
              <a href="https://github.com/Rizamohammadkhan" target="_blank" rel="noopener noreferrer" aria-label="GitHub">
                <Github size={16} strokeWidth={1.5} />
              </a>
              <a href="https://linkedin.com/in/rizamkhan" target="_blank" rel="noopener noreferrer" aria-label="LinkedIn">
                <Linkedin size={16} strokeWidth={1.5} />
              </a>
            </div>
          </div>
        </main>
      ) : (
        <main className="workspace">
          <div className="pdf-stack" ref={stackRef}>
            {pageNumbers.map((pageIndex) => (
              <PdfPageView
                key={pageIndex}
                ref={pageRefs[pageIndex]}
                pdfDoc={pdfDoc}
                pageIndex={pageIndex}
                scale={zoom}
                insertions={insertionsByPage.get(pageIndex) ?? []}
                disabled={state === "saving"}
                insertionMode={insertionMode}
                activeInsertionId={activeInsertionId}
                shouldRender={renderedPageIndices.has(pageIndex)}
                onCreateInsertion={createInsertion}
                onUpdateInsertion={updateInsertion}
                onUpdateInsertionLayout={updateInsertionLayout}
                onFocusInsertion={setActiveInsertionId}
                onRemoveInsertion={removeInsertion}
              />
            ))}
          </div>
        </main>
      )}

      {/* ─── Floating Dock ─────────────────────────────────── */}
      {pdfDoc && (
        <div className="dock-container">
          <nav className="dock glass-panel">
            <button className="btn icon-only" onClick={() => fileInputRef.current?.click()} disabled={state === "loading" || state === "saving"} title="Upload New">
              <FileUp size={18} strokeWidth={1.5} />
            </button>
            <button
              className={["btn", "icon-only", insertionMode ? "active-tool" : ""].join(" ")}
              onClick={() => setInsertionMode((current) => !current)}
              disabled={state === "saving"}
              title="Text tool"
              aria-pressed={insertionMode}
            >
              <Type size={18} strokeWidth={1.5} />
            </button>
            <div className="dock-divider" />
            
            <button className="btn" onClick={processDrafts} disabled={draftCount === 0 || state === "saving"}>
              Process {draftCount > 0 ? `(${draftCount})` : ""}
            </button>
            
            <button className="btn icon-only" onClick={undoLast} disabled={insertions.length === 0 || state === "saving"} title="Undo">
              <Undo2 size={18} strokeWidth={1.5} />
            </button>
            
            <div className="dock-divider" />
            
            <button className="btn primary" onClick={savePdf} disabled={insertions.length === 0 || state === "saving"}>
              <Download size={16} strokeWidth={2} />
              <span>Export</span>
            </button>

            <button className="btn danger icon-only" onClick={resetPdf} disabled={state === "saving"} title="Clear Document" style={{ marginLeft: '0.25rem' }}>
              <Trash2 size={18} strokeWidth={1.5} />
            </button>
          </nav>
        </div>
      )}
    </div>
  );
}

function createBufferedPageSet(pageIndices: Iterable<number>, totalPages: number) {
  const buffered = new Set<number>();

  for (const pageIndex of pageIndices) {
    if (!Number.isFinite(pageIndex)) {
      continue;
    }

    for (
      let index = pageIndex - PAGE_RENDER_BUFFER;
      index <= pageIndex + PAGE_RENDER_BUFFER;
      index += 1
    ) {
      if (index >= 0 && index < totalPages) {
        buffered.add(index);
      }
    }
  }

  return buffered;
}

function clampPage(page: number, totalPages: number) {
  if (!Number.isFinite(page) || totalPages <= 0) {
    return null;
  }

  return Math.min(Math.max(Math.trunc(page), 1), totalPages);
}
