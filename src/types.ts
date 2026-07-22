export interface User {
  userId: string;
  name: string;
  email: string;
  role: 'user' | 'admin';
  status: 'active' | 'suspended';
  createdAt: string;
  avatarUrl?: string;
  freeTrialUntil?: string; // ISO Date String
  subscriptionStatus?: 'active' | 'inactive' | 'expired';
  subscriptionPlan?: 'monthly' | 'yearly' | 'none';
  subscriptionCurrentPeriodEnd?: string; // ISO Date String — fim do período pago (assinatura via Mercado Pago)
  scanLimitExempt?: boolean; // concedido pelo admin: ignora o limite de 1+1 scans do trial, mesmo sem assinatura
  trialPrescriptionScansUsed?: number; // quantos scans de receita já foram usados durante o trial
  trialReceiptScansUsed?: number; // quantos scans de nota fiscal já foram usados durante o trial
}

export interface Medicado {
  medicadoId: string;
  userId: string;
  name: string;
  birthDate?: string;
  relationship: string;
  photoUrl?: string;
  createdAt: string;
}

export interface Receita {
  receitaId: string;
  medicadoId: string;
  userId: string;
  date: string;
  doctorName?: string;
  imageUrl?: string;
  notes?: string;
  extracted: boolean;
  createdAt: string;
}

export type MedicineCategory = 'pill' | 'syrup' | 'drop' | 'cream' | 'injection' | 'other';

export interface Medicamento {
  medicamentoId: string;
  receitaId: string;
  medicadoId: string;
  userId: string;
  name: string;
  dosage: string;
  intervalHours: number;
  durationDays: number;
  instructions?: string;
  category: MedicineCategory;
  pharmacyId?: string;
  status: 'active' | 'completed' | 'paused';
  reminderOffset?: number; // Offset in minutes
  pricePlaceholder?: number; // Mock price for purchase checkout
  createdAt: string;
}

export interface DoseLog {
  logId: string;
  medicamentoId: string;
  medicadoId: string;
  userId: string;
  plannedTime: string; // ISO string
  takenTime: string; // ISO string
  status: 'taken' | 'missed' | 'skipped';
}

export interface Consulta {
  consultaId: string;
  userId: string;
  medicadoId: string;
  doctorName: string;
  specialty?: string;
  dateTime: string; // ISO string
  location?: string;
  notes?: string;
  createdAt: string;
}

export interface Farmacia {
  farmaciaId: string;
  userId: string;
  name: string;
  address?: string;
  phone?: string;
  isFavorite?: boolean;
}

export interface CupomFiscal {
  cupomId: string;
  userId: string;
  establishment: string;
  date: string;
  items: { name: string; price: number }[];
  totalPrice: number;
  createdAt: string;
}

// ==========================================
// ADMIN AUDIT LOGS
// ==========================================

export interface ActionLog {
  logId: string;
  actorId: string;
  actorName: string;
  actorEmail: string;
  action: 'update' | 'delete';
  entityType: string;
  entityId: string;
  entityLabel: string;
  page: string;
  createdAt: string;
}

export interface LoginLog {
  logId: string;
  userId: string;
  userName: string;
  userEmail: string;
  ip: string;
  userAgent?: string;
  createdAt: string;
}

export interface ErrorLog {
  errorLogId: string;
  action: string;
  message: string;
  stack?: string;
  userId?: string;
  createdAt: string;
}

