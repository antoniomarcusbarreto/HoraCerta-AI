import { User, Medicado, Receita, Medicamento, DoseLog, Consulta, Farmacia, CupomFiscal } from "./types";
import { dbFirebase } from "./firebase";

// Helper to generate seed dates relative to today
const offsetDate = (hoursOffset: number): string => {
  const d = new Date();
  d.setHours(d.getHours() + hoursOffset);
  return d.toISOString();
};

const SEED_USERS: User[] = [
  {
    userId: "user_antonio",
    name: "Antonio Marcus",
    email: "demo.antonio@example.com",
    role: "admin", // Let's make him admin so he can test the admin module!
    status: "active",
    createdAt: new Date().toISOString(),
    freeTrialUntil: offsetDate(24 * 15), // 15 days of trial remaining
    subscriptionStatus: "active",
    subscriptionPlan: "yearly",
    subscriptionCurrentPeriodEnd: offsetDate(24 * 300), // paid period active (~300 days left)
  },
  {
    userId: "user_maria",
    name: "Maria Silva",
    email: "maria.silva@example.com",
    role: "user",
    status: "active",
    createdAt: new Date().toISOString(),
    freeTrialUntil: offsetDate(-24 * 2), // expired 2 days ago
    subscriptionStatus: "inactive",
    subscriptionPlan: "none",
  },
  {
    userId: "user_joao",
    name: "João Souza",
    email: "joao.souza@example.com",
    role: "user",
    status: "suspended",
    createdAt: new Date().toISOString(),
    freeTrialUntil: offsetDate(24 * 5), // 5 days remaining
    subscriptionStatus: "expired",
    subscriptionPlan: "monthly",
  },
];

const SEED_MEDICADOS: Medicado[] = [
  {
    medicadoId: "pat_livia",
    userId: "user_antonio",
    name: "Lívia Barreto",
    birthDate: "2018-05-15",
    relationship: "Filha",
    photoUrl: "https://images.unsplash.com/photo-1508214751196-bcfd4ca60f91?w=150&h=150&fit=crop",
    createdAt: new Date().toISOString(),
  },
  {
    medicadoId: "pat_carlos",
    userId: "user_antonio",
    name: "Seu Carlos (Pai)",
    birthDate: "1952-11-20",
    relationship: "Pai",
    photoUrl: "https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=150&h=150&fit=crop",
    createdAt: new Date().toISOString(),
  },
];

const SEED_RECEITAS: Receita[] = [
  {
    receitaId: "rec_1",
    medicadoId: "pat_livia",
    userId: "user_antonio",
    date: "2026-07-08",
    doctorName: "Dra. Ana Cláudia (Pediatra)",
    imageUrl: "",
    notes: "Prescrição para inflamação de garganta.",
    extracted: true,
    createdAt: new Date().toISOString(),
  },
];

const SEED_MEDICAMENTOS: Medicamento[] = [
  {
    medicamentoId: "med_amoxicilina",
    receitaId: "rec_1",
    medicadoId: "pat_livia",
    userId: "user_antonio",
    name: "Amoxicilina Xarope",
    dosage: "5 ml",
    intervalHours: 8,
    durationDays: 7,
    instructions: "Tomar de 8 em 8 horas. Guardar na geladeira.",
    category: "syrup",
    pharmacyId: "pharm_sao_joao",
    status: "active",
    reminderOffset: 10,
    pricePlaceholder: 34.90,
    createdAt: new Date().toISOString(),
  },
  {
    medicamentoId: "med_losartana",
    receitaId: "rec_manual",
    medicadoId: "pat_carlos",
    userId: "user_antonio",
    name: "Losartana Potássica 50mg",
    dosage: "1 comprimido",
    intervalHours: 12,
    durationDays: 30,
    instructions: "Tomar em jejum pela manhã e à noite.",
    category: "pill",
    pharmacyId: "pharm_droga_raia",
    status: "active",
    reminderOffset: 5,
    pricePlaceholder: 12.50,
    createdAt: new Date().toISOString(),
  },
  {
    medicamentoId: "med_dipirona",
    receitaId: "rec_1",
    medicadoId: "pat_livia",
    userId: "user_antonio",
    name: "Dipirona Gotas",
    dosage: "15 gotas",
    intervalHours: 6,
    durationDays: 3,
    instructions: "Tomar apenas em caso de febre ou dor de garganta forte.",
    category: "drop",
    pharmacyId: "pharm_sao_joao",
    status: "active",
    reminderOffset: 0,
    pricePlaceholder: 8.90,
    createdAt: new Date().toISOString(),
  },
];

