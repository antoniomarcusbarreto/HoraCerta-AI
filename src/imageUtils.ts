// Shared client-side image guardrails for every user-uploaded photo (profile
// avatar, patient photo). Images are stored as base64 data URLs inside
// localStorage AND Firestore docs, so an unbounded multi-MB upload can blow the
// localStorage quota (stalling the app's synchronous cache reads) and push a
// Firestore doc past its 1MB limit. Always run uploads through here: validate
// the type/size, then downscale + re-encode so what we persist stays small.

export const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
// Sanity ceiling on the ORIGINAL file, before downscaling — just high enough to
// stop someone picking a multi-dozen-MB file that would hang the tab decoding
// it. This must NOT be the size that decides "too big": real gallery photos
// straight off a phone camera are routinely 2-8MB, and the whole point of
// resizeImageDataUrl below is to shrink those down, so rejecting on the raw
// size before resize ever runs made every normal gallery photo fail.
export const MAX_RAW_UPLOAD_BYTES = 15 * 1024 * 1024;
// Safety net checked AFTER resize+re-encode, against what actually gets stored
// (Firestore doc field + localStorage). MUST stay under firestore.rules'
// isValidUser/isValidMedicado hard cap (data.avatarUrl.size() <= 500000 /
// data.photoUrl.size() <= 500000) — those two constants are not derived from
// each other (this file can't read firestore.rules), so if either changes,
// update both by hand. A real detailed photo (not a flat test image) can land
// well above 500KB at q0.85, which is why this used to be set to 700KB: that
// let the client accept photos Firestore then silently rejected as "erro no
// servidor" (500KB was margin-free, so re-check before ever raising this).
export const MAX_STORED_BYTES = 470 * 1024;
export const IMAGE_MAX_DIMENSION = 512; // downscale longest side to 512px

// Progressively smaller/lower-quality re-encodes, tried in order until one
// fits under maxBytes. Most photos succeed on the first attempt; busy/detailed
// ones (common straight off a phone camera) need the later, more aggressive
// steps instead of being rejected outright.
const RESIZE_ATTEMPTS: { dimension: number; quality: number }[] = [
  { dimension: IMAGE_MAX_DIMENSION, quality: 0.82 },
  { dimension: IMAGE_MAX_DIMENSION, quality: 0.6 },
  { dimension: 400, quality: 0.6 },
  { dimension: 320, quality: 0.5 },
];

// Downscale a data URL, re-encoding as JPEG, stepping down quality/dimension
// until the result fits under maxBytes (or the attempts run out — the last,
// smallest attempt is returned either way; processImageFile does the final check).
export function resizeImageDataUrl(dataUrl: string, maxBytes: number = MAX_STORED_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const ctx = document.createElement("canvas").getContext("2d");
      if (!ctx) {
        reject(new Error("Canvas indisponível."));
        return;
      }
      let smallest = "";
      for (const { dimension, quality } of RESIZE_ATTEMPTS) {
        const scale = Math.min(1, dimension / Math.max(img.width, img.height));
        const canvas = ctx.canvas;
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const out = canvas.toDataURL("image/jpeg", quality);
        smallest = out;
        if (out.length <= maxBytes) break;
      }
      resolve(smallest);
    };
    img.onerror = () => reject(new Error("Não foi possível processar a imagem."));
    img.src = dataUrl;
  });
}

// ==========================================
// IMAGEM ENVIADA AOS SCANNERS DE IA
// ==========================================
// Caminho diferente do avatar/foto de paciente: a foto da receita ou da nota
// não é guardada em lugar nenhum, vai no corpo de um POST para o backend. O
// teto aqui não é o documento do Firestore e sim o limite de corpo da
// plataforma — a Vercel corta a requisição por volta de 4,5 MB e o base64 ainda
// infla o binário em ~33%. Um celular atual gera 8-12 MB por foto, então sem
// esta redução o scan falharia justo para quem tem a câmera melhor.
//
// A escada começa MUITO acima de IMAGE_MAX_DIMENSION (512px) de propósito:
// naquele tamanho a posologia de uma receita fica ilegível para o modelo.
// 1600px na maior aresta preserva o texto e mantém o corpo em centenas de KB.
export const SCAN_MAX_BYTES = 3 * 1024 * 1024;
const SCAN_RESIZE_ATTEMPTS: { dimension: number; quality: number }[] = [
  { dimension: 1600, quality: 0.85 },
  { dimension: 1600, quality: 0.7 },
  { dimension: 1200, quality: 0.7 },
];

