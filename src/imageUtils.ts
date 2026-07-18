// Shared client-side image guardrails for every user-uploaded photo (profile
// avatar, patient photo). Images are stored as base64 data URLs inside
// localStorage AND Firestore docs, so an unbounded multi-MB upload can blow the
// localStorage quota (stalling the app's synchronous cache reads) and push a
// Firestore doc past its 1MB limit. Always run uploads through here: validate
// the type/size, then downscale + re-encode so what we persist stays small.

export const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
export const MAX_UPLOAD_BYTES = 500 * 1024; // reject the raw file above 500KB
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
    return { ok: false, error: "Formato inválido. Envie uma imagem JPEG, PNG ou WEBP." };
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return { ok: false, error: "Imagem muito grande. O tamanho máximo permitido é 500KB." };
  }
  try {
    const dataUrl: string = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(new Error("Não foi possível ler o arquivo selecionado."));
      reader.readAsDataURL(file);
    });
    const resized = await resizeImageDataUrl(dataUrl);
    return { ok: true, dataUrl: resized };
  } catch (err: any) {
    return { ok: false, error: err?.message || "Não foi possível processar a imagem selecionada." };
  }
}