const SEED_DOSE_LOGS: DoseLog[] = [
  {
    logId: "log_1",
    medicamentoId: "med_amoxicilina",
    medicadoId: "pat_livia",
    userId: "user_antonio",
    plannedTime: offsetDate(-3),
    takenTime: offsetDate(-2.8),
    status: "taken",
  },
  {
    logId: "log_2",
    medicamentoId: "med_losartana",
    medicadoId: "pat_carlos",
    userId: "user_antonio",
    plannedTime: offsetDate(-6),
    takenTime: offsetDate(-5.9),
    status: "taken",
  },
];

const SEED_CONSULTAS: Consulta[] = [
  {
    consultaId: "cons_1",
    userId: "user_antonio",
    medicadoId: "pat_livia",
    doctorName: "Dra. Ana Cláudia",
    specialty: "Pediatria",
    dateTime: offsetDate(24), // 24 hours in the future
    location: "Clínica Infância Saudável",
    notes: "Retorno pós-tratamento de garganta.",
    createdAt: new Date().toISOString(),
  },
  {
    consultaId: "cons_2",
    userId: "user_antonio",
    medicadoId: "pat_carlos",
    doctorName: "Dr. Roberto",
    specialty: "Cardiologia",
    dateTime: offsetDate(72), // 3 days in the future
    location: "Hospital do Coração - Sala 4",
    notes: "Exames de rotina trimestrais.",
    createdAt: new Date().toISOString(),
  },
];

const SEED_FARMACIAS: Farmacia[] = [
  {
    farmaciaId: "pharm_sao_joao",
    userId: "user_antonio",
    name: "Farmácia São João",
    address: "Av. Central, 1020 - Centro",
    phone: "(51) 3211-4040",
    isFavorite: true,
  },
  {
    farmaciaId: "pharm_droga_raia",
    userId: "user_antonio",
    name: "Droga Raia",
    address: "Rua Flores da Cunha, 45 - Bairro Jardim",
    phone: "(51) 3344-9988",
    isFavorite: false,
  },
];

const SEED_CUPONS: CupomFiscal[] = [
  {
    cupomId: "cup_1",
    userId: "user_antonio",
    establishment: "Farmácia São João",
    date: "09/07/2026",
    items: [
      { name: "Losartana Potássica 50mg", price: 18.90 },
      { name: "Amoxicilina 500mg", price: 24.50 },
      { name: "Fralda Geriátrica G C/8", price: 42.00 }
    ],
    totalPrice: 85.40,
    createdAt: new Date().toISOString(),
  }
];

// The SEED_* fixtures above are a DEVELOPMENT aid (demo accounts + sample
// prescriptions to work against without signing up). In production they are
// actively harmful: the admin panel listed them as if they were real customers,
// and one of them carries role "admin". Production must start from an empty
// cache and only ever hold data the signed-in user actually owns.
// Cast matches how src/firebase.ts reads import.meta (no vite/client types here).
const SEEDS_ENABLED = !!(import.meta as any).env?.DEV;

// Ids owned by the fixtures, needed to clean browsers that already cached them
// (gating the seed only helps a first-time visitor).
const SEED_USER_IDS = ["user_antonio", "user_maria", "user_joao"];
const SEED_PURGED_FLAG = "horacerta_seed_purged_v1";
const USER_SCOPED_KEYS = [
  "medicados",
  "receitas",
  "medicamentos",
  "dose_logs",
  "consultas",
  "farmacias",
  "cupons",
];

