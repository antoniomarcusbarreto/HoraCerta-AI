import { initializeApp } from "firebase/app";
import staticConfig from "../firebase-applet-config.json";
import { 
  getAuth, 
  signInWithEmailAndPassword, 
  createUserWithEmailAndPassword, 
  signOut,
  onAuthStateChanged,
  User as FirebaseUser
} from "firebase/auth";
import {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  getDocs,
  collection,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  limit,
  startAfter,
  serverTimestamp,
  Timestamp,
  QueryDocumentSnapshot,
  QueryConstraint,
  DocumentData
} from "firebase/firestore";
import {
  User,
  Medicado,
  Receita,
  Medicamento,
  DoseLog,
  Consulta,
  Farmacia,
  CupomFiscal,
  ActionLog,
  LoginLog,
  ErrorLog
} from "./types";

// Firebase Applet Config
const metaEnv = (import.meta as any).env || {};

const firebaseConfig = {
  apiKey: staticConfig?.apiKey || metaEnv.VITE_FIREBASE_API_KEY || "",
  authDomain: staticConfig?.authDomain || metaEnv.VITE_FIREBASE_AUTH_DOMAIN || "",
  projectId: staticConfig?.projectId || metaEnv.VITE_FIREBASE_PROJECT_ID || "",
  storageBucket: staticConfig?.storageBucket || metaEnv.VITE_FIREBASE_STORAGE_BUCKET || "",
  messagingSenderId: staticConfig?.messagingSenderId || metaEnv.VITE_FIREBASE_MESSAGING_SENDER_ID || "",
  appId: staticConfig?.appId || metaEnv.VITE_FIREBASE_APP_ID || "",
  firestoreDatabaseId: staticConfig?.firestoreDatabaseId || metaEnv.VITE_FIREBASE_DATABASE_ID || ""
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

// Get Named Firestore Database from config, or fallback to default
const db = firebaseConfig.firestoreDatabaseId 
  ? getFirestore(app, firebaseConfig.firestoreDatabaseId)
  : getFirestore(app);

export { app, auth, db };

// Auth error codes that mean the underlying account no longer matches this
// device's persisted session: deleted, disabled, or credentials/tokens were
// invalidated server-side (password change, revoked refresh tokens). Any of
// these must trigger a full local teardown. Anything else (offline, timeout,
// transient 5xx) must NOT — the cached session stays trusted so a legitimately
// offline user keeps working (offline-first design + no forced re-login).
const DEAD_SESSION_AUTH_CODES = new Set([
  "auth/user-disabled",
  "auth/user-not-found",
  "auth/user-token-expired",
  "auth/invalid-user-token",
  "auth/user-mismatch",
]);

export function isDeadSessionError(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  return typeof code === "string" && DEAD_SESSION_AUTH_CODES.has(code);
}

// Firestore returns `createdAt` as a Timestamp instance (server-set via
// serverTimestamp()), but every entity type declares it as `string` (ISO) —
// and once that Timestamp round-trips through dbLocalFallback's
// JSON.stringify into localStorage it becomes a plain {seconds,nanoseconds}
// object forever, silently breaking any `new Date(entity.createdAt)` call
// downstream (e.g. Schedule.tsx's active-date-range math). Normalize on read
// so every entity leaving this module always has a real ISO string.
// Um documento criado dentro de um paciente COMPARTILHADO precisa nascer já
// carregando as listas de acesso do medicado pai, senão ele fica invisível para
// os outros cuidadores — as regras filtram por `memberUids` e o documento novo
// não teria nenhum. As regras também exigem que estes valores sejam IDÊNTICOS
// aos do pai (inheritsShareLists), então quem chama tem de copiá-los do
// medicado, nunca inventá-los.
function applyShareLists(payload: any, entity: { memberUids?: string[]; editorUids?: string[] }): any {
  if (entity.memberUids) payload.memberUids = entity.memberUids;
  if (entity.editorUids) payload.editorUids = entity.editorUids;
  return payload;
}

function normalizeCreatedAt<T extends { createdAt?: any }>(data: T): T {
  const raw = data.createdAt;
  if (raw && typeof raw === "object" && typeof raw.toDate === "function") {
    return { ...data, createdAt: raw.toDate().toISOString() };
  }
  return data;
}

// Retenção da trilha de ações (LGPD art. 15 — os dados devem ser eliminados
// ao fim do tratamento). Os equivalentes de loginLogs/errorLogs vivem em
// server/app.ts, que é quem escreve essas duas.
const ACTION_LOG_RETENTION_DAYS = 365;

export type LogDateRange = { start?: Date; end?: Date };

// `createdAt` não tem o mesmo tipo de valor em todas as coleções de log:
// actionLogs é escrito pelo client com serverTimestamp() (Timestamp real),
// enquanto loginLogs/errorLogs são escritos pelo servidor via Admin SDK com
// `new Date().toISOString()` (string). Um filtro `where` com Timestamp contra
// um campo armazenado como string não dá erro — só nunca bate com nada,
// porque o Firestore compara por tipo. Por isso o valor do filtro precisa
// ser construído no mesmo tipo do campo de cada coleção.
function buildLogQuery(
  coll: ReturnType<typeof collection>,
  pageSize: number,
  dateRange: LogDateRange | undefined,
  createdAtType: "timestamp" | "isoString"
) {
  const toFilterValue = (d: Date) => (createdAtType === "timestamp" ? Timestamp.fromDate(d) : d.toISOString());
  const constraints: QueryConstraint[] = [orderBy("createdAt", "desc")];
  if (dateRange?.start) constraints.push(where("createdAt", ">=", toFilterValue(dateRange.start)));
  if (dateRange?.end) constraints.push(where("createdAt", "<=", toFilterValue(dateRange.end)));
  constraints.push(limit(pageSize));
  return query(coll, ...constraints);
}

// ==========================================
// FIRESTORE CRUD SERVICES
// ==========================================

export const dbFirebase = {
  // --- Users ---
  async getUser(userId: string): Promise<User | null> {
    const docRef = doc(db, "users", userId);
    const docSnap = await getDoc(docRef);
    if (docSnap.exists()) {
      return normalizeCreatedAt(docSnap.data()) as User;
    }
    return null;
  },

  async getAllUsers(): Promise<User[]> {
    const querySnapshot = await getDocs(collection(db, "users"));
    const list: User[] = [];
    querySnapshot.forEach((doc) => {
      list.push(normalizeCreatedAt(doc.data()) as User);
    });
    return list;
  },

  async createUserProfile(user: User): Promise<void> {
    const docRef = doc(db, "users", user.userId);
    // Align with firestore.rules expected properties and server-side timestamp
    const firestoreUser: any = {
      userId: user.userId,
      name: user.name,
      email: user.email.toLowerCase().trim(),
      role: user.role || "user",
      status: user.status || "active",
      createdAt: serverTimestamp() // Set server time
    };
    if (user.freeTrialUntil) firestoreUser.freeTrialUntil = user.freeTrialUntil;
    if (user.subscriptionStatus) firestoreUser.subscriptionStatus = user.subscriptionStatus;
    if (user.subscriptionPlan) firestoreUser.subscriptionPlan = user.subscriptionPlan;
    if (user.subscriptionCurrentPeriodEnd) firestoreUser.subscriptionCurrentPeriodEnd = user.subscriptionCurrentPeriodEnd;
    if (user.scanLimitExempt !== undefined) firestoreUser.scanLimitExempt = user.scanLimitExempt;
    if (user.trialPrescriptionScansUsed !== undefined) firestoreUser.trialPrescriptionScansUsed = user.trialPrescriptionScansUsed;
    if (user.trialReceiptScansUsed !== undefined) firestoreUser.trialReceiptScansUsed = user.trialReceiptScansUsed;
    if (user.avatarUrl) firestoreUser.avatarUrl = user.avatarUrl;
    await setDoc(docRef, firestoreUser);
  },

  async updateUserProfile(user: User): Promise<void> {
    const docRef = doc(db, "users", user.userId);
    const payload: any = {
      name: user.name,
      email: user.email.toLowerCase().trim(),
      role: user.role,
      status: user.status
    };
    if (user.freeTrialUntil !== undefined) payload.freeTrialUntil = user.freeTrialUntil;
    if (user.subscriptionStatus !== undefined) payload.subscriptionStatus = user.subscriptionStatus;
    if (user.subscriptionPlan !== undefined) payload.subscriptionPlan = user.subscriptionPlan;
    if (user.subscriptionCurrentPeriodEnd !== undefined) payload.subscriptionCurrentPeriodEnd = user.subscriptionCurrentPeriodEnd;
    if (user.scanLimitExempt !== undefined) payload.scanLimitExempt = user.scanLimitExempt;
    if (user.trialPrescriptionScansUsed !== undefined) payload.trialPrescriptionScansUsed = user.trialPrescriptionScansUsed;
    if (user.trialReceiptScansUsed !== undefined) payload.trialReceiptScansUsed = user.trialReceiptScansUsed;
    if (user.avatarUrl !== undefined) payload.avatarUrl = user.avatarUrl;
    await updateDoc(docRef, payload);
  },

  // Não existe deleteUserProfile: apagar o doc pelo client deixa a conta de
  // Auth funcionando e as subcoleções órfãs. Exclusão real de usuário é
  // DELETE /api/admin/users/:uid (Admin SDK + recursiveDelete + purga da
  // trilha de auditoria).

  // --- Medicados (Patients) ---
  async getMedicados(userId: string): Promise<Medicado[]> {
    const collRef = collection(db, "users", userId, "medicados");
    const querySnapshot = await getDocs(collRef);
    const list: Medicado[] = [];
    querySnapshot.forEach((doc) => {
      list.push(normalizeCreatedAt(doc.data()) as Medicado);
    });
    return list;
  },

  async saveMedicado(m: Medicado): Promise<void> {
    const docRef = doc(db, "users", m.userId, "medicados", m.medicadoId);
    const payload: any = {
      medicadoId: m.medicadoId,
      userId: m.userId,
      name: m.name,
      relationship: m.relationship,
      createdAt: serverTimestamp()
    };
    if (m.birthDate) payload.birthDate = m.birthDate;
    if (m.photoUrl) payload.photoUrl = m.photoUrl;

    await setDoc(docRef, payload);
  },

  async updateMedicado(m: Medicado): Promise<void> {
    const docRef = doc(db, "users", m.userId, "medicados", m.medicadoId);
    const payload: any = {
      name: m.name,
      relationship: m.relationship
    };
    if (m.birthDate !== undefined) payload.birthDate = m.birthDate;
    if (m.photoUrl !== undefined) payload.photoUrl = m.photoUrl;

    await updateDoc(docRef, payload);
  },

  async deleteMedicado(userId: string, medicadoId: string): Promise<void> {
    const docRef = doc(db, "users", userId, "medicados", medicadoId);
    await deleteDoc(docRef);
  },

  // --- Receitas (Prescriptions) ---
  async getReceitas(userId: string, medicadoId: string): Promise<Receita[]> {
    const collRef = collection(db, "users", userId, "medicados", medicadoId, "receitas");
    const querySnapshot = await getDocs(collRef);
    const list: Receita[] = [];
    querySnapshot.forEach((doc) => {
      list.push(normalizeCreatedAt(doc.data()) as Receita);
    });
    return list;
  },

  async saveReceita(r: Receita): Promise<void> {
    const docRef = doc(db, "users", r.userId, "medicados", r.medicadoId, "receitas", r.receitaId);
    const payload: any = {
      receitaId: r.receitaId,
      medicadoId: r.medicadoId,
      userId: r.userId,
      date: r.date,
      extracted: r.extracted,
      createdAt: serverTimestamp()
    };
    if (r.doctorName) payload.doctorName = r.doctorName;
    if (r.imageUrl) payload.imageUrl = r.imageUrl;
    if (r.notes) payload.notes = r.notes;

    await setDoc(docRef, applyShareLists(payload, r));
  },

  async updateReceita(r: Receita): Promise<void> {
    const docRef = doc(db, "users", r.userId, "medicados", r.medicadoId, "receitas", r.receitaId);
    const payload: any = {
      date: r.date,
      extracted: r.extracted
    };
    if (r.doctorName !== undefined) payload.doctorName = r.doctorName;
    if (r.imageUrl !== undefined) payload.imageUrl = r.imageUrl;
    if (r.notes !== undefined) payload.notes = r.notes;

    await updateDoc(docRef, payload);
  },

  async deleteReceita(userId: string, medicadoId: string, receitaId: string): Promise<void> {
    const docRef = doc(db, "users", userId, "medicados", medicadoId, "receitas", receitaId);
    await deleteDoc(docRef);
  },

  // --- Medicamentos (Medicines) ---
  async getMedicamentos(userId: string, medicadoId: string): Promise<Medicamento[]> {
    const collRef = collection(db, "users", userId, "medicados", medicadoId, "medicamentos");
    const querySnapshot = await getDocs(collRef);
    const list: Medicamento[] = [];
    querySnapshot.forEach((doc) => {
      list.push(normalizeCreatedAt(doc.data()) as Medicamento);
    });
    return list;
  },

  async saveMedicamento(m: Medicamento): Promise<void> {
    const docRef = doc(db, "users", m.userId, "medicados", m.medicadoId, "medicamentos", m.medicamentoId);
    const payload: any = {
      medicamentoId: m.medicamentoId,
      receitaId: m.receitaId,
      medicadoId: m.medicadoId,
      userId: m.userId,
      name: m.name,
      dosage: m.dosage,
      intervalHours: Number(m.intervalHours),
      durationDays: Number(m.durationDays),
      status: m.status,
      createdAt: serverTimestamp()
    };
    if (m.instructions) payload.instructions = m.instructions;
    if (m.category) payload.category = m.category;
    if (m.pharmacyId) payload.pharmacyId = m.pharmacyId;
    if (m.reminderOffset !== undefined) payload.reminderOffset = Number(m.reminderOffset);
    if (m.pricePlaceholder !== undefined) payload.pricePlaceholder = Number(m.pricePlaceholder);

    await setDoc(docRef, applyShareLists(payload, m));
  },

  async updateMedicamento(m: Medicamento): Promise<void> {
    const docRef = doc(db, "users", m.userId, "medicados", m.medicadoId, "medicamentos", m.medicamentoId);
    const payload: any = {
      name: m.name,
      dosage: m.dosage,
      intervalHours: Number(m.intervalHours),
      durationDays: Number(m.durationDays),
      status: m.status
    };
    if (m.instructions !== undefined) payload.instructions = m.instructions;
    if (m.category !== undefined) payload.category = m.category;
    if (m.pharmacyId !== undefined) payload.pharmacyId = m.pharmacyId;
    if (m.reminderOffset !== undefined) payload.reminderOffset = Number(m.reminderOffset);
    if (m.pricePlaceholder !== undefined) payload.pricePlaceholder = Number(m.pricePlaceholder);

    await updateDoc(docRef, payload);
  },

  async deleteMedicamento(userId: string, medicadoId: string, medicamentoId: string): Promise<void> {
    const docRef = doc(db, "users", userId, "medicados", medicadoId, "medicamentos", medicamentoId);
    await deleteDoc(docRef);
  },

  // --- Dose Logs ---
  async getDoseLogs(userId: string, medicadoId: string, medicamentoId: string): Promise<DoseLog[]> {
    const collRef = collection(db, "users", userId, "medicados", medicadoId, "medicamentos", medicamentoId, "doseLogs");
    const querySnapshot = await getDocs(collRef);
    const list: DoseLog[] = [];
    querySnapshot.forEach((doc) => {
      list.push(doc.data() as DoseLog);
    });
    return list;
  },

  async saveDoseLog(l: DoseLog): Promise<void> {
    const docRef = doc(db, "users", l.userId, "medicados", l.medicadoId, "medicamentos", l.medicamentoId, "doseLogs", l.logId);
    const payload: any = {
      logId: l.logId,
      medicamentoId: l.medicamentoId,
      medicadoId: l.medicadoId,
      userId: l.userId,
      plannedTime: l.plannedTime,
      takenTime: l.takenTime,
      status: l.status
    };
    // Sempre o uid de QUEM ESTÁ ESCREVENDO, nunca o que veio no objeto. As
    // regras exigem `registradoPor == request.auth.uid`, então repassar o valor
    // do cache faria um cuidador ser bloqueado ao editar o registro de outro —
    // e carimbar aqui é também o que impede registrar dose em nome alheio.
    const actorUid = auth.currentUser?.uid;
    if (actorUid) payload.registradoPor = actorUid;
    await setDoc(docRef, applyShareLists(payload, l));
  },

  async updateDoseLog(l: DoseLog): Promise<void> {
    const docRef = doc(db, "users", l.userId, "medicados", l.medicadoId, "medicamentos", l.medicamentoId, "doseLogs", l.logId);
    const payload: any = {
      takenTime: l.takenTime,
      status: l.status
    };
    // Quem edita passa a ser o responsável pela afirmação — ver saveDoseLog.
    const actorUid = auth.currentUser?.uid;
    if (actorUid) payload.registradoPor = actorUid;
    await updateDoc(docRef, payload);
  },

  async deleteDoseLog(userId: string, medicadoId: string, medicamentoId: string, logId: string): Promise<void> {
    const docRef = doc(db, "users", userId, "medicados", medicadoId, "medicamentos", medicamentoId, "doseLogs", logId);
    await deleteDoc(docRef);
  },

  // --- Consultas (Appointments) ---
  async getConsultas(userId: string): Promise<Consulta[]> {
    const collRef = collection(db, "users", userId, "consultas");
    const querySnapshot = await getDocs(collRef);
    const list: Consulta[] = [];
    querySnapshot.forEach((doc) => {
      list.push(normalizeCreatedAt(doc.data()) as Consulta);
    });
    return list;
  },

  async saveConsulta(c: Consulta): Promise<void> {
    const docRef = doc(db, "users", c.userId, "consultas", c.consultaId);
    const payload: any = {
      consultaId: c.consultaId,
      userId: c.userId,
      medicadoId: c.medicadoId,
      doctorName: c.doctorName,
      dateTime: c.dateTime,
      createdAt: serverTimestamp()
    };
    if (c.specialty) payload.specialty = c.specialty;
    if (c.location) payload.location = c.location;
    if (c.notes) payload.notes = c.notes;

    await setDoc(docRef, applyShareLists(payload, c));
  },

  async updateConsulta(c: Consulta): Promise<void> {
    const docRef = doc(db, "users", c.userId, "consultas", c.consultaId);
    const payload: any = {
      medicadoId: c.medicadoId,
      doctorName: c.doctorName,
      dateTime: c.dateTime
    };
    if (c.specialty !== undefined) payload.specialty = c.specialty;
    if (c.location !== undefined) payload.location = c.location;
    if (c.notes !== undefined) payload.notes = c.notes;

    await updateDoc(docRef, payload);
  },

  async deleteConsulta(userId: string, consultaId: string): Promise<void> {
    const docRef = doc(db, "users", userId, "consultas", consultaId);
    await deleteDoc(docRef);
  },

  // --- Farmacias ---
  async getFarmacias(userId: string): Promise<Farmacia[]> {
    const collRef = collection(db, "users", userId, "farmacias");
    const querySnapshot = await getDocs(collRef);
    const list: Farmacia[] = [];
    querySnapshot.forEach((doc) => {
      list.push(doc.data() as Farmacia);
    });
    return list;
  },

  async saveFarmacia(f: Farmacia): Promise<void> {
    const docRef = doc(db, "users", f.userId, "farmacias", f.farmaciaId);
    const payload: any = {
      farmaciaId: f.farmaciaId,
      userId: f.userId,
      name: f.name
    };
    if (f.address) payload.address = f.address;
    if (f.phone) payload.phone = f.phone;
    if (f.isFavorite !== undefined) payload.isFavorite = f.isFavorite;

    await setDoc(docRef, payload);
  },

  async updateFarmacia(f: Farmacia): Promise<void> {
    const docRef = doc(db, "users", f.userId, "farmacias", f.farmaciaId);
    const payload: any = {
      name: f.name
    };
    if (f.address !== undefined) payload.address = f.address;
    if (f.phone !== undefined) payload.phone = f.phone;
    if (f.isFavorite !== undefined) payload.isFavorite = f.isFavorite;

    await updateDoc(docRef, payload);
  },

  async deleteFarmacia(userId: string, farmaciaId: string): Promise<void> {
    const docRef = doc(db, "users", userId, "farmacias", farmaciaId);
    await deleteDoc(docRef);
  },

  // --- Cupons Fiscais ---
  async getCupons(userId: string): Promise<CupomFiscal[]> {
    const collRef = collection(db, "users", userId, "cupons");
    const querySnapshot = await getDocs(collRef);
    const list: CupomFiscal[] = [];
    querySnapshot.forEach((doc) => {
      list.push(normalizeCreatedAt(doc.data()) as CupomFiscal);
    });
    return list;
  },

  async saveCupom(c: CupomFiscal): Promise<void> {
    const docRef = doc(db, "users", c.userId, "cupons", c.cupomId);
    await setDoc(docRef, {
      cupomId: c.cupomId,
      userId: c.userId,
      establishment: c.establishment,
      date: c.date,
      items: c.items || [],
      totalPrice: Number(c.totalPrice),
      createdAt: serverTimestamp()
    });
  },

  async deleteCupom(userId: string, cupomId: string): Promise<void> {
    const docRef = doc(db, "users", userId, "cupons", cupomId);
    await deleteDoc(docRef);
  },

  // --- Leitura de dados COMPARTILHADOS (árvore de outro titular) ---
  //
  // Os getters acima varrem a coleção inteira, o que só funciona para o dono.
  // Um convidado que fizesse o mesmo receberia permission-denied no primeiro
  // documento fora do seu alcance — e o Firestore reprova a consulta INTEIRA,
  // não os documentos individualmente.
  //
  // Por isso aqui todo acesso é filtrado por `array-contains`: a consulta já
  // nasce restrita ao que as regras permitem. Efeito colateral valioso — se um
  // fan-out de convite tiver ficado pela metade, os documentos ainda não
  // carimbados simplesmente não aparecem, em vez de derrubar a sincronização
  // toda com erro de permissão.
  async getSharedMedicados(ownerUid: string, myUid: string): Promise<Medicado[]> {
    const q = query(
      collection(db, "users", ownerUid, "medicados"),
      where("memberUids", "array-contains", myUid)
    );
    const snap = await getDocs(q);
    return snap.docs.map((d) => normalizeCreatedAt(d.data()) as Medicado);
  },

  async getSharedReceitas(ownerUid: string, medicadoId: string, myUid: string): Promise<Receita[]> {
    const q = query(
      collection(db, "users", ownerUid, "medicados", medicadoId, "receitas"),
      where("memberUids", "array-contains", myUid)
    );
    const snap = await getDocs(q);
    return snap.docs.map((d) => normalizeCreatedAt(d.data()) as Receita);
  },

  async getSharedMedicamentos(ownerUid: string, medicadoId: string, myUid: string): Promise<Medicamento[]> {
    const q = query(
      collection(db, "users", ownerUid, "medicados", medicadoId, "medicamentos"),
      where("memberUids", "array-contains", myUid)
    );
    const snap = await getDocs(q);
    return snap.docs.map((d) => normalizeCreatedAt(d.data()) as Medicamento);
  },

  async getSharedDoseLogs(ownerUid: string, medicadoId: string, medicamentoId: string, myUid: string): Promise<DoseLog[]> {
    const q = query(
      collection(db, "users", ownerUid, "medicados", medicadoId, "medicamentos", medicamentoId, "doseLogs"),
      where("memberUids", "array-contains", myUid)
    );
    const snap = await getDocs(q);
    return snap.docs.map((d) => d.data() as DoseLog);
  },

  async getSharedConsultas(ownerUid: string, myUid: string): Promise<Consulta[]> {
    const q = query(
      collection(db, "users", ownerUid, "consultas"),
      where("memberUids", "array-contains", myUid)
    );
    const snap = await getDocs(q);
    return snap.docs.map((d) => normalizeCreatedAt(d.data()) as Consulta);
  },

  // --- Admin Audit Logs ---
  // Escrito diretamente pelo client no momento da mutação (mesmo padrão
  // fire-and-forget do resto deste arquivo) — é o único ponto que sabe com
  // certeza quem é o ator (activeUser/activeAdminUser) e em que página a
  // ação ocorreu. Trilha imutável: firestore.rules bloqueia update/delete.
  async logAction(entry: Omit<ActionLog, "logId" | "createdAt">): Promise<void> {
    const logId = `log_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const docRef = doc(db, "actionLogs", logId);
    await setDoc(docRef, {
      logId,
      actorId: entry.actorId,
      actorName: entry.actorName,
      actorEmail: entry.actorEmail,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      entityLabel: entry.entityLabel,
      page: entry.page,
      ...(entry.changesSummary ? { changesSummary: entry.changesSummary } : {}),
      createdAt: serverTimestamp(),
      // Alimenta a política de TTL nativa do Firestore (retenção de 12 meses),
      // para a trilha não virar acúmulo indefinido de dado pessoal — LGPD
      // art. 15. Precisa da política habilitada no console; ver
      // ACTION_LOG_RETENTION_DAYS e as instruções em server/app.ts.
      expiresAt: Timestamp.fromDate(
        new Date(Date.now() + ACTION_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000)
      )
    });
  },

  async getActionLogs(
    pageSize: number = 50,
    cursor: QueryDocumentSnapshot<DocumentData> | null = null,
    dateRange?: LogDateRange
  ): Promise<{ logs: ActionLog[]; lastDoc: QueryDocumentSnapshot<DocumentData> | null }> {
    const base = buildLogQuery(collection(db, "actionLogs"), pageSize, dateRange, "timestamp");
    const q = cursor ? query(base, startAfter(cursor)) : base;
    const snapshot = await getDocs(q);
    const logs = snapshot.docs.map((d) => normalizeCreatedAt(d.data()) as ActionLog);
    return { logs, lastDoc: snapshot.docs[snapshot.docs.length - 1] || null };
  },

  // loginLogs/errorLogs são escritos exclusivamente pelo servidor via Admin
  // SDK (bypassa as regras) — aqui só é feita a leitura, liberada por isAdmin().
  async getLoginLogs(
    pageSize: number = 50,
    cursor: QueryDocumentSnapshot<DocumentData> | null = null,
    dateRange?: LogDateRange
  ): Promise<{ logs: LoginLog[]; lastDoc: QueryDocumentSnapshot<DocumentData> | null }> {
    const base = buildLogQuery(collection(db, "loginLogs"), pageSize, dateRange, "isoString");
    const q = cursor ? query(base, startAfter(cursor)) : base;
    const snapshot = await getDocs(q);
    const logs = snapshot.docs.map((d) => normalizeCreatedAt(d.data()) as LoginLog);
    return { logs, lastDoc: snapshot.docs[snapshot.docs.length - 1] || null };
  },

  async getErrorLogs(
    pageSize: number = 50,
    cursor: QueryDocumentSnapshot<DocumentData> | null = null,
    dateRange?: LogDateRange
  ): Promise<{ logs: ErrorLog[]; lastDoc: QueryDocumentSnapshot<DocumentData> | null }> {
    const base = buildLogQuery(collection(db, "errorLogs"), pageSize, dateRange, "isoString");
    const q = cursor ? query(base, startAfter(cursor)) : base;
    const snapshot = await getDocs(q);
    const logs = snapshot.docs.map((d) => normalizeCreatedAt(d.data()) as ErrorLog);
    return { logs, lastDoc: snapshot.docs[snapshot.docs.length - 1] || null };
  }
};
