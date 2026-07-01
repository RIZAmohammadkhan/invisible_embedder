import { createRequire } from "node:module";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import type { ServerResponse } from "node:http";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const OLLAMA_URL = "http://localhost:11434";
const DEFAULT_MODEL = "qwen2.5:1.5b";

/**
 * DEV-ONLY: lets the app set up Automatic mode with one click when the project
 * is run locally (`npm run dev`). The browser can't run shell commands, but this
 * Node dev server can — so it installs Ollama (if missing) and pulls the model,
 * streaming progress back to the UI. These endpoints do NOT exist in the built
 * static site, so a deployed app simply shows a "set up locally" prompt instead.
 */
function ollamaSetup(): Plugin {
  const hasBinary = () =>
    spawnSync(process.platform === "win32" ? "where" : "command", process.platform === "win32" ? ["ollama"] : ["-v", "ollama"], {
      shell: true,
    }).status === 0;

  const isRunning = async (): Promise<{ name: string }[] | null> => {
    try {
      const r = await fetch(`${OLLAMA_URL}/api/tags`);
      if (!r.ok) return null;
      const data = (await r.json()) as { models?: { name: string }[] };
      return data.models ?? [];
    } catch {
      return null;
    }
  };

  // Strip ANSI escape codes / spinner control chars so the log reads cleanly in the browser.
  const clean = (buf: Buffer) =>
    // eslint-disable-next-line no-control-regex
    buf.toString().replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\r/g, "\n");

  const runCmd = (res: ServerResponse, cmd: string) =>
    new Promise<void>((resolve, reject) => {
      const child = spawn(cmd, { shell: true, env: { ...process.env, OLLAMA_ORIGINS: "*" } });
      child.stdout.on("data", (d) => res.write(clean(d)));
      child.stderr.on("data", (d) => res.write(clean(d)));
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}`))));
    });

  return {
    name: "ollama-setup",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url?.split("?")[0] ?? "";

        if (url === "/api/ollama/status" && req.method === "GET") {
          const models = await isRunning();
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              installed: hasBinary(),
              running: models !== null,
              model: DEFAULT_MODEL,
              hasModel: (models ?? []).some((m: { name: string }) => m.name?.startsWith(DEFAULT_MODEL)),
            }),
          );
          return;
        }

        if (url === "/api/ollama/setup" && req.method === "POST") {
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.setHeader("Cache-Control", "no-cache");
          const log = (line: string) => res.write(line.endsWith("\n") ? line : line + "\n");
          try {
            log("→ Checking for Ollama...");
            if (!hasBinary()) {
              if (process.platform === "win32") {
                log("✗ Automatic install isn't supported on Windows. Install Ollama from https://ollama.com/download, then click Set up again.");
                res.end();
                return;
              }
              log("→ Ollama not found. Installing (you may be asked for your password in the terminal)...");
              await runCmd(res, "curl -fsSL https://ollama.com/install.sh | sh");
            } else {
              log("✓ Ollama is installed.");
            }

            if ((await isRunning()) === null) {
              log("→ Starting Ollama server (OLLAMA_ORIGINS=*)...");
              const srv = spawn("ollama", ["serve"], {
                detached: true,
                stdio: "ignore",
                env: { ...process.env, OLLAMA_ORIGINS: "*" },
              });
              srv.unref();
              for (let i = 0; i < 20 && (await isRunning()) === null; i += 1) {
                await new Promise((r) => setTimeout(r, 750));
              }
            }
            log("✓ Ollama server is running.");

            log(`→ Pulling model "${DEFAULT_MODEL}" (first time can take a few minutes)...`);
            await runCmd(res, `ollama pull ${DEFAULT_MODEL}`);

            log("\n✅ Done! Automatic mode is ready. Paste a Job Description below and click Analyze & Embed.");
          } catch (err) {
            log(`\n✗ Setup failed: ${(err as Error).message}`);
            log("You can set it up manually — see the README's Automatic Mode section.");
          } finally {
            res.end();
          }
          return;
        }

        next();
      });
    },
  };
}

/**
 * Serves PDF.js character maps and standard font data from the locally
 * installed pdfjs-dist package (dev middleware + copied into the build output).
 * This avoids a runtime dependency on a remote CDN, which otherwise leaves
 * pages blank when the fetch fails.
 */
function pdfjsAssets(): Plugin {
  const require = createRequire(import.meta.url);
  const base = dirname(require.resolve("pdfjs-dist/package.json"));
  const dirs = {
    cmaps: join(base, "cmaps"),
    standard_fonts: join(base, "standard_fonts"),
  } as const;

  return {
    name: "pdfjs-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split("?")[0] ?? "";
        for (const [route, dir] of Object.entries(dirs)) {
          const prefix = `/${route}/`;
          if (!url.startsWith(prefix)) continue;
          const fileName = url.slice(prefix.length);
          if (!fileName || fileName.includes("..")) break;
          try {
            res.setHeader("Content-Type", "application/octet-stream");
            res.end(readFileSync(join(dir, fileName)));
            return;
          } catch {
            break;
          }
        }
        next();
      });
    },
    generateBundle() {
      for (const [route, dir] of Object.entries(dirs)) {
        for (const fileName of readdirSync(dir)) {
          this.emitFile({
            type: "asset",
            fileName: `${route}/${fileName}`,
            source: readFileSync(join(dir, fileName)),
          });
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), pdfjsAssets(), ollamaSetup()],
});
