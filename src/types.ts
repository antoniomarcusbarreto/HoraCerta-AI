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
  scanLimitExempt?: boolean; // concedido pelo admin: ignora o limite de scans do trial (TRIAL_SCAN_LIMIT por tipo), mesmo sem assinatura
  trialPrescriptionScansUsed?: number; // quantos scans de receita já foram usados durante o trial
  trialReceiptScansUsed?: number; // quantos scans de nota fiscal já foram usados durante o trial
}

// Compartilhamento de um medicado entre cuidadores (ver interface Share).
// Estas duas listas são gravadas EXCLUSIVAMENTE pelo servidor, no aceite e na
// revogação do convite, e replicadas em toda a subárvore daquele medicado.
//
// O TITULAR não entra nelas: o acesso dele continua vindo do caminho
// (`users/{userId}/...`). É justamente por isso que os documentos que já
// existem, sem estes campos, seguem funcionando sem nenhuma migração — e que o
// convidado consegue achar o que lhe foi compartilhado com uma única consulta
// `collectionGroup(...).where('memberUids', 'array-contains', uid)`.
export interface SharedAccess {
  memberUids?: string[]; // quem enxerga (coadministradores + acompanhantes)
  editorUids?: string[]; // subconjunto de memberUids que também escreve
}

export interface Medicado extends SharedAccess {
  medicadoId: string;
  userId: string;
  name: string;
  birthDate?: string;
  relationship: string;
  photoUrl?: string;
  createdAt: string;
}

export interface Receita extends SharedAccess {
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

export interface Medicamento extends SharedAccess {
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

export interface DoseLog extends SharedAccess {
  logId: string;
  medicamentoId: string;
  medicadoId: string;
  userId: string; // titular da conta (dono da árvore), NÃO quem registrou
  plannedTime: string; // ISO string
  takenTime: string; // ISO string
  status: 'taken' | 'missed' | 'skipped';
  // Quem de fato marcou a dose. Sem isto, um medicado com mais de um cuidador
  // não consegue responder "o cuidador deu o remédio das 14h?" — que é a
  // pergunta inteira da feature. As regras forçam este campo a ser igual ao uid
  // autenticado, então não é falsificável pelo cliente. Opcional porque os
  // registros anteriores ao compartilhamento não têm ator conhecido.
  registradoPor?: string;
}

export interface Consulta extends SharedAccess {
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
// COMPARTILHAMENTO ENTRE CUIDADORES
// ==========================================

// Farmacia e CupomFiscal NÃO recebem SharedAccess de propósito: são da conta,
// não do paciente. Compartilhar o acompanhamento de um medicado não pode expor
// a lista de farmácias nem quanto o titular gasta com saúde.

export type ShareRole =
  | 'coadministrador' // registra doses, cria e edita medicamentos/receitas/consultas
  | 'acompanhante';   // só leitura + notificações de adesão

export type ShareStatus = 'pending' | 'accepted' | 'revoked';

// Um convite de acesso a UM medicado — nunca à conta inteira. O escopo por
// paciente é o que permite o cuidador contratado enxergar o idoso sem enxergar
// os outros pacientes do titular.
export interface Share {
  shareId: string;
  ownerUid: string;
  ownerName: string;
  medicadoId: string;
  // Guardado fora da árvore do titular para que o convidado saiba de quem vai
  // cuidar ANTES de aceitar. O documento só é legível pelo titular e pelo
  // próprio convidado.
  medicadoName: string;
  granteeEmail: string;
  granteeUid?: string; // resolvido no aceite
  role: ShareRole;
  status: ShareStatus;
  createdAt: string;
  acceptedAt?: string;
  revokedAt?: string;
  expiresAt?: string; // convite pendente expira (alimenta o TTL do Firestore)
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
  // Diff legível dos campos alterados/removidos. Para entidades de saúde
  // (ver HEALTH_ENTITY_TYPES em App.tsx) só lista os NOMES dos campos, nunca
  // valores — mesma minimização já aplicada ao entityLabel.
  changesSummary?: string;
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
  statusCode?: number;
  details?: Record<string, string | number | boolean>;
  createdAt: string;
}

// Um pagamento aprovado, gravado em users/{uid}/payments/{paymentId} pelo
// servidor (Admin SDK) quando o Mercado Pago confirma. Só é lido através de
// GET /api/admin/payments — a subcoleção não tem regra no firestore.rules,
// então permanece inacessível ao SDK cliente de propósito.
//
// ATENÇÃO: `amount` é o valor BRUTO cobrado (PLANS[plan].amount), não o
// líquido depois da taxa do Mercado Pago. Qualquer exibição precisa deixar
// isso explícito para não passar por faturamento recebido.
export interface PaymentRecord {
  paymentId: string;
  userId: string;
  // Resolvidos no servidor a partir do doc do usuário (o registro de
  // pagamento em si não guarda identidade).
  userName?: string;
  userEmail?: string;
  plan: 'monthly' | 'yearly';
  amount: number;
  paymentMethod?: string; // "pix", "credit_card", ... — ausente em registros antigos
  status: string;
  periodEnd?: string;
  createdAt: string;
}

