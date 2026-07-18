import { Medicamento, DoseLog } from "../types";

export const getDoseTimesForMedOnDate = (med: Medicamento, targetDate: Date): string[] => {
  const times: string[] = [];
  const createdAt = new Date(med.createdAt || new Date().toISOString());
  const intervalHours = med.intervalHours || 8;
  const durationDays = med.durationDays || 7;

  // Total duration in milliseconds
  const durationMs = durationDays * 24 * 60 * 60 * 1000;
  const startMs = createdAt.getTime();
  const endMs = startMs + durationMs;

  const targetYear = targetDate.getFullYear();
  const targetMonth = targetDate.getMonth();
  const targetDay = targetDate.getDate();

  // Generate dose times starting from createdAt, adding intervalHours
  let currentMs = startMs;
  while (currentMs < endMs) {
    const d = new Date(currentMs);
    if (
      d.getFullYear() === targetYear &&
      d.getMonth() === targetMonth &&
      d.getDate() === targetDay
    ) {
      const hr = String(d.getHours()).padStart(2, "0");
      const min = String(d.getMinutes()).padStart(2, "0");
      times.push(`${hr}:${min}`);
    }
    currentMs += intervalHours * 60 * 60 * 1000;
  }
  return times;
};

export const isMedActiveOnDay = (med: Medicamento, date: Date): boolean => {
  if (med.status !== "active") return false;

  const createdDate = new Date(med.createdAt || new Date().toISOString());
  const startDate = new Date(createdDate.getFullYear(), createdDate.getMonth(), createdDate.getDate());

  const endDate = new Date(startDate);
  endDate.setDate(startDate.getDate() + (med.durationDays || 7));

  const targetDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  return targetDate >= startDate && targetDate <= endDate;
};

export const isDoseTaken = (
  doseLogs: DoseLog[],
  medicamentoId: string,
  date: Date,
  time: string
): boolean => {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const datePrefix = `${yyyy}-${mm}-${dd}`;

  return doseLogs.some(
    (l) => l.medicamentoId === medicamentoId && l.plannedTime.includes(`${datePrefix}T${time}`)
  );
};

// ==========================================
// LEMBRETE (fonte única de verdade — cliente + servidor)
// ==========================================
// As funções acima são para a UI de calendário (por horário LOCAL). A `dueDoseMs`
// abaixo decide o MOMENTO DE NOTIFICAR e é compartilhada entre o poller in-app
// (App.tsx) e o dispatcher de Web Push (server/app.ts): ambos comparam instantes
// ABSOLUTOS, então concordam independente do fuso/onde o código roda. Antes cada
// lado tinha lógica própria e podia divergir na virada do dia.

// Aceita `createdAt` como string ISO (cliente) ou Firestore Timestamp
// (`{ toDate() }`, no servidor via Admin SDK).
function toStartMs(createdAt: any): number {
  if (createdAt && typeof createdAt.toDate === "function") {
    return createdAt.toDate().getTime();
  }
  return new Date(createdAt).getTime();
}

export interface DoseScheduleInput {
  createdAt?: any;
  intervalHours?: number;
  durationDays?: number;
  reminderOffset?: number;
}

/**
 * Qual dose (se houver) deste medicamento tem o MOMENTO DE AVISAR (horário da
 * dose menos `reminderOffset` minutos) dentro do minuto atual de `nowMs`?
 * Retorna o instante (ms) da dose, ou null. Timezone-independente.
 */
export function dueDoseMs(med: DoseScheduleInput, nowMs: number): number | null {
  const startMs = toStartMs(med.createdAt);
  if (!Number.isFinite(startMs)) return null;

  const intervalHours = Number(med.intervalHours) || 8;
  const durationDays = Number(med.durationDays) || 7;
  const offsetMin = Number(med.reminderOffset) || 0;

  const intervalMs = intervalHours * 3600_000;
  const endMs = startMs + durationDays * 24 * 3600_000;
  const offsetMs = offsetMin * 60_000;
  const currentMinute = Math.floor(nowMs / 60_000);

  // notifyInstant(k) = startMs + k*intervalMs - offsetMs. Resolve o k próximo de
  // "agora" e testa ele e os vizinhos (protege arredondamento na borda do minuto).
  const approxK = Math.round((nowMs + offsetMs - startMs) / intervalMs);
  for (const k of [approxK - 1, approxK, approxK + 1]) {
    if (k < 0) continue;
    const doseMs = startMs + k * intervalMs;
    if (doseMs < startMs || doseMs >= endMs) continue;
    const notifyMs = doseMs - offsetMs;
    if (Math.floor(notifyMs / 60_000) === currentMinute) return doseMs;
  }
  return null;
}
