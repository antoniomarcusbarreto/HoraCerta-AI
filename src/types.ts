export interface User {
  userId: string;
  name: string;
  email: string;
  password?: string;
  role: 'user' | 'admin';
  status: 'active' | 'suspended';
  createdAt: string;
  avatarUrl?: string;
  freeTrialUntil?: string; // ISO Date String
  subscriptionStatus?: 'active' | 'inactive' | 'expired';
  subscriptionPlan?: 'monthly' | 'yearly' | 'none';
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

