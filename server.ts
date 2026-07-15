import express from "express";
import path from "path";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";
import cors from "cors";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { initializeApp, getApps, getApp, type App } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

// dotenv.config() alone only reads ".env" — this project's docs/README tell
// users to put secrets in ".env.local" (Vite convention), so load that first.
dotenv.config({ path: ".env.local" });
dotenv.config();

// Lazily initialize Gemini to prevent crashes on startup if key is missing
let aiClient: GoogleGenAI | null = null;

function getGeminiClient(): GoogleGenAI {
  if (!aiClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY is not defined in the environment secrets.");
    }
    aiClient = new GoogleGenAI({
      apiKey: apiKey,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
  }
  return aiClient;
}

// Lazily initialize Firebase Admin so the server still boots without credentials
// configured locally. In deployed environments (Cloud Run, etc.) Application
// Default Credentials are picked up automatically.
function getAdminApp(): App {
  return getApps().length ? getApp() : initializeApp();
}

// Requires a valid Firebase ID token in the Authorization header. Rejects with
// 401 otherwise. This is the only trust boundary for the paid Gemini endpoints —
// never rely on client-supplied identity fields.
async function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const authHeader = req.headers.authorization || "";
  const [scheme, token] = authHeader.split(" ");

  if (scheme !== "Bearer" || !token) {
    res.status(401).json({ error: "Token de autenticação ausente." });
    return;
  }

  try {
    const decoded = await getAuth(getAdminApp()).verifyIdToken(token);
    (req as any).uid = decoded.uid;
    next();
  } catch (err) {
    res.status(401).json({ error: "Token de autenticação inválido ou expirado." });
  }
}

// Same as requireAuth, but additionally rejects unless the token carries the
// `admin` custom claim (see server/setAdminClaim.js). Never trust a client-
// supplied role/uid for this — the claim is the only source of truth.
async function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
  const authHeader = req.headers.authorization || "";
  const [scheme, token] = authHeader.split(" ");

  if (scheme !== "Bearer" || !token) {
    res.status(401).json({ error: "Token de autenticação ausente." });
    return;
  }

  try {
    const decoded = await getAuth(getAdminApp()).verifyIdToken(token);
    if (decoded.admin !== true) {
      res.status(403).json({ error: "Acesso negado: privilégio de administrador necessário." });
      return;
    }
    (req as any).uid = decoded.uid;
    next();
  } catch (err) {
    res.status(401).json({ error: "Token de autenticação inválido ou expirado." });
  }
}

// Caps abuse of the billed Gemini quota: 10 AI scans per authenticated user per hour.
const geminiRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: function(req) {
    const uid = (req as any).uid;
    if (uid) return uid;
    return ipKeyGenerator(req.ip || "unknown");
  },
  message: { error: "Limite de leituras por Inteligência Artificial excedido. Tente novamente mais tarde." },
});