// One-time cleanup: drops the demo accounts and everything hanging off them
// from a cache seeded before SEEDS_ENABLED existed. Real records are keyed by
// the Firebase uid, never by these ids, so nothing genuine matches.
function purgeSeedDataOnce() {
  if (SEEDS_ENABLED) return;
  if (typeof localStorage === "undefined") return;
  if (localStorage.getItem(SEED_PURGED_FLAG)) return;

  try {
    const rawUsers = localStorage.getItem("horacerta_users");
    if (rawUsers) {
      const kept = (JSON.parse(rawUsers) as User[]).filter(
        (u) => !SEED_USER_IDS.includes(u.userId)
      );
      localStorage.setItem("horacerta_users", JSON.stringify(kept));
    }

    for (const key of USER_SCOPED_KEYS) {
      const raw = localStorage.getItem(`horacerta_${key}`);
      if (!raw) continue;
      const kept = (JSON.parse(raw) as { userId?: string }[]).filter(
        (item) => !item.userId || !SEED_USER_IDS.includes(item.userId)
      );
      localStorage.setItem(`horacerta_${key}`, JSON.stringify(kept));
    }

    // A session pinned to a demo account would otherwise survive the purge.
    for (const sessionKey of ["horacerta_active_user_id", "horacerta_active_admin_id"]) {
      const active = localStorage.getItem(sessionKey);
      if (active && SEED_USER_IDS.includes(active)) localStorage.removeItem(sessionKey);
    }

    localStorage.setItem(SEED_PURGED_FLAG, new Date().toISOString());
  } catch (err) {
    console.warn("Falha ao limpar dados de demonstração do cache local.", err);
  }
}

class DBLocalFallback {
  private get<T>(key: string, defaults: T[]): T[] {
    const data = localStorage.getItem(`horacerta_${key}`);
    if (!data) {
      // Never seed demo data in production — start empty instead.
      const initial = SEEDS_ENABLED ? defaults : ([] as T[]);
      this.set(key, initial);
      return initial;
    }
    return JSON.parse(data);
  }

  private set<T>(key: string, value: T[]) {
    localStorage.setItem(`horacerta_${key}`, JSON.stringify(value));
  }

  // Merges a Firestore snapshot into the local cache for one user without
  // discarding local records that haven't reached Firestore yet: writes to
  // Firestore are fire-and-forget (see add*/update* methods below), so a sync
  // that runs while one is still in flight (e.g. a page reload right after
  // saving) must not treat "missing from Firestore" as "was deleted" — it
  // preserves any local record of that id/user pair Firestore doesn't have
  // yet, and otherwise defers to Firestore as the source of truth.
  private mergeUserCollection<T extends { userId: string }>(
    local: T[],
    remote: T[],
    userId: string,
    idKey: keyof T
  ): T[] {
    const others = local.filter(item => item.userId !== userId);
    const remoteIds = new Set(remote.map(item => item[idKey]));
    const localOnly = local.filter(
      item => item.userId === userId && !remoteIds.has(item[idKey])
    );
    return [...others, ...remote, ...localOnly];
  }

