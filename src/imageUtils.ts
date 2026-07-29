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
// (Firestore doc field + localStorage). A 512px JPEG at q0.85 lands well under
// this in practice; this only catches pathological inputs (e.g. huge flat-color
// PNGs) that don't shrink the way photos do.
export const MAX_STORED_BYTES = 700 * 1024;
export const IMAGE_MAX_DIMENSION = 512; // downscale longest side to 512px

// Downscale a data URL to at most IMAGE_MAX_DIMENSION on its longest side and
// re-encode as JPEG. Returns a (usually much) smaller data URL.
export function resizeImageDataUrl(dataUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, IMAGE_MAX_DIMENSION / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("Canvas indisponível."));
        return;
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => reject(new Error("Não foi possível processar a imagem."));
    img.src = dataUrl;
  });
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
