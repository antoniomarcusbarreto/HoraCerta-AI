// Cliente HTTP do compartilhamento entre cuidadores.
//
// Todo o ciclo do convite (criar, aceitar, revogar) passa pelo servidor, nunca
// pelo Firestore direto: firestore.rules dá escrita ZERO ao cliente na coleção
// `shares`, porque aceitar um convite propaga listas de acesso pela subárvore
// inteira do paciente — só o Admin SDK faz isso de forma atômica.
//
// A LEITURA dos dados compartilhados, essa sim, continua indo direto ao
// Firestore (ver getShared* em firebase.ts). É o que preserva o offline-first
// para quem recebeu o acesso: o convidado não fica dependendo do servidor para
// abrir o app.

import { auth } from "./firebase";
import { Share, ShareRole } from "./types";

export const SHARE_ROLE_LABELS: Record<ShareRole, string> = {
  coadministrador: "Coadministrador",
  acompanhante: "Acompanhante",
};

export const SHARE_ROLE_DESCRIPTIONS: Record<ShareRole, string> = {
  coadministrador: "Registra doses e cuida dos medicamentos, receitas e consultas.",
  acompanhante: "Acompanha a adesão ao tratamento, sem alterar nada.",
};

// O papel de quem está olhando, para UM paciente.
export type MedicadoRole = "titular" | ShareRole;

async function authedJson<T>(path: string, init?: RequestInit): Promise<T> {
  const current = auth.currentUser;
  if (!current) throw new Error("Sessão expirada. Faça login novamente.");
  const token = await current.getIdToken();

  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init?.headers || {}),
    },
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as any)?.error || `Falha na requisição (${res.status}).`);
  }
  return data as T;
}

export interface SharesResponse {
  asOwner: Share[];
  asGrantee: Share[];
}

export async function listShares(): Promise<SharesResponse> {
  return authedJson<SharesResponse>("/api/shares");
}

export async function createShare(params: {
  medicadoId: string;
  granteeEmail: string;
  role: ShareRole;
}): Promise<{ share: Share; emailSent: boolean; emailError?: string }> {
  return authedJson("/api/shares", { method: "POST", body: JSON.stringify(params) });
}

export async function acceptShare(shareId: string): Promise<{ success: boolean }> {
  return authedJson(`/api/shares/${encodeURIComponent(shareId)}/accept`, { method: "POST" });
}

// Serve tanto para o titular revogar quanto para o convidado sair ou recusar.
export async function revokeShare(shareId: string): Promise<{ success: boolean }> {
  return authedJson(`/api/shares/${encodeURIComponent(shareId)}`, { method: "DELETE" });
}

// O papel do usuário atual sobre um paciente, derivado das listas gravadas no
// próprio documento — a mesma fonte que firestore.rules consulta, então a UI
// nunca oferece uma ação que o servidor vai recusar.
export function roleForMedicado(
  medicado: { userId: string; memberUids?: string[]; editorUids?: string[] } | undefined,
  myUid: string,
): MedicadoRole | null {
  if (!medicado) return null;
  if (medicado.userId === myUid) return "titular";
  if (medicado.editorUids?.includes(myUid)) return "coadministrador";
  if (medicado.memberUids?.includes(myUid)) return "acompanhante";
  return null;
}

export function canEditMedicado(
  medicado: { userId: string; memberUids?: string[]; editorUids?: string[] } | undefined,
  myUid: string,
): boolean {
  const role = roleForMedicado(medicado, myUid);
  return role === "titular" || role === "coadministrador";
}
