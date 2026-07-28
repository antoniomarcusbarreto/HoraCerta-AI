// ==========================================
// LÓGICA DE ASSINATURA (fonte única da verdade)
// ==========================================
// Módulo puro (sem dependências de runtime além dos tipos) para ser
// reutilizado tanto no cliente (React) quanto no servidor (server.ts /
// esbuild). Toda decisão de acesso é derivada AO VIVO das datas do doc do
// usuário — não há job agendado que "vira" o estado.

import type { User } from "./types";

/** Dias de teste gratuito concedidos no cadastro. */
export const TRIAL_DAYS = 7;

/** Dias de bônus (carência) após o fim do período pago antes do bloqueio. */
export const GRACE_DAYS = 2;

export type PlanId = "monthly" | "yearly";

/**
 * Definição central dos planos. O PREÇO é fonte da verdade do servidor —
 * o cliente usa `amount`/`label` apenas para exibição, e o servidor nunca
 * confia em valor vindo do cliente (revalida por `PLANS[plan].amount`).
 */
export const PLANS: Record<PlanId, { amount: number; days: number; label: string }> = {
  monthly: { amount: 19.9, days: 30, label: "Mensal" },
  yearly: { amount: 149.9, days: 365, label: "Anual" },
};

export type AccessState = "trial" | "active" | "grace" | "blocked";

function parseDate(value?: string): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Estado de acesso do usuário, derivado das datas do perfil.
 * Precedência: assinatura paga vigente > carência > trial > bloqueado.
 */
export function getAccessState(user: Pick<User, "freeTrialUntil" | "subscriptionCurrentPeriodEnd"> | null | undefined, now: Date = new Date()): AccessState {
  if (!user) return "blocked";

  const periodEnd = parseDate(user.subscriptionCurrentPeriodEnd);
  if (periodEnd) {
    if (now <= periodEnd) return "active";
    const graceEnd = new Date(periodEnd.getTime() + GRACE_DAYS * 24 * 60 * 60 * 1000);
    if (now <= graceEnd) return "grace";
  }

  const trialEnd = parseDate(user.freeTrialUntil);
  if (trialEnd && now <= trialEnd) return "trial";

  return "blocked";
}

/** Cada usuário sem assinatura paga tem direito a 1 scan de cada tipo durante o trial. */
export const TRIAL_SCAN_LIMIT = 1;

export type ScanType = "prescription" | "receipt";

type ScanLimitFields = Pick<
  User,
  "freeTrialUntil" | "subscriptionCurrentPeriodEnd" | "scanLimitExempt" | "trialPrescriptionScansUsed" | "trialReceiptScansUsed"
>;

/**
 * Protege a cota do Gemini: durante o trial, cada usuário só pode realizar
 * TRIAL_SCAN_LIMIT scans de cada tipo (vitalício, não reseta). Assinatura ativa
 * ou carência (usuário que já pagou antes) seguem ilimitados — só o trial
 * inicial é limitado. Um admin pode isentar um usuário específico via
 * `scanLimitExempt`, independente de ele ter ou não assinatura.
 */
export function canPerformScan(user: ScanLimitFields | null | undefined, scanType: ScanType, now: Date = new Date()): boolean {
  const state = getAccessState(user, now);
  if (state === "blocked") return false;
  if (state === "active" || state === "grace") return true;
  if (user?.scanLimitExempt) return true;
  const used = scanType === "prescription" ? (user?.trialPrescriptionScansUsed || 0) : (user?.trialReceiptScansUsed || 0);
  return used < TRIAL_SCAN_LIMIT;
}

/** Dias inteiros restantes até uma data ISO (0 se já passou / ausente). */
export function daysRemaining(iso: string | undefined, now: Date = new Date()): number {
  const d = parseDate(iso);
  if (!d) return 0;
  return Math.max(0, Math.ceil((d.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)));
}
