// Dev / Cloud Run entry point (long-running Node process). It builds the shared
// API app (server/app.ts) and additionally serves the frontend — Vite dev
// middleware in development, static dist/ in production — then binds a port.
//
// On Vercel the API is served by api/index.ts (which imports the SAME
// createApiApp()) and the frontend is served by Vercel's static CDN, so this
// file's listen()/scheduler are NOT used there.

import express from "express";
import path from "path";
import { createApiApp, dispatchDueReminders, dispatchMissedDoseAlerts, pushEnabled } from "./server/app";

async function startServer() {
  const app = createApiApp();
  // Bind to the platform-provided port on all interfaces (Cloud Run requires
  // 0.0.0.0 + $PORT for its health check); default to 3000 locally.
  const PORT = Number(process.env.PORT) || 3000;

  // ==========================================
  // VITE DEVELOPMENT OR PRODUCTION MIDDLEWARE
  // ==========================================

  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const fs = await import("fs/promises");
    // appType "custom" disables Vite's built-in single-entry HTML fallback —
    // we serve app/index.html under /app and index.html (landing) everywhere
    // else ourselves, mirroring the production routing below.
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "custom",
    });
    app.use(vite.middlewares);

    app.get(["/app", "/app/*"], async (req, res, next) => {
      try {
        const raw = await fs.readFile(path.join(process.cwd(), "app", "index.html"), "utf-8");
        const html = await vite.transformIndexHtml(req.originalUrl, raw);
        res.status(200).set({ "Content-Type": "text/html" }).end(html);
      } catch (err) {
        vite.ssrFixStacktrace(err as Error);
        next(err);
      }
    });

    app.get("*", async (req, res, next) => {
      try {
        const raw = await fs.readFile(path.join(process.cwd(), "index.html"), "utf-8");
        const html = await vite.transformIndexHtml(req.originalUrl, raw);
        res.status(200).set({ "Content-Type": "text/html" }).end(html);
      } catch (err) {
        vite.ssrFixStacktrace(err as Error);
        next(err);
      }
    });

    console.log("Vite development middleware mounted.");
  } else {
    const distPath = path.join(process.cwd(), "dist");
    // Mesma política de cache do vercel.json (ver comentários lá): sw.js,
    // version.json e HTML precisam ser revalidados para que um deploy novo
    // chegue ao usuário; os assets têm hash no nome e podem ser imutáveis.
    app.use(
      express.static(distPath, {
        setHeaders: (res, filePath) => {
          if (filePath.endsWith("version.json")) {
            res.setHeader("Cache-Control", "no-store, max-age=0");
          } else if (filePath.endsWith("sw.js") || filePath.endsWith(".html")) {
            res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
          } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
            res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          }
        },
      })
    );
    // The React app (login, dashboard, admin, etc.) lives under /app; the
    // static marketing landing page owns everything else, including "/".
    app.get(["/app", "/app/*"], (req, res) => {
      res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
      res.sendFile(path.join(distPath, "app", "index.html"));
    });
    app.get("*", (req, res) => {
      res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
      res.sendFile(path.join(distPath, "index.html"));
    });
    console.log("Static files served in production mode.");
  }

  // In-process reminder scheduler for long-running Node deploys (dev, npm
  // start, Cloud Run). On serverless (Vercel) set ENABLE_PUSH_SCHEDULER=false
  // and drive POST /api/push/dispatch from Vercel Cron instead.
  if (pushEnabled && process.env.ENABLE_PUSH_SCHEDULER !== "false") {
    setInterval(() => {
      dispatchDueReminders().catch((e) =>
        console.warn("Scheduler dispatch falhou:", e?.message || e)
      );
      // Independente do lembrete comum, pelo mesmo motivo do endpoint de cron:
      // uma falha aqui não pode calar o lembrete principal.
      dispatchMissedDoseAlerts().catch((e) =>
        console.warn("Scheduler dose perdida falhou:", e?.message || e)
      );
    }, 60_000);
    console.log("Push scheduler ativo (dispatch a cada 60s).");
  } else if (!pushEnabled) {
    console.log("Web Push desativado (VAPID_PUBLIC_KEY/PRIVATE_KEY ausentes).");
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`HoraCertaAI Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
