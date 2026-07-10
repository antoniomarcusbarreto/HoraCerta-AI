import express from "express";
import path from "path";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";

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

async function startServer() {
  const app = express();
  const PORT = 3000;

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

  // AI Prescription Reading Endpoint
  app.post("/api/gemini/extract", async (req, res) => {
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
  app.post("/api/gemini/extract-receipt", async (req, res) => {
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
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
    console.log("Vite development middleware mounted.");
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
    console.log("Static files served in production mode.");
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`HoraCertaAI Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