/**
 * Prepara a foto de receita/nota para envio: reduz quando necessário e devolve
 * o payload base64 (sem o prefixo `data:`) com o mimeType correspondente.
 * Nunca rejeita por formato — se o navegador não souber decodificar (HEIC fora
 * do Safari), envia o original e deixa o backend responder, que é onde a
 * allowlist de mimeType vive.
 */
export async function prepareScanImage(file: File): Promise<{ base64: string; mimeType: string }> {
  const dataUrl: string = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Não foi possível ler o arquivo selecionado."));
    reader.readAsDataURL(file);
  });

  // Já pequena o suficiente: não recodifica (evita perder nitidez à toa).
  if (dataUrl.length <= SCAN_MAX_BYTES) {
    return { base64: dataUrl.split(",")[1], mimeType: file.type || "image/jpeg" };
  }

  try {
    const resized = await new Promise<string>((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const ctx = document.createElement("canvas").getContext("2d");
        if (!ctx) {
          reject(new Error("Canvas indisponível."));
          return;
        }
        let smallest = "";
        for (const { dimension, quality } of SCAN_RESIZE_ATTEMPTS) {
          const scale = Math.min(1, dimension / Math.max(img.width, img.height));
          const canvas = ctx.canvas;
          canvas.width = Math.max(1, Math.round(img.width * scale));
          canvas.height = Math.max(1, Math.round(img.height * scale));
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          const out = canvas.toDataURL("image/jpeg", quality);
          smallest = out;
          if (out.length <= SCAN_MAX_BYTES) break;
        }
        resolve(smallest);
      };
      img.onerror = () => reject(new Error("Não foi possível processar a imagem."));
      img.src = dataUrl;
    });
    return { base64: resized.split(",")[1], mimeType: "image/jpeg" };
  } catch {
    return { base64: dataUrl.split(",")[1], mimeType: file.type || "image/jpeg" };
  }
}

export interface ProcessedImage {
  ok: boolean;
  dataUrl?: string; // present when ok
  error?: string;   // present when !ok
}

// Validate + read + downscale a picked File in one call. Never throws — returns
// a plain result object so callers can show a friendly message on failure.
export async function processImageFile(file: File): Promise<ProcessedImage> {
  if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
    // iPhones save Camera Roll photos as HEIC/HEIF by default, which most
    // browsers (everything but Safari) can't decode into <canvas> at all —
    // give a message that points at the actual fix instead of the generic one.
    if (/^image\/hei[cf]$/.test(file.type)) {
      return {
        ok: false,
        error: "Fotos em formato HEIC (padrão da câmera do iPhone) não são aceitas aqui. No app Fotos, escolha Compartilhar > Copiar ou Salvar como JPEG e tente novamente.",
      };
    }
    return { ok: false, error: "Formato inválido. Envie uma imagem JPEG, PNG ou WEBP." };
  }
  if (file.size > MAX_RAW_UPLOAD_BYTES) {
    return { ok: false, error: "Imagem muito grande para processar. Escolha uma foto de até 15MB." };
  }
  try {
    const dataUrl: string = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(new Error("Não foi possível ler o arquivo selecionado."));
      reader.readAsDataURL(file);
    });
    const resized = await resizeImageDataUrl(dataUrl);
    if (resized.length > MAX_STORED_BYTES) {
      return { ok: false, error: "Não foi possível reduzir esta imagem o suficiente. Tente outra foto." };
    }
    return { ok: true, dataUrl: resized };
  } catch (err: any) {
    return { ok: false, error: err?.message || "Não foi possível processar a imagem selecionada." };
  }
}
