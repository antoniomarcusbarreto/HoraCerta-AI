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