  // Wipes every locally-cached collection (patients, prescriptions, medicines,
  // dose logs, appointments, pharmacies, receipts) plus the per-dose "already
  // notified" flags. Called on logout / user switch so a shared device never
  // leaves one account's health data (PHI) readable in localStorage for the
  // next person. The session id keys are cleared by the caller (App.tsx).
  clearLocalData() {
    const collectionKeys = [
      "users", "medicados", "receitas", "medicamentos",
      "dose_logs", "consultas", "farmacias", "cupons",
    ];
    for (const key of collectionKeys) {
      localStorage.removeItem(`horacerta_${key}`);
    }
    // Remove the dose-reminder dedupe flags (keys like `notified_<med>_<date>`).
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith("notified_")) localStorage.removeItem(k);
    }
  }

  // Live Firebase Synchronizer
  async syncFromFirebase(userId: string): Promise<boolean> {
    try {
      console.log(`[Firebase Sync] Carregando coleções para o usuário: ${userId}...`);

      // 1. Get medicados (in parallel with the user's flat collections and
      //    own profile — none of them depend on each other).
      //    allSettled, NOT all: one failing collection (e.g. a permission error
      //    on cupons) must not abort the whole sync and throw away the other
      //    collections' progress, which is what the original sequential version
      //    effectively preserved. A failed fetch degrades to "no remote data"
      //    for that collection, and mergeUserCollection with an empty remote
      //    list is a no-op that keeps the local cache intact.
      const settled = await Promise.allSettled([
        dbFirebase.getMedicados(userId),
        dbFirebase.getConsultas(userId),
        dbFirebase.getFarmacias(userId),
        dbFirebase.getCupons(userId),
        dbFirebase.getUser(userId),
      ]);
      const names = ["medicados", "consultas", "farmacias", "cupons", "perfil"];
      settled.forEach((r, i) => {
        if (r.status === "rejected") {
          console.warn(`[Firebase Sync] Falha ao carregar ${names[i]}:`, r.reason);
        }
      });
      const valueOr = <T,>(i: number, fallback: T): T =>
        settled[i].status === "fulfilled" ? (settled[i] as PromiseFulfilledResult<T>).value : fallback;

      const firebaseMedicados = valueOr<Medicado[]>(0, []);
      const consultas = valueOr<Consulta[]>(1, []);
      const farmacias = valueOr<Farmacia[]>(2, []);
      const cupons = valueOr<CupomFiscal[]>(3, []);
      const profile = valueOr<User | null>(4, null);
      const localMedicados = this.get<Medicado>("medicados", SEED_MEDICADOS);
      const allMedicados = this.mergeUserCollection(localMedicados, firebaseMedicados, userId, "medicadoId");
      this.set("medicados", allMedicados);

      // The medicados this user actually has after the merge (Firestore's +
      // any still-local-only ones) — subcollections must be fetched for all
      // of them, not just the ones Firestore already knows about.
      const userMedicados = allMedicados.filter(m => m.userId === userId);

      // 2. Fetch subcollections for every medicado in parallel (was a sequential
      //    N+1 waterfall — slow login for users with several patients/medicines).
      const firebaseReceitas: Receita[] = [];
      const firebaseMedicamentos: Medicamento[] = [];
      const firebaseDoseLogs: DoseLog[] = [];

      // Each medicado is isolated in its own try/catch so one failing patient
      // doesn't discard the subcollections already fetched for the others.
      await Promise.all(userMedicados.map(async (m) => {
        try {
          const [receitas, medicamentos] = await Promise.all([
            dbFirebase.getReceitas(userId, m.medicadoId),
            dbFirebase.getMedicamentos(userId, m.medicadoId),
          ]);
          firebaseReceitas.push(...receitas);
          firebaseMedicamentos.push(...medicamentos);

          const logsArrays = await Promise.all(
            medicamentos.map((med) => dbFirebase.getDoseLogs(userId, m.medicadoId, med.medicamentoId))
          );
          for (const logs of logsArrays) firebaseDoseLogs.push(...logs);
        } catch (err) {
          console.warn(`[Firebase Sync] Falha ao carregar subcoleções de ${m.medicadoId}:`, err);
        }
      }));

      this.set("receitas", this.mergeUserCollection(
        this.get<Receita>("receitas", SEED_RECEITAS), firebaseReceitas, userId, "receitaId"
      ));
      this.set("medicamentos", this.mergeUserCollection(
        this.get<Medicamento>("medicamentos", SEED_MEDICAMENTOS), firebaseMedicamentos, userId, "medicamentoId"
      ));
      this.set("dose_logs", this.mergeUserCollection(
        this.get<DoseLog>("dose_logs", SEED_DOSE_LOGS), firebaseDoseLogs, userId, "logId"
      ));

      // 3. Store the flat collections fetched above.
      this.set("consultas", this.mergeUserCollection(
        this.get<Consulta>("consultas", SEED_CONSULTAS), consultas, userId, "consultaId"
      ));
      this.set("farmacias", this.mergeUserCollection(
        this.get<Farmacia>("farmacias", SEED_FARMACIAS), farmacias, userId, "farmaciaId"
      ));
      this.set("cupons", this.mergeUserCollection(
        this.get<CupomFiscal>("cupons", SEED_CUPONS), cupons, userId, "cupomId"
      ));

      // 4. Refresh the user's OWN profile doc (fetched in the parallel batch
      //    above). Subscription fields (status, period end) are written
      //    server-side by the Mercado Pago webhook via the Admin SDK, so without
      //    pulling the doc here the local cache would keep a stale subscription
      //    state after a payment. Firestore is authoritative for the profile, so
      //    overwrite the single cached record (cache-only — avoids a redundant
      //    fire-and-forget write back to Firestore).
      if (profile) {
        this.setUserCache(profile);
      }

      console.log(`[Firebase Sync] Sincronização offline concluída com sucesso!`);
      return true;
    } catch (err) {
      console.error("[Firebase Sync] Falha ao sincronizar coleções do Firestore:", err);
      return false;
    }
  }

  // Users
  getUsers(): User[] {
    return this.get<User>("users", SEED_USERS);
  }
  updateUser(updated: User) {
    const users = this.getUsers();
    const index = users.findIndex(u => u.userId === updated.userId);
    if (index !== -1) {
      users[index] = updated;
    } else {
      users.push(updated);
    }
    this.set("users", users);

    // Sync to Firestore
    dbFirebase.createUserProfile(updated).catch(e => {
      console.warn("Firestore: erro ao criar/atualizar perfil de usuário.", e);
    });
  }
  deleteUser(userId: string) {
    const users = this.getUsers().filter(u => u.userId !== userId);
    this.set("users", users);

    // Sync to Firestore
    dbFirebase.deleteUserProfile(userId).catch(e => {
      console.warn("Firestore: erro ao remover perfil de usuário.", e);
    });
  }

  // Local-cache-only writes (no Firestore call). Used by admin flows that have
  // already awaited the Firestore write themselves and only want the cache to
  // reflect a confirmed success — avoids a redundant/racing background write.
  setUserCache(updated: User) {
    const users = this.getUsers();
    const index = users.findIndex(u => u.userId === updated.userId);
    if (index !== -1) {
      users[index] = updated;
    } else {
      users.push(updated);
    }
    this.set("users", users);
  }
  removeUserCache(userId: string) {
    const users = this.getUsers().filter(u => u.userId !== userId);
    this.set("users", users);
  }

  // Medicados
  getMedicados(userId: string): Medicado[] {
    return this.get<Medicado>("medicados", SEED_MEDICADOS).filter(m => m.userId === userId);
  }
  addMedicado(m: Medicado) {
    const list = this.get<Medicado>("medicados", SEED_MEDICADOS);
    list.push(m);
    this.set("medicados", list);

    // Sync to Firestore
    dbFirebase.saveMedicado(m).catch(e => {
      console.warn("Firestore: erro ao cadastrar paciente.", e);
    });
  }
  updateMedicado(updated: Medicado) {
    const list = this.get<Medicado>("medicados", SEED_MEDICADOS);
    const index = list.findIndex(item => item.medicadoId === updated.medicadoId);
    if (index !== -1) {
      list[index] = updated;
      this.set("medicados", list);

      // Sync to Firestore
      dbFirebase.updateMedicado(updated).catch(e => {
        console.warn("Firestore: erro ao atualizar paciente.", e);
      });
    }
  }
  deleteMedicado(id: string) {
    const list = this.get<Medicado>("medicados", SEED_MEDICADOS);
    const item = list.find(m => m.medicadoId === id);
    if (item) {
      dbFirebase.deleteMedicado(item.userId, item.medicadoId).catch(e => {
        console.warn("Firestore: erro ao remover paciente.", e);
      });
    }

    const filtered = list.filter(m => m.medicadoId !== id);
    this.set("medicados", filtered);
  }

  // Receitas
  getReceitas(userId: string): Receita[] {
    return this.get<Receita>("receitas", SEED_RECEITAS).filter(r => r.userId === userId);
  }
  addReceita(r: Receita) {
    const list = this.get<Receita>("receitas", SEED_RECEITAS);
    list.push(r);
    this.set("receitas", list);

    // Sync to Firestore
    dbFirebase.saveReceita(r).catch(e => {
      console.warn("Firestore: erro ao cadastrar receita.", e);
    });
  }
  updateReceita(updated: Receita) {
    const list = this.get<Receita>("receitas", SEED_RECEITAS);
    const index = list.findIndex(item => item.receitaId === updated.receitaId);
    if (index !== -1) {
      list[index] = updated;
      this.set("receitas", list);

      // Sync to Firestore
      dbFirebase.updateReceita(updated).catch(e => {
        console.warn("Firestore: erro ao atualizar receita.", e);
      });
    }
  }
  deleteReceita(id: string) {
    const list = this.get<Receita>("receitas", SEED_RECEITAS);
    const item = list.find(r => r.receitaId === id);
    if (item) {
      dbFirebase.deleteReceita(item.userId, item.medicadoId, item.receitaId).catch(e => {
        console.warn("Firestore: erro ao remover receita.", e);
      });
    }

    const remaining = list.filter(m => m.receitaId !== id);
    this.set("receitas", remaining);

    // Cascade delete associated medications
    const meds = this.get<Medicamento>("medicamentos", SEED_MEDICAMENTOS);
    const medsToDelete = meds.filter(m => m.receitaId === id);
    const medIdsToDelete = medsToDelete.map(m => m.medicamentoId);
    const remainingMeds = meds.filter(m => m.receitaId !== id);
    this.set("medicamentos", remainingMeds);

    medsToDelete.forEach(m => {
      dbFirebase.deleteMedicamento(m.userId, m.medicadoId, m.medicamentoId).catch(console.error);
    });

    // Cascade delete associated dose logs
    const logs = this.get<DoseLog>("dose_logs", SEED_DOSE_LOGS);
    const remainingLogs = logs.filter(l => !medIdsToDelete.includes(l.medicamentoId));
    this.set("dose_logs", remainingLogs);
  }

  // Medicamentos
  getMedicamentos(userId: string): Medicamento[] {
    return this.get<Medicamento>("medicamentos", SEED_MEDICAMENTOS).filter(m => m.userId === userId);
  }
  addMedicamento(m: Medicamento) {
    const list = this.get<Medicamento>("medicamentos", SEED_MEDICAMENTOS);
    list.push(m);
    this.set("medicamentos", list);

    // Sync to Firestore
    dbFirebase.saveMedicamento(m).catch(e => {
      console.warn("Firestore: erro ao cadastrar medicamento.", e);
    });
  }
  updateMedicamento(updated: Medicamento) {
    const list = this.get<Medicamento>("medicamentos", SEED_MEDICAMENTOS);
    const index = list.findIndex(item => item.medicamentoId === updated.medicamentoId);
    if (index !== -1) {
      list[index] = updated;
      this.set("medicamentos", list);

      // Sync to Firestore
      dbFirebase.updateMedicamento(updated).catch(e => {
        console.warn("Firestore: erro ao atualizar medicamento.", e);
      });
    }
  }
  deleteMedicamento(id: string) {
    const list = this.get<Medicamento>("medicamentos", SEED_MEDICAMENTOS);
    const item = list.find(m => m.medicamentoId === id);
    if (item) {
      dbFirebase.deleteMedicamento(item.userId, item.medicadoId, item.medicamentoId).catch(e => {
        console.warn("Firestore: erro ao remover medicamento.", e);
      });
    }

    const filtered = list.filter(m => m.medicamentoId !== id);
    this.set("medicamentos", filtered);
  }

  // DoseLogs
  getDoseLogs(userId: string): DoseLog[] {
    return this.get<DoseLog>("dose_logs", SEED_DOSE_LOGS).filter(l => l.userId === userId);
  }
  addDoseLog(l: DoseLog) {
    const list = this.get<DoseLog>("dose_logs", SEED_DOSE_LOGS);
    list.push(l);
    this.set("dose_logs", list);

    // Sync to Firestore
    dbFirebase.saveDoseLog(l).catch(e => {
      console.warn("Firestore: erro ao cadastrar log de dose.", e);
    });
  }
  updateDoseLog(updated: DoseLog) {
    const list = this.get<DoseLog>("dose_logs", SEED_DOSE_LOGS);
    const index = list.findIndex(item => item.logId === updated.logId);
    if (index !== -1) {
      list[index] = updated;
      this.set("dose_logs", list);

      // Sync to Firestore
      dbFirebase.updateDoseLog(updated).catch(e => {
        console.warn("Firestore: erro ao atualizar log de dose.", e);
      });
    }
  }
  deleteDoseLog(id: string) {
    const list = this.get<DoseLog>("dose_logs", SEED_DOSE_LOGS);
    const item = list.find(l => l.logId === id);
    if (item) {
      dbFirebase.deleteDoseLog(item.userId, item.medicadoId, item.medicamentoId, item.logId).catch(e => {
        console.warn("Firestore: erro ao remover log de dose.", e);
      });
    }

    const filtered = list.filter(m => m.logId !== id);
    this.set("dose_logs", filtered);
  }

  // Consultas
  getConsultas(userId: string): Consulta[] {
    return this.get<Consulta>("consultas", SEED_CONSULTAS).filter(c => c.userId === userId);
  }
  addConsulta(c: Consulta) {
    const list = this.get<Consulta>("consultas", SEED_CONSULTAS);
    list.push(c);
    this.set("consultas", list);

    // Sync to Firestore
    dbFirebase.saveConsulta(c).catch(e => {
      console.warn("Firestore: erro ao cadastrar consulta.", e);
    });
  }
  updateConsulta(updated: Consulta) {
    const list = this.get<Consulta>("consultas", SEED_CONSULTAS);
    const index = list.findIndex(item => item.consultaId === updated.consultaId);
    if (index !== -1) {
      list[index] = updated;
      this.set("consultas", list);

      // Sync to Firestore
      dbFirebase.updateConsulta(updated).catch(e => {
        console.warn("Firestore: erro ao atualizar consulta.", e);
      });
    }
  }
  deleteConsulta(id: string) {
    const list = this.get<Consulta>("consultas", SEED_CONSULTAS);
    const item = list.find(c => c.consultaId === id);
    if (item) {
      dbFirebase.deleteConsulta(item.userId, item.consultaId).catch(e => {
        console.warn("Firestore: erro ao remover consulta.", e);
      });
    }

    const filtered = list.filter(m => m.consultaId !== id);
    this.set("consultas", filtered);
  }

  // Farmacias
  getFarmacias(userId: string): Farmacia[] {
    return this.get<Farmacia>("farmacias", SEED_FARMACIAS).filter(f => f.userId === userId);
  }
  addFarmacia(f: Farmacia) {
    const list = this.get<Farmacia>("farmacias", SEED_FARMACIAS);
    list.push(f);
    this.set("farmacias", list);

    // Sync to Firestore
    dbFirebase.saveFarmacia(f).catch(e => {
      console.warn("Firestore: erro ao cadastrar farmácia.", e);
    });
  }
  updateFarmacia(updated: Farmacia) {
    const list = this.get<Farmacia>("farmacias", SEED_FARMACIAS);
    const index = list.findIndex(item => item.farmaciaId === updated.farmaciaId);
    if (index !== -1) {
      list[index] = updated;
      this.set("farmacias", list);

      // Sync to Firestore
      dbFirebase.updateFarmacia(updated).catch(e => {
        console.warn("Firestore: erro ao atualizar farmácia.", e);
      });
    }
  }
  deleteFarmacia(id: string) {
    const list = this.get<Farmacia>("farmacias", SEED_FARMACIAS);
    const item = list.find(f => f.farmaciaId === id);
    if (item) {
      dbFirebase.deleteFarmacia(item.userId, item.farmaciaId).catch(e => {
        console.warn("Firestore: erro ao remover farmácia.", e);
      });
    }

    const filtered = list.filter(m => m.farmaciaId !== id);
    this.set("farmacias", filtered);
  }

  // Cupons Fiscais
  getCupons(userId: string): CupomFiscal[] {
    return this.get<CupomFiscal>("cupons", SEED_CUPONS).filter(c => c.userId === userId);
  }
  addCupom(c: CupomFiscal) {
    const list = this.get<CupomFiscal>("cupons", SEED_CUPONS);
    list.push(c);
    this.set("cupons", list);

    // Sync to Firestore
    dbFirebase.saveCupom(c).catch(e => {
      console.warn("Firestore: erro ao cadastrar cupom fiscal.", e);
    });
  }
  deleteCupom(id: string) {
    const list = this.get<CupomFiscal>("cupons", SEED_CUPONS);
    const item = list.find(c => c.cupomId === id);
    if (item) {
      dbFirebase.deleteCupom(item.userId, item.cupomId).catch(e => {
        console.warn("Firestore: erro ao remover cupom fiscal.", e);
      });
    }

    const filtered = list.filter(c => c.cupomId !== id);
    this.set("cupons", filtered);
  }
}

// Runs before any consumer reads the cache, so a browser carrying old demo
// data is cleaned on the first load after this ships.
purgeSeedDataOnce();

export const dbLocal = new DBLocalFallback();
export const currentUserAntonioId = "user_antonio";
