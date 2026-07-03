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
  X,
  Settings,
  BrainCircuit,
  Loader2,
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
import { findMissingKeywordsLLM } from "./textExtraction";

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
  const [workflowMode, setWorkflowMode] = useState<"prompt" | "manual" | "automatic">("prompt");
  const [jdText, setJdText] = useState("");
  const [jdProcessed, setJdProcessed] = useState(false);
  const [embeddedKeywords, setEmbeddedKeywords] = useState<{ id: string; word: string }[]>([]);
  
  // API Key State
  const [ollamaModel, setOllamaModel] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("ollama_model") || "qwen2.5:1.5b";
    }
    return "qwen2.5:1.5b";
  });
  const [apiSettingsOpen, setApiSettingsOpen] = useState(false);

  // One-click local Ollama setup (dev only — see vite.config.ts).
  const isLocalDev = import.meta.env.DEV;
  const [setupRunning, setSetupRunning] = useState(false);
  const [setupLog, setSetupLog] = useState("");

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
    setWorkflowMode("prompt");
    setJdText("");
    setJdProcessed(false);
    setEmbeddedKeywords([]);
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
        cMapUrl: "/cmaps/",
        cMapPacked: true,
        standardFontDataUrl: "/standard_fonts/",
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
    setWorkflowMode("prompt");
    setJdText("");
    setJdProcessed(false);
    setEmbeddedKeywords([]);
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

  // ─── One-click local setup (dev only) ─────────────────
  async function runOllamaSetup() {
    setSetupRunning(true);
    setSetupLog("Starting setup…\n");
    try {
      const res = await fetch("/api/ollama/setup", { method: "POST" });
      if (!res.body) throw new Error("Setup endpoint is unavailable.");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        setSetupLog((prev) => prev + decoder.decode(value, { stream: true }));
      }
    } catch (e: any) {
      setSetupLog((prev) => prev + "\nSetup failed: " + (e?.message || "Unknown error"));
    } finally {
      setSetupRunning(false);
    }
  }

  // ─── Keyword Embedding ─────────────────────────────────
  async function analyzeAndEmbed() {
    if (!pdfDoc || !jdText.trim()) return;
    
    if (!ollamaModel.trim()) {
      setApiSettingsOpen(true);
      return;
    }

    setState("loading");
    setMessage("Analyzing with local AI...");
    try {
      let fullPdfText = "";
      for (let i = 1; i <= pdfDoc.numPages; i++) {
        const page = await pdfDoc.getPage(i);
        const textContent = await page.getTextContent();
        fullPdfText += textContent.items.map((item: any) => item.str).join(" ") + " ";
      }
      
      const missing = await findMissingKeywordsLLM(jdText, fullPdfText, ollamaModel);
      if (missing.length === 0) {
        setMessage("No new keywords found in JD.");
        setTimeout(() => setMessage(""), 3000);
        setState("ready");
        setJdProcessed(true);
        return;
      }
      
      // Place keywords in empty space in/near the Skills section instead of
      // dumping them over existing text.
      const newInsertions = await findKeywordPlacements(pdfDoc, missing, 10);

      setInsertions(current => [...current, ...newInsertions]);
      setEmbeddedKeywords(newInsertions.map(ins => ({ id: ins.id, word: ins.text })));
      setJdProcessed(true);
      setMessage(`Added ${missing.length} keywords.`);
      setTimeout(() => setMessage(""), 3000);
      setState("ready");
    } catch (e: any) {
      console.error(e);
      setMessage("Error analyzing PDF: " + (e.message || "Unknown error"));
      setState("error");
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
          {isLocalDev && <button
            className="ctrl-btn"
            onClick={() => setApiSettingsOpen(true)}
            aria-label="Model Settings"
            title="Model Settings"
          >
            <BrainCircuit size={16} strokeWidth={1.5} />
          </button>}
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
        <main className="workspace workspace-split">
          <aside className="side-panel glass-panel">
            {workflowMode === "prompt" && (
              <div className="panel-section">
                {isLocalDev ? (
                  <>
                    <h2 className="panel-title">Choose Embed Mode</h2>
                    <p className="panel-desc">
                      <strong>Manual</strong> — you type the keywords yourself.<br />
                      <strong>Automatic</strong> — paste a Job Description and AI finds the
                      keywords missing from your resume.
                    </p>
                    <div className="panel-actions">
                      <button className="btn" onClick={() => setWorkflowMode("manual")}>Manual</button>
                      <button className="btn primary" onClick={() => setWorkflowMode("automatic")}>Automatic</button>
                    </div>
                  </>
                ) : (
                  <>
                    <h2 className="panel-title">Manual Mode</h2>
                    <p className="panel-desc">Embed keywords by hand in a few steps:</p>
                    <ol className="panel-steps">
                      <li>Click the <strong>Text tool</strong> (<Type size={13} strokeWidth={2} />) in the bottom dock.</li>
                      <li>Click anywhere on the resume to drop a text box.</li>
                      <li>Type the keyword(s) you want to embed.</li>
                      <li>Press <strong>Process</strong> to lock them in — they turn invisible.</li>
                      <li>Press <strong>Export</strong> to download the ATS-ready PDF.</li>
                    </ol>
                  </>
                )}
              </div>
            )}

            {workflowMode === "manual" && (
              <div className="panel-section">
                <div className="panel-head">
                  <h2 className="panel-title">Manual Mode</h2>
                  {isLocalDev && <button className="btn ghost btn-sm" onClick={() => setWorkflowMode("prompt")}>Change</button>}
                </div>
                <p className="panel-desc">Embed keywords by hand in a few steps:</p>
                <ol className="panel-steps">
                  <li>Click the <strong>Text tool</strong> (<Type size={13} strokeWidth={2} />) in the bottom dock.</li>
                  <li>Click anywhere on the resume to drop a text box.</li>
                  <li>Type the keyword(s) you want to embed.</li>
                  <li>Press <strong>Process</strong> to lock them in — they turn invisible.</li>
                  <li>Press <strong>Export</strong> to download the ATS-ready PDF.</li>
                </ol>
              </div>
            )}

            {workflowMode === "automatic" && !jdProcessed && (
              <div className="panel-section">
                <div className="panel-head">
                  <h2 className="panel-title">Paste Job Description</h2>
                  <button
                    className="btn ghost btn-sm"
                    onClick={() => setWorkflowMode("prompt")}
                    disabled={state === "loading"}
                  >
                    Change
                  </button>
                </div>
                <p className="panel-desc">
                  We&apos;ll find skills in the JD that are missing from your resume and
                  place them in the empty space near your Skills section.
                </p>

                {isLocalDev ? (
                  <div className="setup-box">
                    <button
                      className="btn btn-block"
                      onClick={runOllamaSetup}
                      disabled={setupRunning}
                    >
                      {setupRunning ? (
                        <><Loader2 size={15} className="spin" strokeWidth={2} /> Setting up…</>
                      ) : (
                        <><Download size={15} strokeWidth={2} /> Set up Automatic Mode</>
                      )}
                    </button>
                    <small>Installs Ollama (if needed) &amp; downloads the AI model. One-time.</small>
                    {setupLog && <pre className="setup-log">{setupLog}</pre>}
                  </div>
                ) : (
                  <div className="setup-box notice">
                    <strong>Automatic mode needs a local AI.</strong>
                    <span>
                      It runs Ollama on your own computer, so this hosted site can&apos;t do it
                      for you. To use it, clone &amp; run the project locally (there&apos;s a
                      one-click setup button), or run Ollama yourself. <strong>Manual mode
                      works fully here.</strong>
                    </span>
                  </div>
                )}

                <textarea
                  className="jd-input"
                  placeholder="Paste the job description here..."
                  value={jdText}
                  onChange={(e) => setJdText(e.target.value)}
                  disabled={state === "loading"}
                />
                <button
                  className="btn primary btn-block"
                  onClick={analyzeAndEmbed}
                  disabled={!jdText.trim() || state === "loading"}
                >
                  {state === "loading" ? (
                    <>
                      <Loader2 size={16} className="spin" strokeWidth={2} /> Analyzing…
                    </>
                  ) : (
                    "Analyze & Embed"
                  )}
                </button>
                {state === "loading" && (
                  <div className="progress-note">
                    <div className="progress-bar">
                      <span />
                    </div>
                    <p>{message || "Analyzing with local AI…"}</p>
                    <small>Runs entirely on your machine — this may take a few seconds.</small>
                  </div>
                )}
              </div>
            )}

            {workflowMode === "automatic" && jdProcessed && (
              <div className="panel-section">
                <div className="panel-head">
                  <h2 className="panel-title">Embedded Keywords</h2>
                  <button className="btn ghost btn-sm" onClick={() => setJdProcessed(false)}>New JD</button>
                </div>
                {embeddedKeywords.some((kw) => insertions.some((ins) => ins.id === kw.id)) ? (
                  <>
                    <p className="panel-desc">
                      Added near your Skills section. Remove any you don&apos;t want, then
                      press <strong>Export</strong>.
                    </p>
                    <div className="keyword-list">
                      {embeddedKeywords.map((kw) => {
                        if (!insertions.some((ins) => ins.id === kw.id)) return null;
                        return (
                          <div key={kw.id} className="keyword-chip">
                            <span>{kw.word}</span>
                            <button
                              className="btn icon-only btn-xs"
                              onClick={() => removeInsertion(kw.id)}
                              aria-label={`Remove ${kw.word}`}
                            >
                              <X size={12} />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </>
                ) : (
                  <p className="panel-desc">No new keywords were found in that job description.</p>
                )}
              </div>
            )}
          </aside>

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

          {apiSettingsOpen && (
            <div style={{position: 'absolute', zIndex: 100, top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center'}}>
              <div className="glass-panel" style={{padding: '2rem', display: 'flex', flexDirection: 'column', gap: '1rem', width: '90%', maxWidth: '400px'}}>
                <h2 style={{margin: 0, fontSize: '1.25rem'}}>Local Model Settings</h2>
                <p style={{margin: 0, fontSize: '0.875rem', color: 'var(--text-muted)'}}>
                  Enter the name of your local Ollama model. Fast, small options: "qwen2.5:1.5b", "llama3.2:1b", "qwen2.5:0.5b". Ensure Ollama is running with CORS enabled.
                </p>
                <input
                  type="text"
                  className="insertion-input"
                  style={{padding: '0.5rem', borderRadius: '4px', border: '1px solid var(--border)', background: 'var(--bg)'}}
                  placeholder="qwen2.5:1.5b"
                  value={ollamaModel}
                  onChange={(e) => {
                    setOllamaModel(e.target.value);
                    localStorage.setItem("ollama_model", e.target.value);
                  }}
                />
                <div style={{display: 'flex', justifyContent: 'flex-end', marginTop: '0.5rem'}}>
                  <button className="btn primary" onClick={() => setApiSettingsOpen(false)}>Done</button>
                </div>
              </div>
            </div>
          )}
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

// Normalized (0..1, origin at top-left) rectangle used for placement checks.
type LayoutRect = { left: number; top: number; right: number; bottom: number };

/**
 * Finds positions for auto-embedded keywords that (a) sit in empty space where
 * no existing text lives, and (b) are located in or just below the Skills
 * section. Falls back to the top of the first page if no Skills heading is found.
 */
async function findKeywordPlacements(
  pdfDoc: PDFDocumentProxy,
  words: string[],
  fontSize: number,
): Promise<TextInsertion[]> {
  const pages: { width: number; height: number; rects: LayoutRect[] }[] = [];
  let skillsPage = -1;
  let skillsTop = 0;

  for (let i = 1; i <= pdfDoc.numPages; i += 1) {
    const page = await pdfDoc.getPage(i);
    const viewport = page.getViewport({ scale: 1 });
    const width = viewport.width;
    const height = viewport.height;
    const content = await page.getTextContent();
    const rects: LayoutRect[] = [];

    for (const item of content.items as any[]) {
      if (typeof item.str !== "string" || item.str.trim().length === 0) {
        continue;
      }

      const x = Number(item.transform[4]);
      const y = Number(item.transform[5]);
      const w = Number(item.width) || 0;
      const h = Math.max(Number(item.height) || Number(item.transform[3]) || 8, 4);
      const rect: LayoutRect = {
        left: x / width,
        right: (x + w) / width,
        top: (height - (y + h)) / height,
        bottom: (height - y) / height,
      };
      rects.push(rect);

      // Match a standalone Skills section heading (e.g. "SKILLS",
      // "Technical Skills") — not phrases like "Technologies / Skills Used:".
      if (skillsPage === -1 && /^(technical\s+|core\s+|key\s+)?skills?(\s*&\s*tools)?$/i.test(item.str.trim())) {
        skillsPage = i - 1;
        skillsTop = rect.top;
      }
    }

    pages.push({ width, height, rects });
    page.cleanup();
  }

  const targetPage = skillsPage === -1 ? 0 : skillsPage;
  const { width, height, rects } = pages[targetPage];
  const startY = skillsPage === -1 ? 0.06 : Math.min(skillsTop + 0.005, 0.97);

  const boxHeight = Math.max((fontSize * 1.25) / height, 0.02);
  const pad = 0.004;
  const occupied: LayoutRect[] = [...rects];
  const results: TextInsertion[] = [];
  let fallbackY = startY;

  const isFree = (box: LayoutRect) =>
    box.right <= 0.98 &&
    box.bottom <= 0.98 &&
    !occupied.some(
      (r) =>
        box.left < r.right + pad &&
        box.right > r.left - pad &&
        box.top < r.bottom + pad &&
        box.bottom > r.top - pad,
    );

  const push = (word: string, x: number, y: number, boxWidth: number) => {
    const rect: LayoutRect = { left: x, top: y, right: x + boxWidth, bottom: y + boxHeight };
    occupied.push(rect);
    results.push({
      id: crypto.randomUUID(),
      pageIndex: targetPage,
      x,
      y,
      width: boxWidth,
      height: boxHeight,
      text: word,
      fontSize,
      status: "draft",
    });
  };

  for (const word of words) {
    // Rough Helvetica width estimate for the keyword, with slack so the text
    // stays on one line and isn't clipped.
    const boxWidth = Math.min(0.9, Math.max(0.08, ((word.length + 2) * fontSize * 0.6) / width));
    let placed = false;

    for (let py = startY; py <= 0.98 - boxHeight && !placed; py += boxHeight * 0.6) {
      for (let px = 0.03; px <= 0.98 - boxWidth && !placed; px += 0.02) {
        const box: LayoutRect = { left: px, top: py, right: px + boxWidth, bottom: py + boxHeight };
        if (isFree(box)) {
          push(word, px, py, boxWidth);
          placed = true;
        }
      }
    }

    if (!placed) {
      // No free gap near Skills — stack downward as a last resort.
      push(word, 0.03, Math.min(0.96, fallbackY), boxWidth);
      fallbackY += boxHeight * 1.3;
    }
  }

  return results;
}