// Caps admin-only actions: 30 requests per admin per hour.
const adminActionRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: function(req) {
    const uid = (req as any).uid;
    if (uid) return uid;
    return ipKeyGenerator(req.ip || "unknown");
  },
  message: { error: "Limite de ações administrativas excedido. Tente novamente mais tarde." },
});

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Restrict cross-origin access to the app's own deployed/dev origins.
  // Scoped to /api only — the page and its static assets are same-origin
  // loads and must never be CORS-gated, or the browser's own module/HMR
  // requests get rejected regardless of which host/IP the page is served from.
  const allowedOrigins = [
    process.env.APP_URL,
    "http://localhost:3000",
    "http://127.0.0.1:3000",
  ].filter((origin): origin is string => !!origin);
  app.use(
    "/api",
    cors({
      origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) {
          callback(null, true);
        } else {
          callback(new Error("Not allowed by CORS"));
        }
      },
    })
  );

  // Body parser with 10mb limit for base64 prescription images
  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ limit: "10mb", extended: true }));

  // ==========================================
  // API ROUTES
  // ==========================================

  // Health check
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", time: new Date().toISOString() });
  });

  // AI Key Status Check
  app.get("/api/gemini/status", (req, res) => {
    res.json({ hasKey: !!process.env.GEMINI_API_KEY });
  });

  // Admin: change another user's real Firebase Auth password. The web/client
  // SDK has no way to do this for anyone but the currently signed-in user —
  // it requires the Admin SDK, hence this server-side, claim-gated endpoint.
  app.post("/api/admin/change-user-password", requireAdmin, adminActionRateLimiter, async (req, res) => {
    try {
      const { uid, newPassword } = req.body;

      if (!uid || typeof uid !== "string") {
        res.status(400).json({ error: "Parâmetro 'uid' ausente ou inválido." });
        return;
      }
      if (!newPassword || typeof newPassword !== "string" || newPassword.length < 6) {
        res.status(400).json({ error: "A nova senha deve ter pelo menos 6 caracteres." });
        return;
      }

      await getAuth(getAdminApp()).updateUser(uid, { password: newPassword });
      res.json({ success: true });
    } catch (error: any) {
      console.error("Admin change-user-password error:", error);
      res.status(500).json({
        error: "Falha ao alterar a senha do usuário.",
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // AI Prescription Reading Endpoint
  app.post("/api/gemini/extract", requireAuth, geminiRateLimiter, async (req, res) => {
    try {
      const { imageBase64, mimeType } = req.body;

      if (!imageBase64) {
        res.status(400).json({ error: "Missing imageBase64 parameter in request body." });
        return;
      }

      const client = getGeminiClient();

      const imagePart = {
        inlineData: {
          mimeType: mimeType || "image/jpeg",
          data: imageBase64,
        },
      };

      const promptPart = {
        text: `Você é um assistente médico especialista em leitura de receitas. Analise a receita médica enviada e extraia todos os medicamentos nela prescritos de forma estruturada.
Instruções:
- Identifique o nome do medicamento.
- Identifique a dosagem (ex: "1 comprimido", "5ml", "2 gotas", "800mg").
- Identifique o intervalo de tempo em horas (ex: de 8 em 8 horas => intervalHours = 8. Uma vez ao dia => intervalHours = 24. Se não estiver claro, estime de acordo com práticas médicas seguras).
- Identifique a duração em dias (ex: por 5 dias => durationDays = 5. Uso contínuo => utilize 30 dias por padrão).
- Extraia instruções adicionais úteis (ex: "tomar após as refeições", "diluir em água").
- Categorize o medicamento estritamente em um dos seguintes tipos: "pill" (comprimido, cápsula, drágea), "syrup" (xarope, suspensão líquida), "drop" (gotas, colírio), "cream" (pomada, creme, gel), "injection" (ampola, injetável), ou "other" (outros).
- Extraia também o nome do médico (doctorName) e a data da receita (date) se visíveis.`,
      };

      const response = await client.models.generateContent({
        model: "gemini-3.5-flash",
        contents: { parts: [imagePart, promptPart] },
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              doctorName: { type: Type.STRING, description: "Nome do médico que assinou a receita." },
              date: { type: Type.STRING, description: "Data da receita médica." },
              medicines: {
                type: Type.ARRAY,
                description: "Lista de medicamentos extraídos.",
                items: {
                  type: Type.OBJECT,
                  properties: {
                    name: { type: Type.STRING, description: "Nome completo do medicamento." },
                    dosage: { type: Type.STRING, description: "Dosagem recomendada (ex: 1 comprimido, 5ml)." },
                    intervalHours: { type: Type.INTEGER, description: "Intervalo em horas (ex: de 8 em 8 horas => 8)." },
                    durationDays: { type: Type.INTEGER, description: "Duração do tratamento em dias." },
                    instructions: { type: Type.STRING, description: "Instruções adicionais de administração." },
                    category: { 
                      type: Type.STRING, 
                      description: "Categoria estrita do medicamento.",
                      enum: ["pill", "syrup", "drop", "cream", "injection", "other"]
                    }
                  },
                  required: ["name", "dosage", "intervalHours", "durationDays", "category"]
                }
              }
            },
            required: ["medicines"]
          }
        }
      });

      const extractedText = response.text;
      if (!extractedText) {
        res.status(500).json({ error: "No text returned from Gemini API." });
        return;
      }

      const parsedResult = JSON.parse(extractedText.trim());
      res.json(parsedResult);
    } catch (error: any) {
      console.error("Gemini Extraction Error:", error);
      res.status(500).json({ 
        error: "Falha ao processar receita com inteligência artificial.", 
        details: error instanceof Error ? error.message : String(error)
      });
    }
  });

  // AI Fiscal Receipt Reading Endpoint
  app.post("/api/gemini/extract-receipt", requireAuth, geminiRateLimiter, async (req, res) => {
    try {
      const { imageBase64, mimeType } = req.body;

      if (!imageBase64) {
        res.status(400).json({ error: "Missing imageBase64 parameter in request body." });
        return;
      }

      const client = getGeminiClient();

      const imagePart = {
        inlineData: {
          mimeType: mimeType || "image/jpeg",
          data: imageBase64,
        },
      };

      const promptPart = {
        text: `Você é um assistente financeiro e farmacêutico especialista em leitura de comprovantes e cupons fiscais de medicamentos. Analise a imagem da nota fiscal ou cupom de compra enviado e extraia os dados estruturados.
Instruções:
- Identifique o nome do estabelecimento (farmácia, drogaria ou loja).
- Identifique a data de compra ou emissão no formato DD/MM/AAAA.
- Extraia cada item ou medicamento comprado com seu respectivo preço unitário ou total.
- Extraia o valor total da nota fiscal (totalPrice).
Preencha os valores nulos ou faltantes com estimativas seguras se baseadas no texto visível.`,
      };

      const response = await client.models.generateContent({
        model: "gemini-3.5-flash",
        contents: { parts: [imagePart, promptPart] },
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              establishment: { type: Type.STRING, description: "Nome do estabelecimento ou farmácia." },
              date: { type: Type.STRING, description: "Data da compra no formato DD/MM/AAAA." },
              items: {
                type: Type.ARRAY,
                description: "Lista de itens ou medicamentos comprados.",
                items: {
                  type: Type.OBJECT,
                  properties: {
                    name: { type: Type.STRING, description: "Nome ou descrição do item comprado." },
                    price: { type: Type.NUMBER, description: "Preço do item em reais." }
                  },
                  required: ["name", "price"]
                }
              },
              totalPrice: { type: Type.NUMBER, description: "Preço total geral pago indicado no cupom." }
            },
            required: ["establishment", "date", "items", "totalPrice"]
          }
        }
      });

      const extractedText = response.text;
      if (!extractedText) {
        res.status(500).json({ error: "No text returned from Gemini API." });
        return;
      }

      const parsedResult = JSON.parse(extractedText.trim());
      res.json(parsedResult);
    } catch (error: any) {
      console.error("Gemini Receipt Extraction Error:", error);
      res.status(500).json({ 
        error: "Falha ao processar nota fiscal com inteligência artificial.", 
        details: error instanceof Error ? error.message : String(error)
      });
    }
  });

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
    app.use(express.static(distPath));
    // The React app (login, dashboard, admin, etc.) lives under /app; the
    // static marketing landing page owns everything else, including "/".
    app.get(["/app", "/app/*"], (req, res) => {
      res.sendFile(path.join(distPath, "app", "index.html"));
    });
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
    console.log("Static files served in production mode.");
  }

  app.listen(PORT, "127.0.0.1", () => {
    console.log(`HoraCertaAI Server running on http://127.0.0.1:${PORT}`);
  });
}

startServer();
