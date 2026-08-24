import React, { useState, useEffect, useCallback, useRef } from "react";
import { dbLocal } from "./dbLocalFallback";
import { auth, dbFirebase, isDeadSessionError } from "./firebase";
import { subscribeToPush, unsubscribeFromPush, isIOSDevice } from "./push";
import { canPerformScan, getScanBlockReason, getAccessState, daysRemaining, type ScanType } from "./subscription";
import { dueDoseMs } from "./utils/doseSchedule";
import { normalizeEmail } from "./utils/normalizeEmail";
import { processImageFile } from "./imageUtils";
import { reportLogin } from "./loginLog";
import { initAppUpdater, applyAppUpdate } from "./appUpdate";
import { signInWithEmailAndPassword, signOut as firebaseSignOut, updatePassword, onAuthStateChanged, User as FirebaseUser } from "firebase/auth";
import { User, Medicado, Receita, Medicamento, DoseLog, Consulta, Farmacia, MedicineCategory, CupomFiscal, Share } from "./types";
import { listShares, createShare, acceptShare, revokeShare, canEditMedicado } from "./shares";
import SharingScreen from "./components/SharingScreen";
import { ShareRole } from "./types";
import BottomNavBar from "./components/BottomNavBar";
import Dashboard from "./components/Dashboard";
import Schedule from "./components/Schedule";
import AdminPanel from "./components/AdminPanel";
import AdminLogs from "./components/AdminLogs";
import AdminPayments from "./components/AdminPayments";
import AdminDiagnostics from "./components/AdminDiagnostics";
import Appointments from "./components/Appointments";
import Pharmacies from "./components/Pharmacies";
import AuthScreen from "./components/AuthScreen";
import PrivacyPolicy from "./components/PrivacyPolicy";
import SubscriptionScreen from "./components/SubscriptionScreen";
import SupportModal from "./components/SupportModal";
import { useIsDesktop } from "./hooks/useIsDesktop";
import { useInstallPrompt } from "./hooks/useInstallPrompt";
import { InstallAppSheet, InstallGuideModal } from "./components/InstallAppPrompt";
import UpdateBanner from "./components/UpdateBanner";
import { Shield, Sparkles, Heart, HelpCircle, LogOut, ShieldAlert, CheckCircle2, User as UserIcon, Camera, Key, Upload, Eye, EyeOff, Save, Smartphone, Bell, Download, Gift, CreditCard, Lock, Mail, ArrowRight, AlertCircle } from "lucide-react";

// Set by the CTAs on the static landing page (root index.html) right before
// navigating to /app, so a desktop user who explicitly chose to enter the
// app isn't bounced straight back to the landing page below.
const DESKTOP_ENTER_FLAG = "horacerta_desktop_enter";

// Entidades cujo rótulo legível descreveria um registro de SAÚDE — e, nos
// quatro primeiros casos, nomearia um TERCEIRO (o medicado: um filho, um pai
// idoso) que nunca consentiu com nada.
//
// A trilha de auditoria (`actionLogs`) é lida pelo admin no Portal, e um
// entityLabel como "Lívia Barreto" ou "Dr. Roberto - 2026-07-30T14:00"
// reabriria exatamente a exposição que a remoção do simulador de sessão
// fechou (ver CLAUDE.md). Para estas, a trilha guarda só tipo + id: preserva
// o valor forense (quem fez o quê, quando, em qual registro) sem carregar o
// dado sensível. `User`/`Farmacia` descrevem ações do admin sobre a própria
// base, sem dado de saúde de terceiro, e seguem legíveis.
const HEALTH_ENTITY_TYPES = new Set([
  "Medicado",
  "Receita",
  "Medicamento",
  "Consulta",
  "CupomFiscal",
]);

function auditLabelFor(entityType: string, entityId: string, label: string): string {
  return HEALTH_ENTITY_TYPES.has(entityType) ? entityId : label;
}

// Allowlist de campos comparados no diff de auditoria por entidade. Exclui
// sempre *Id/userId/createdAt e campos grandes/binários (photoUrl, avatarUrl).
const MEDICADO_AUDIT_FIELDS: (keyof Medicado)[] = ["name", "relationship", "birthDate"];
const MEDICAMENTO_AUDIT_FIELDS: (keyof Medicamento)[] = [
  "name", "dosage", "intervalHours", "durationDays", "instructions", "category", "status", "pharmacyId", "reminderOffset"
];
const CONSULTA_AUDIT_FIELDS: (keyof Consulta)[] = ["doctorName", "specialty", "dateTime", "location", "notes"];
const FARMACIA_AUDIT_FIELDS: (keyof Farmacia)[] = ["name", "address", "phone", "isFavorite"];
const USER_AUDIT_FIELDS: (keyof User)[] = [
  "role", "status", "subscriptionPlan", "subscriptionStatus", "subscriptionCurrentPeriodEnd", "freeTrialUntil"
];

// Formata um valor de campo para aparecer num log — nunca o objeto inteiro,
// sempre uma string curta e capada.
function formatAuditValue(value: unknown): string {
  if (value === undefined || value === null || value === "") return "(vazio)";
  const str = typeof value === "object" ? JSON.stringify(value) : String(value);
  return str.length > 60 ? `${str.slice(0, 60)}…` : str;
}

// Monta um resumo legível do que mudou (update) ou do que foi removido
// (delete, quando `after` é undefined) para os campos de `fields`.
// Para entidades de saúde (HEALTH_ENTITY_TYPES) só lista os NOMES dos campos
// afetados, nunca os valores — mesma minimização do entityLabel, ver
// auditLabelFor acima e o comentário de HEALTH_ENTITY_TYPES.
function describeChanges<T extends Record<string, any>>(
  entityType: string,
  before: T | undefined,
  after: T | undefined,
  fields: (keyof T & string)[]
): string | undefined {
  if (!before) return undefined;
  const isHealthData = HEALTH_ENTITY_TYPES.has(entityType);

  if (after) {
    const changed = fields.filter((f) => JSON.stringify(before[f] ?? null) !== JSON.stringify(after[f] ?? null));
    if (changed.length === 0) return undefined;
    if (isHealthData) return `Campos alterados: ${changed.join(", ")}`;
    return changed.map((f) => `${f}: ${formatAuditValue(before[f])} → ${formatAuditValue(after[f])}`).join("; ");
  }

  // Delete: não há "depois", só lista o que existia no registro removido.
  const present = fields.filter((f) => before[f] !== undefined && before[f] !== null && before[f] !== "");
  if (present.length === 0) return undefined;
  if (isHealthData) return `Registro removido — campos: ${present.join(", ")}`;
  return `Removido: ${present.map((f) => `${f}: ${formatAuditValue(before[f])}`).join("; ")}`;
}

export default function App() {
  const isDesktop = useIsDesktop();
  // Read once: the landing page CTA sets this flag right before a full page
  // navigation to /app, so there is no in-app moment where it needs to change.
  const desktopEntered = typeof window !== "undefined" && sessionStorage.getItem(DESKTOP_ENTER_FLAG) === "1";
  // 1. Authentication State
  const [activeUser, setActiveUser] = useState<User | null>(null);
  // Espelho do activeUser num ref, atribuído durante o render. syncSubscription
  // precisa DEVOLVER o perfil recém-mesclado a quem chamou (a revalidação do
  // scanner decide na hora entre abrir o scanner ou o paywall), e ler esse
  // valor de dentro do updater funcional do setState não serve: o React só
  // executa o updater no render seguinte. O ref dá o valor atual sem prender a
  // callback numa closure velha — que é o motivo de o updater existir ali.
  const activeUserRef = useRef<User | null>(null);
  activeUserRef.current = activeUser;
  const [activeAdminUser, setActiveAdminUser] = useState<User | null>(null);
  const [adminSection, setAdminSection] = useState<"users" | "logs" | "payments" | "sistema">("users");

  // 2. Global Database States
  const [users, setUsers] = useState<User[]>([]);
  const [medicados, setMedicados] = useState<Medicado[]>([]);
  const [receitas, setReceitas] = useState<Receita[]>([]);
  const [medicamentos, setMedicamentos] = useState<Medicamento[]>([]);
  const [doseLogs, setDoseLogs] = useState<DoseLog[]>([]);
  const [consultas, setConsultas] = useState<Consulta[]>([]);
  const [farmacias, setFarmacias] = useState<Farmacia[]>([]);
  const [cupons, setCupons] = useState<CupomFiscal[]>([]);
  // Compartilhamento: os convites que este usuário concedeu e os que recebeu.
  const [sharesAsOwner, setSharesAsOwner] = useState<Share[]>([]);
  const [sharesAsGrantee, setSharesAsGrantee] = useState<Share[]>([]);

  // 3. Navigation State
  const [activeTab, setActiveTab] = useState<string>("home");
  const [successToast, setSuccessToast] = useState<string | null>(null);
  // Versão nova publicada e detectada com o app aberto na frente do usuário —
  // ver src/appUpdate.ts. Em segundo plano ela é aplicada sem passar por aqui.
  const [updateReady, setUpdateReady] = useState(false);
  const [scheduleDate, setScheduleDate] = useState<Date>(new Date());
  const [schedulePatientId, setSchedulePatientId] = useState<string>("");
  const [showPrivacyPage, setShowPrivacyPage] = useState(false);
  const [showSubscription, setShowSubscription] = useState(false);
  const [showSupportModal, setShowSupportModal] = useState(false);

  // 3.1 Separate Admin Page Route States
  const [isAdminRoute, setIsAdminRoute] = useState(() => {
    return typeof window !== "undefined" && (
      window.location.pathname === "/app/admin" ||
      window.location.pathname === "/app/admin/" ||
      window.location.hash.startsWith("#/admin")
    );
  });

  // 4. PWA & Background Notification States
  const [notificationPermission, setNotificationPermission] = useState<string>("default");
  // Tracks whether THIS browser actually has a server-side push subscription —
  // distinct from notificationPermission, which is just the OS-level prompt
  // answer. On iOS Safari outside standalone/installed mode, permission can be
  // granted while PushManager doesn't exist at all, so "Ativo" would lie.
  const [pushRegistered, setPushRegistered] = useState(false);
  // Everything about "is it installed / can it be installed" lives in this hook
  // (beforeinstallprompt, appinstalled, standalone detection, the 7-day snooze).
  const install = useInstallPrompt();
  const isPWAInstalled = install.isInstalled;
  // Shown when the browser gives us no prompt to fire — always the case on iOS.
  const [showInstallGuide, setShowInstallGuide] = useState(false);
  // The bottom sheet asks at most once per session; "Agora não" mutes it for 7 days.
  const [installSheetOpen, setInstallSheetOpen] = useState(false);
  const [installSheetAsked, setInstallSheetAsked] = useState(false);

  // Load initial database records
  useEffect(() => {
    const loadedUsers = dbLocal.getUsers();
    setUsers(loadedUsers);
    
    // Check if there is a saved active user session in localStorage
    const savedUserId = localStorage.getItem("horacerta_active_user_id");
    if (savedUserId) {
      const savedUser = loadedUsers.find(u => u.userId === savedUserId);
      if (savedUser && savedUser.status !== "suspended") {
        setActiveUser(savedUser);
      }
    } else {
      setActiveUser(null);
    }

    // Check if there is a saved admin session
    const savedAdminId = localStorage.getItem("horacerta_active_admin_id");
    if (savedAdminId) {
      const savedAdmin = loadedUsers.find(u => u.userId === savedAdminId && u.role === "admin");
      if (savedAdmin) {
        setActiveAdminUser(savedAdmin);
      }
    }
  }, []);

  // Drops the local session entirely: reused both by the manual "Sair da
  // Conta" button (handleLogout below) and by the automatic dead-session
  // detection effect further down, for the case where an admin hard-deletes
  // (or disables) an account that is still cached/logged-in on this device.
  // Uses functional setState updates throughout so its identity can stay
  // stable (empty dependency array) without closing over stale activeUser/
  // activeAdminUser values from the render that first created it.
  // Set while an intentional sign-out is in flight (manual logout, or a
  // teardown already running). firebaseSignOut() fires onAuthStateChanged
  // with null BEFORE the localStorage session pointers are cleared, so the
  // orphaned-session check below would otherwise fire a second, spurious
  // teardown (and toast) on every normal logout.
  const signingOutRef = useRef(false);

  const forceSessionTeardown = useCallback(async (message: string) => {
    signingOutRef.current = true;
    await unsubscribeFromPush(() => Promise.resolve(undefined)).catch(() => {});
    await firebaseSignOut(auth).catch(() => {});
    dbLocal.clearLocalData();

    // clearLocalData() já remove `horacerta_users`, mas o cache é recriado a
    // partir dos seeds na primeira leitura — evict explícito para garantir que
    // a conta morta não seja re-oferecida no próximo boot, reusando o mesmo
    // helper do fluxo de exclusão do admin.
    setActiveUser((prev) => {
      if (prev) dbLocal.removeUserCache(prev.userId);
      return null;
    });
    setActiveAdminUser((prev) => {
      if (prev) dbLocal.removeUserCache(prev.userId);
      return null;
    });

    setMedicados([]);
    setReceitas([]);
    setMedicamentos([]);
    setDoseLogs([]);
    setConsultas([]);
    setFarmacias([]);
    setCupons([]);
    setSharesAsOwner([]);
    setSharesAsGrantee([]);
    localStorage.removeItem("horacerta_active_user_id");
    localStorage.removeItem("horacerta_active_admin_id");
    setUsers(dbLocal.getUsers());
    showToast(message);
    signingOutRef.current = false;
  }, []);

  // Boot-time / app-resume validity check. The instant restore effect above
  // is optimistic (localStorage only) — this is the only place that actually
  // asks Firebase Auth "does this account still exist / is it still
  // enabled?" by forcing a token refresh (a real network round-trip). A hard
  // delete or a disabled account surfaces here as a specific auth error code
  // (see isDeadSessionError in firebase.ts); anything else — most notably
  // being offline — is left alone so the cached session keeps working, per
  // the offline-first design and so a valid session is never forced to
  // re-login on every open.
  const verifySessionStillValid = useCallback(async () => {
    const fbUser = auth.currentUser;
    if (!fbUser) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;

    const hadAdminSession = !!localStorage.getItem("horacerta_active_admin_id");

    try {
      await fbUser.getIdToken(true);
      if (hadAdminSession) {
        // A revoked admin custom claim doesn't invalidate the token refresh
        // above (the account itself still exists) — check it explicitly.
        const tokenResult = await fbUser.getIdTokenResult(true);
        if (tokenResult.claims.admin !== true) {
          await forceSessionTeardown("Acesso de administrador revogado. Faça login novamente.");
        }
      }
    } catch (err) {
      if (isDeadSessionError(err)) {
        await forceSessionTeardown("Sua sessão não é mais válida. Faça login novamente.");
      }
      // Any other error (network-request-failed, timeout, transient) is
      // ignored — the cached session stays trusted, exactly as before.
    }
  }, [forceSessionTeardown]);

  useEffect(() => {
    // Fires once on mount with whatever Firebase Auth already has persisted
    // (fast, read from IndexedDB), and again whenever the SDK's own sign-in
    // state changes (login, logout, or an internal auto-sign-out following a
    // failed background token refresh).
    const unsubscribe = onAuthStateChanged(auth, (fbUser) => {
      if (!fbUser) {
        // No Firebase Auth session AT ALL, and the observer only fires after
        // the SDK has resolved its persisted state — so this is authoritative,
        // not a startup race. It is also NOT the offline case: a valid session
        // is restored from IndexedDB without any network.
        //
        // This is exactly what an account hard-delete looks like on the
        // victim's device: the SDK's own background token refresh fails and it
        // signs itself out internally. Until this branch existed the app just
        // returned here (verifySessionStillValid bails on a null currentUser),
        // leaving the localStorage session pointer untouched — so the boot
        // effect above kept restoring the cached profile and the whole app
        // stayed usable offline-style, reading and writing PHI to
        // localStorage, for a user whose account no longer exists.
        if (signingOutRef.current) return;
        const hasLocalSession =
          localStorage.getItem("horacerta_active_user_id") ||
          localStorage.getItem("horacerta_active_admin_id");
        if (hasLocalSession) {
          forceSessionTeardown("Sua sessão não é mais válida. Faça login novamente.");
        }
        return;
      }
      verifySessionStillValid();
    });
    return unsubscribe;
  }, [verifySessionStillValid, forceSessionTeardown]);

  useEffect(() => {
    // A PWA installed on mobile is backgrounded/foregrounded without a full
    // document reload, so a mount-only check would never run again — re-run
    // on every foreground, throttled so rapid tab/app switching doesn't
    // hammer the network with token refreshes.
    let lastChecked = 0;
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastChecked < 5 * 60 * 1000) return;
      lastChecked = now;
      verifySessionStillValid();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [verifySessionStillValid]);

  useEffect(() => {
    // The visibilitychange check above only re-validates on a hidden->visible
    // transition, so a session left open and untouched in the foreground for a
    // long stretch (screen never locked, tab never backgrounded) would never
    // re-run it. This keeps the same silent, no-UI token liveness check ticking
    // on a fixed cadence for that case — same verifySessionStillValid, same
    // dead-session-only teardown rule, just a different trigger.
    const SESSION_CHECK_INTERVAL_MS = 10 * 60 * 1000; // 10 min
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") verifySessionStillValid();
    }, SESSION_CHECK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [verifySessionStillValid]);

  useEffect(() => {
    // dbLocal's add*/update*/delete* methods fire-and-forget their Firestore
    // writes and only console.warn on failure (see dbLocalFallback.ts) — a
    // permission-denied there is otherwise invisible to the user. Bridge it
    // into a real re-check: a forced token refresh is the only thing that can
    // actually tell "dead account" apart from "legitimate authorization
    // failure" (e.g. a suspended user), so this never decides death on its
    // own, only triggers the authoritative check.
    dbLocal.setAuthErrorListener(() => {
      verifySessionStillValid();
    });
    return () => dbLocal.setAuthErrorListener(null);
  }, [verifySessionStillValid]);

  // The admin panel must list REAL registered users, which live in Firestore —
  // `dbLocal.getUsers()` only ever holds accounts this browser touched (plus the
  // dev seed fixtures), so without this the panel showed demo data and never the
  // people who actually signed up. Listing `users` is admin-only in the rules,
  // so this runs only once an admin session is active. Covers both a fresh login
  // and a session restored from localStorage on reload.
  useEffect(() => {
    if (!activeAdminUser) return;
    let cancelled = false;
    dbFirebase
      .getAllUsers()
      .then((cloudUsers) => {
        // Keep the local cache as-is on an empty result: an admin with a valid
        // session should never see the panel blank out due to a transient read.
        if (!cancelled && cloudUsers.length > 0) setUsers(cloudUsers);
      })
      .catch((err) => {
        console.warn("Admin: falha ao listar usuários do Firestore.", err);
      });
    return () => {
      cancelled = true;
    };
  }, [activeAdminUser]);

  // Re-reads the directory from Firestore after an admin mutation. Using
  // dbLocal.getUsers() here instead would swap the full directory for this
  // browser's local cache — which is why deleting one account appeared to wipe
  // every other account from the list.
  const refreshUsersFromFirestore = async () => {
    try {
      setUsers(await dbFirebase.getAllUsers());
    } catch (err) {
      console.warn("Admin: falha ao recarregar usuários do Firestore.", err);
    }
  };

  // Sync data whenever active user shifts (isolated queries per tenant)
  useEffect(() => {
    if (!activeUser) return;
    
    // As coleções de saúde usam os getters "visible": além do que é do próprio
    // usuário, incluem os pacientes que outros titulares compartilharam com
    // ele. Farmácias e cupons ficam de fora de propósito — são da conta, não do
    // paciente, e acompanhar a medicação de alguém não dá acesso ao quanto essa
    // pessoa gasta na farmácia.
    const loadFromCache = () => {
      setMedicados(dbLocal.getVisibleMedicados(activeUser.userId));
      setReceitas(dbLocal.getVisibleReceitas(activeUser.userId));
      setMedicamentos(dbLocal.getVisibleMedicamentos(activeUser.userId));
      setDoseLogs(dbLocal.getVisibleDoseLogs(activeUser.userId));
      setConsultas(dbLocal.getVisibleConsultas(activeUser.userId));
      setFarmacias(dbLocal.getFarmacias(activeUser.userId));
      setCupons(dbLocal.getCupons(activeUser.userId));
    };

    // 1. First, load immediately from local storage cache (fast render)
    loadFromCache();

    // 2. Second, fetch live updates from Firebase in the background (non-blocking)
    dbLocal.syncFromFirebase(activeUser.userId).then((synced) => {
      if (synced) {
        // Reload states with new cloud data
        loadFromCache();
        // O sync acima também rebaixa o documento de perfil para o cache, mas
        // até aqui isso não chegava ao `activeUser` em memória: uma correção de
        // nome ou uma troca de avatar feita pelo admin só aparecia depois de um
        // logout/login. O Firestore é a fonte da verdade do perfil.
        const fresh = dbLocal.getUsers().find((u) => u.userId === activeUser.userId);
        if (fresh) {
          setActiveUser((prev) =>
            prev && prev.userId === fresh.userId && JSON.stringify(prev) !== JSON.stringify(fresh) ? fresh : prev
          );
        }
      }
    });

    // 3. Por fim, o que outras contas compartilharam. Vem depois e em separado
    //    porque depende de uma chamada ao servidor (a lista de convites) e não
    //    pode atrasar a renderização dos dados próprios.
    listShares()
      .then(({ asOwner, asGrantee }) => {
        setSharesAsOwner(asOwner);
        setSharesAsGrantee(asGrantee);
        const accepted = asGrantee.filter((s) => s.status === "accepted");
        // Purga SEMPRE, antes de sincronizar: qualquer titular que saiu da lista
        // de aceitos teve o acesso revogado e não pode continuar legível offline
        // (ver dropSharedData). Rodar isto só quando a lista zera deixaria o
        // prontuário do titular que revogou no aparelho de quem ainda cuida de
        // outro paciente.
        dbLocal.dropSharedData(
          activeUser.userId,
          accepted.map((s) => ({ ownerUid: s.ownerUid, medicadoId: s.medicadoId })),
        );
        if (accepted.length === 0) {
          loadFromCache();
          return;
        }
        return dbLocal
          .syncSharedFromFirebase(activeUser.userId, accepted.map((s) => ({ ownerUid: s.ownerUid, medicadoId: s.medicadoId })))
          .then(() => loadFromCache());
      })
      .catch((err) => {
        // Offline ou servidor fora: mantém o que já está em cache. Não é erro
        // que mereça interromper o app.
        console.warn("Falha ao carregar compartilhamentos:", err);
      });
  }, [activeUser]);

  // Reconcile subscription/trial state with the server. Grants the 7-day trial
  // to legacy users (server-side, since the client can't write freeTrialUntil)
  // and pulls any status set by the payment webhook. Updates `activeUser` in
  // place only when something actually changed, so it can't loop.
  // Returns the fresh profile (or null on failure) so callers that need to act
  // on the result — o poll pós-checkout e a revalidação ao tocar num scanner
  // bloqueado — não dependam do `activeUser` da closure, que ainda é o antigo
  // logo depois do setState.
  const syncSubscription = useCallback(async (): Promise<User | null> => {
    const current = auth.currentUser;
    if (!current) return null;
    try {
      const token = await current.getIdToken();
      const res = await fetch("/api/subscription/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return null;
      const data = await res.json();
      const prev = activeUserRef.current;
      if (!prev) return null;
      const next: User = {
        ...prev,
        // Nome/status vêm junto: é por este endpoint que uma correção feita
        // no painel admin alcança um app que não foi recarregado.
        name: data.name ?? prev.name,
        status: data.status ?? prev.status,
        freeTrialUntil: data.freeTrialUntil ?? prev.freeTrialUntil,
        subscriptionStatus: data.subscriptionStatus ?? prev.subscriptionStatus,
        subscriptionPlan: data.subscriptionPlan ?? prev.subscriptionPlan,
        subscriptionCurrentPeriodEnd: data.subscriptionCurrentPeriodEnd ?? prev.subscriptionCurrentPeriodEnd,
        scanLimitExempt: data.scanLimitExempt ?? prev.scanLimitExempt,
        trialPrescriptionScansUsed: data.trialPrescriptionScansUsed ?? prev.trialPrescriptionScansUsed,
        trialReceiptScansUsed: data.trialReceiptScansUsed ?? prev.trialReceiptScansUsed,
      };
      // Só re-renderiza quando algo mudou de fato, senão o efeito que dispara
      // este sync entraria em laço.
      if (JSON.stringify(next) !== JSON.stringify(prev)) {
        dbLocal.setUserCache(next);
        activeUserRef.current = next;
        setActiveUser(next);
      }
      return next;
    } catch {
      /* rede offline — o app segue com o estado em cache */
      return null;
    }
  }, []);

  // Um scanner bloqueado revalida ANTES de mostrar o paywall: sem isso, uma
  // gratuidade recém-concedida pelo admin só chegava no próximo retorno ao
  // primeiro plano (e ainda assim depois da trava de 5 min), e a pessoa via
  // "Assine para escanear" com acesso já liberado no servidor. Devolve true
  // quando o acesso apareceu — aí o próprio componente abre o scanner.
  const handleBlockedScanAttempt = useCallback(
    async (scanType: ScanType): Promise<boolean> => {
      const fresh = await syncSubscription();
      if (fresh && canPerformScan(fresh, scanType)) return true;
      setShowSubscription(true);
      return false;
    },
    [syncSubscription]
  );

  // Sync subscription on login/user change.
  useEffect(() => {
    if (!activeUser) return;
    syncSubscription();
  }, [activeUser?.userId, syncSubscription]);

  // Same reasoning as the auth-session foreground check above: a PWA installed
  // on mobile is backgrounded/foregrounded without a full document reload, so
  // an already-mounted session's subscription fields go stale while the app
  // sits in the background — an admin reconciling a payment (or the Mercado
  // Pago webhook finally landing) never reaches it otherwise. This is exactly
  // what left a user seeing "expirada" on their phone after an admin had
  // already granted real access server-side: reopening the already-running
  // app is a foreground event, not a fresh mount, so the login-sync effect
  // above never re-fires.
  useEffect(() => {
    if (!activeUser) return;
    let lastChecked = 0;
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastChecked < 5 * 60 * 1000) return;
      lastChecked = now;
      syncSubscription();
    };
    // Reconexão entra na mesma lógica (sem a trava de tempo): enquanto estava
    // offline, qualquer sync anterior falhou silenciosamente e o estado em
    // cache pode estar atrasado em relação ao servidor.
    const onOnline = () => {
      lastChecked = Date.now();
      syncSubscription();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
    };
  }, [activeUser?.userId, syncSubscription]);

  // Abrir a tela de assinatura ou a aba de perfil é justamente quando a pessoa
  // vai conferir "o admin já liberou?" — revalida na hora, sem trava.
  useEffect(() => {
    if (!activeUser) return;
    if (!showSubscription && activeTab !== "profile") return;
    syncSubscription();
  }, [showSubscription, activeTab, activeUser?.userId, syncSubscription]);

  // Returning from the card Checkout Pro (MP redirects to /app?sub=...). The
  // Mercado Pago webhook that actually activates the subscription can land a
  // few seconds AFTER this redirect, and Firebase Auth may not have finished
  // restoring the session at the exact instant this effect runs on a fresh
  // page load — a single sync attempt right here is unreliable and fails
  // silently either way (this is exactly what left a paying user stuck on
  // "trial" until they force-reopened the app). So: clean the query string
  // immediately (before any async work, so a reload mid-poll can't re-trigger
  // this), wait for a real signed-in user via onAuthStateChanged instead of
  // assuming auth.currentUser is ready, then poll sync (same cadence as the
  // PIX confirmation poll in SubscriptionScreen) until the webhook catches up
  // or a reasonable window elapses.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const sub = params.get("sub");
    if (!sub) return;

    // Mercado Pago anexa o id do pagamento no back_url do Checkout Pro
    // (auto_return) — capturamos antes de limpar a URL para poder perguntar
    // diretamente a eles como último recurso, caso o webhook nunca chegue.
    const returnedPaymentId = params.get("payment_id") || params.get("collection_id");

    params.delete("sub");
    params.delete("payment_id");
    params.delete("collection_id");
    params.delete("status");
    params.delete("collection_status");
    params.delete("merchant_order_id");
    params.delete("preference_id");
    params.delete("payment_type");
    const clean = window.location.pathname + (params.toString() ? `?${params}` : "") + window.location.hash;
    window.history.replaceState({}, "", clean);

    if (sub !== "success") {
      syncSubscription();
      return;
    }

    showToast("Pagamento recebido! Confirmando sua assinatura...");

    let cancelled = false;
    let pollTimeout: ReturnType<typeof setTimeout> | undefined;
    const unsubscribeAuth = onAuthStateChanged(auth, (fbUser) => {
      if (!fbUser || cancelled) return;
      cancelled = true;
      unsubscribeAuth();

      let attempts = 0;
      const maxAttempts = 10; // ~30s no total, mesma janela de tolerância do polling do PIX
      const poll = async () => {
        const synced = await syncSubscription();
        attempts++;
        if (synced && getAccessState(synced) === "active") return;
        if (attempts >= maxAttempts) {
          // Último recurso: pergunta direto ao Mercado Pago por ESTE pagamento
          // em vez de só esperar o webhook, que pode nunca chegar (falha de
          // entrega do lado deles — algo que nenhum log nosso consegue ver).
          if (returnedPaymentId) {
            try {
              const token = await fbUser.getIdToken();
              await fetch("/api/subscription/verify-payment", {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                body: JSON.stringify({ paymentId: returnedPaymentId }),
              });
            } catch { /* melhor esforço — o toast abaixo já orienta a reabrir o app */ }
            const finalSync = await syncSubscription();
            if (finalSync && getAccessState(finalSync) === "active") return;
          }
          showToast("Ainda estamos confirmando seu pagamento. Se não atualizar em instantes, reabra o app.");
          return;
        }
        pollTimeout = setTimeout(poll, 3000);
      };
      poll();
    });

    return () => {
      cancelled = true;
      unsubscribeAuth();
      if (pollTimeout) clearTimeout(pollTimeout);
    };
  }, [syncSubscription]);

  // ==========================================
  // PWA & Background Notification Services
  // ==========================================
  
  // Service Worker registration + verificador de versão. O registro do SW mora
  // dentro de initAppUpdater (src/appUpdate.ts) porque as duas coisas são a
  // mesma: é o ciclo de vida do worker que carrega o bundle novo. O prompt de
  // instalação do PWA NÃO é tratado aqui — ver useInstallPrompt, que é dono de
  // beforeinstallprompt/appinstalled.
  useEffect(() => {
    if (typeof window === "undefined") return;

    if ("Notification" in window) {
      setNotificationPermission(Notification.permission);
    }

    initAppUpdater({
      // Só chega aqui quando o app está em primeiro plano; em segundo plano a
      // atualização é aplicada sozinha, sem avisar.
      onUpdateReady: () => setUpdateReady(true),
    });
  }, []);

  // Register this browser for server-sent (VAPID) push once a user is signed in
  // and has granted notification permission — this is what delivers dose
  // reminders when the app is fully closed. Isolation is enforced server-side:
  // the subscription is stored under the authenticated uid from the ID token.
  useEffect(() => {
    if (!activeUser || notificationPermission !== "granted") return;
    subscribeToPush(() => auth.currentUser?.getIdToken() ?? Promise.resolve(undefined)).then(setPushRegistered);
  }, [activeUser, notificationPermission]);

  // Listen for navigation / hash changes to toggle separate Admin Page mode
  useEffect(() => {
    const handleLocationChange = () => {
      setIsAdminRoute(
        window.location.pathname === "/app/admin" ||
        window.location.pathname === "/app/admin/" ||
        window.location.hash.startsWith("#/admin")
      );
    };
    window.addEventListener("popstate", handleLocationChange);
    window.addEventListener("hashchange", handleLocationChange);
    return () => {
      window.removeEventListener("popstate", handleLocationChange);
      window.removeEventListener("hashchange", handleLocationChange);
    };
  }, []);

  // Link do e-mail de convite (`#/convite/{shareId}`): leva para a aba onde o
  // convite pendente aparece com os botões de aceitar/recusar. Não aceita nada
  // sozinho — o consentimento tem de ser um clique explícito de quem recebeu.
  // Depende de `activeUser` porque quem chega pelo e-mail costuma cair antes na
  // tela de login; o efeito reroda assim que a sessão existe.
  useEffect(() => {
    if (!activeUser) return;
    const goToInvite = () => {
      if (window.location.hash.startsWith("#/convite/")) {
        setActiveTab("profile");
        // Limpa o hash para o convite não reabrir a cada refresh depois de
        // resolvido, preservando o resto da URL.
        window.history.replaceState(null, "", window.location.pathname + window.location.search);
      }
    };
    goToInvite();
    window.addEventListener("hashchange", goToInvite);
    return () => window.removeEventListener("hashchange", goToInvite);
  }, [activeUser]);

  // Desktop visitors land on /app only if they explicitly chose to (via the
  // landing page CTA, which sets DESKTOP_ENTER_FLAG). Otherwise send them to
  // the marketing landing page instead of the raw mobile-first UI.
  useEffect(() => {
    if (isDesktop && !desktopEntered && !isAdminRoute) {
      window.location.href = "/";
    }
  }, [isDesktop, desktopEntered, isAdminRoute]);

  // Background check for scheduled medicine doses. Uses the SAME dueDoseMs the
  // server-side Web Push dispatcher uses (src/doseSchedule.ts), so both agree on
  // exactly when a dose is due — no more local-time vs. absolute-instant drift.
  useEffect(() => {
    if (!activeUser || medicamentos.length === 0) return;

    const checkDosesAndNotify = () => {
      const nowMs = Date.now();

      medicamentos.forEach((med) => {
        if (med.status !== "active") return;

        const doseMs = dueDoseMs(med, nowMs);
        if (doseMs == null) return;

        // Skip if this exact dose was already logged as taken (matched within
        // the same minute — dose log times are stored as ISO-ish strings).
        const doseMinute = Math.floor(doseMs / 60000);
        const isTaken = doseLogs.some((log) => {
          if (log.medicamentoId !== med.medicamentoId) return false;
          const t = new Date(log.plannedTime).getTime();
          return Number.isFinite(t) && Math.floor(t / 60000) === doseMinute;
        });
        if (isTaken) return;

        // Dedupe: each dose slot notifies at most once per device. Key is tied
        // to the absolute dose instant, matching the server's tag format.
        const notifiedKey = `notified_${med.medicamentoId}_${doseMs}`;
        if (localStorage.getItem(notifiedKey)) return;

        const offsetMin = med.reminderOffset || 0;
        // Notification text is intentionally generic — no patient name, medicine
        // name or dosage (PHI) on the lock screen. Details are only shown after
        // the user unlocks the device and opens the app.
        const body = offsetMin > 0
          ? `Sua próxima dose é em ${offsetMin} minutos. Abra o aplicativo para verificar os detalhes.`
          : "Você tem uma nova dose pendente. Abra o aplicativo para verificar os detalhes.";

        if ("serviceWorker" in navigator && Notification.permission === "granted") {
          navigator.serviceWorker.ready.then((reg) => {
            reg.showNotification("Lembrete de Medicamento", {
              body,
              icon: "https://images.unsplash.com/photo-1584017911766-d451b3d0e843?w=192&h=192&fit=crop&auto=format",
              badge: "https://images.unsplash.com/photo-1584017911766-d451b3d0e843?w=192&h=192&fit=crop&auto=format",
              vibrate: [300, 100, 300],
              requireInteraction: true,
              tag: `dose_${med.medicamentoId}_${doseMs}`,
            } as any);
          });
        } else if (Notification.permission === "granted") {
          new Notification("Lembrete de Medicamento", { body });
        }

        localStorage.setItem(notifiedKey, "true");
      });
    };

    checkDosesAndNotify();
    const interval = setInterval(checkDosesAndNotify, 20000);
    return () => clearInterval(interval);
  }, [activeUser, medicamentos, doseLogs]);

  const requestNotificationPermission = async () => {
    if (!("Notification" in window)) {
      showToast("Este navegador não suporta notificações.");
      return;
    }

    try {
      const permission = await Notification.requestPermission();
      setNotificationPermission(permission);
      if (permission === "granted") {
        showToast("Excelente! Notificações de Alerta ativadas!");
        // Register for server push right away so reminders arrive with the app closed.
        // Awaited (unlike the background sync effect) specifically so a failure here
        // is visible — this is the one moment the user is actively watching for
        // confirmation, and a silent failure here is exactly what left production
        // with zero push subscriptions despite the feature "working".
        subscribeToPush(() => auth.currentUser?.getIdToken() ?? Promise.resolve(undefined)).then((ok) => {
          setPushRegistered(ok);
          if (!ok) {
            // iOS grants the OS permission dialog even outside standalone mode, but
            // PushManager simply doesn't exist there — so this is the single most
            // likely reason "ativado" doesn't actually deliver anything, and the
            // generic message below would leave the user just as stuck as before.
            if (isIOSDevice() && !isPWAInstalled) {
              showToast("No iPhone, os lembretes com o app fechado só funcionam depois de instalado: toque em 'Instalar no Celular' acima (Compartilhar > Adicionar à Tela de Início), abra o app por esse ícone e tente de novo.");
            } else {
              showToast("Alertas no navegador ativados, mas não consegui habilitar o lembrete com o app fechado. Tente novamente em instantes.");
            }
          }
        });
        if ("serviceWorker" in navigator) {
          navigator.serviceWorker.ready.then((reg) => {
            reg.showNotification("HoraCerta AI - Alertas Ativados", {
              body: "Você começará a receber lembretes de seus remédios diretamente no celular!",
              icon: "https://images.unsplash.com/photo-1584017911766-d451b3d0e843?w=192&h=192&fit=crop&auto=format",
            });
          });
        }
      } else if (permission === "denied") {
        showToast("Permissão de notificação negada.");
      }
    } catch (err) {
      console.error("Erro ao solicitar permissão de notificações:", err);
    }
  };

  const triggerTestNotification = () => {
    if (notificationPermission !== "granted") {
      showToast("Por favor, ative as notificações primeiro!");
      return;
    }

    showToast("Lembrete de teste em 3 segundos... Minimize o app!");

    setTimeout(() => {
      if ("serviceWorker" in navigator) {
        navigator.serviceWorker.ready.then((reg) => {
          reg.showNotification("Lembrete de Medicamento (Teste)", {
            body: "Você tem uma nova dose pendente. Abra o aplicativo para verificar os detalhes.",
            icon: "https://images.unsplash.com/photo-1584017911766-d451b3d0e843?w=192&h=192&fit=crop&auto=format",
            badge: "https://images.unsplash.com/photo-1584017911766-d451b3d0e843?w=192&h=192&fit=crop&auto=format",
            vibrate: [200, 100, 200],
            requireInteraction: true,
          } as any);
        });
      } else {
        new Notification("Lembrete de Medicamento (Teste)", {
          body: "Você tem uma nova dose pendente. Abra o aplicativo para verificar os detalhes.",
        });
      }
    }, 3000);
  };

  // Single entry point for every install affordance (bottom sheet, Home card,
  // Perfil button). Fires the browser's own prompt when there is one; otherwise
  // falls back to the illustrated step-by-step, which is the only path on iOS.
  const installPWAApp = async () => {
    setInstallSheetOpen(false);
    const outcome = await install.promptInstall();
    if (outcome === "manual") {
      setShowInstallGuide(true);
    } else if (outcome === "accepted") {
      showToast("HoraCerta AI instalado com sucesso!");
    }
  };

  const dismissInstallSheet = () => {
    setInstallSheetOpen(false);
    install.snooze();
  };

  const confirmManualInstall = () => {
    setShowInstallGuide(false);
    install.markInstalled();
    showToast("Pronto! Abra o HoraCerta pelo ícone na tela inicial.");
  };

  // Raise the sheet once the user is signed in — asking before login would
  // invite someone to install an app they haven't decided to use yet. Desktop
  // is excluded: those visitors get bounced to the landing page anyway, and the
  // Perfil button already covers them.
  useEffect(() => {
    if (!activeUser || installSheetAsked || isDesktop) return;
    if (!install.canInstall) return;

    const timer = setTimeout(() => {
      setInstallSheetOpen(true);
      setInstallSheetAsked(true);
    }, 2500);
    return () => clearTimeout(timer);
  }, [activeUser, installSheetAsked, isDesktop, install.canInstall]);

  // Profile tab specific states
  const [profilePassword, setProfilePassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [profileStream, setProfileStream] = useState<MediaStream | null>(null);
  const profileVideoRef = React.useRef<HTMLVideoElement | null>(null);

  // Manage profile camera stream lifecycle
  useEffect(() => {
    let activeStream: MediaStream | null = null;
    if (isCameraActive) {
      navigator.mediaDevices.getUserMedia({ video: { width: 300, height: 300 } })
        .then((stream) => {
          activeStream = stream;
          setProfileStream(stream);
          if (profileVideoRef.current) {
            profileVideoRef.current.srcObject = stream;
          }
        })
        .catch((err) => {
          console.error("Camera access error:", err);
          showToast("Não foi possível acessar a câmera do dispositivo.");
          setIsCameraActive(false);
        });
    } else {
      if (profileStream) {
        profileStream.getTracks().forEach(t => t.stop());
        setProfileStream(null);
      }
    }

    return () => {
      if (activeStream) {
        activeStream.getTracks().forEach(t => t.stop());
      }
    };
  }, [isCameraActive]);

  const handleCapturePhoto = async () => {
    if (!profileVideoRef.current) return;
    const canvas = document.createElement("canvas");
    canvas.width = 300;
    canvas.height = 300;
    const ctx = canvas.getContext("2d");
    if (ctx && activeUser) {
      ctx.drawImage(profileVideoRef.current, 0, 0, 300, 300);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
      const ok = await handleUpdateUser({ ...activeUser, avatarUrl: dataUrl });
      if (ok) {
        showToast("Sua foto de perfil foi atualizada com sucesso!");
      }
    }
    setIsCameraActive(false);
  };

  // Avatar upload guardrails live in the shared image util (validate type/size,
  // downscale) so the profile avatar and the patient photo enforce the same
  // limits before anything touches localStorage/Firestore.
  const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file later
    if (!file || !activeUser) return;

    const result = await processImageFile(file);
    if (!result.ok || !result.dataUrl) {
      showToast(result.error || "Não foi possível processar a imagem.");
      return;
    }
    const ok = await handleUpdateUser({ ...activeUser, avatarUrl: result.dataUrl });
    if (ok) {
      showToast("Sua foto de perfil foi carregada com sucesso!");
    }
  };

  const handleSavePassword = async () => {
    if (!activeUser) return;
    if (profilePassword.trim().length < 6) {
      showToast("A senha deve ter pelo menos 6 caracteres.");
      return;
    }
    if (!auth.currentUser || auth.currentUser.uid !== activeUser.userId) {
      showToast("Não é possível alterar a senha nesta sessão. Faça login novamente.");
      return;
    }
    try {
      await updatePassword(auth.currentUser, profilePassword);
      setProfilePassword("");
      showToast("Sua senha de acesso foi atualizada!");
    } catch (err: any) {
      if (err.code === "auth/requires-recent-login") {
        showToast("Por segurança, faça login novamente antes de trocar a senha.");
      } else {
        showToast("Não foi possível atualizar a senha.");
      }
    }
  };

  // Show visual toast notifications
  const showToast = (message: string) => {
    setSuccessToast(message);
    setTimeout(() => {
      setSuccessToast(null);
    }, 4000);
  };

  // Records an alteration/deletion for the Admin Portal's audit trail.
  // Fire-and-forget, like every other dbFirebase write in this app — a
  // logging failure must never block the mutation it's describing.
  // `actor` defaults to the signed-in app user, but admin-portal handlers
  // pass activeAdminUser explicitly since that's the real actor there.
  const logAction = (
    action: "update" | "delete",
    entityType: string,
    entityId: string,
    entityLabel: string,
    page: string,
    actor?: User | null,
    changesSummary?: string
  ) => {
    const user = actor ?? activeUser;
    if (!user) return;
    dbFirebase
      .logAction({
        actorId: user.userId,
        actorName: user.name,
        actorEmail: user.email,
        action,
        entityType,
        entityId,
        // Minimização na origem: dado que não sai do navegador não precisa
        // ser expurgado depois nem aparece para o admin.
        entityLabel: auditLabelFor(entityType, entityId, entityLabel),
        page,
        ...(changesSummary ? { changesSummary } : {}),
      })
      .catch((e) => console.warn("Falha ao registrar log de ação:", e));
  };

  // ==========================================
  // PATIENTS (MEDICADOS) CRUD HANDLERS
  // ==========================================
  // Um registro criado DENTRO de um paciente compartilhado precisa nascer com
  // dois valores herdados do medicado pai, ou o Firestore recusa a escrita:
  //   - `userId` = o TITULAR (é a árvore dele), não quem está escrevendo;
  //   - as listas de acesso idênticas às do pai (regra inheritsShareLists),
  //     sem o que o registro nasceria invisível para os outros cuidadores.
  const inheritFromPatient = (medicadoId: string) => {
    const patient = medicados.find((m) => m.medicadoId === medicadoId);
    return {
      userId: patient?.userId ?? activeUser!.userId,
      ...(patient?.memberUids ? { memberUids: patient.memberUids } : {}),
      ...(patient?.editorUids ? { editorUids: patient.editorUids } : {}),
    };
  };

  // Bloqueia a ação de quem só acompanha. As regras já recusariam a escrita —
  // isto existe para o acompanhante receber uma explicação em vez de ver a
  // alteração aparecer na tela (cache local otimista) e sumir no próximo sync.
  //
  // Se o paciente não for encontrado no estado, LIBERA em vez de bloquear: o
  // gate de verdade é o firestore.rules, e barrar aqui por uma lista ainda não
  // carregada quebraria um usuário comum sem ganho nenhum de segurança.
  const assertCanEdit = (medicadoId: string): boolean => {
    if (!activeUser) return false;
    const patient = medicados.find((m) => m.medicadoId === medicadoId);
    if (!patient) return true;
    if (canEditMedicado(patient, activeUser.userId)) return true;
    showToast("Você acompanha este paciente e não pode alterar os registros.");
    return false;
  };

  const refreshPatients = () => setMedicados(dbLocal.getVisibleMedicados(activeUser!.userId));

  const handleAddPatient = (patientData: Omit<Medicado, "medicadoId" | "createdAt" | "userId">) => {
    if (!activeUser) return;
    const newPatient: Medicado = {
      ...patientData,
      medicadoId: `pat_${Date.now()}`,
      userId: activeUser.userId,
      createdAt: new Date().toISOString(),
    };
    dbLocal.addMedicado(newPatient);
    refreshPatients();
    showToast(`Paciente ${newPatient.name} cadastrado com sucesso!`);
  };

  const handleUpdatePatient = (updatedPatient: Medicado) => {
    if (!activeUser) return;
    if (!assertCanEdit(updatedPatient.medicadoId)) return;
    const before = medicados.find((m) => m.medicadoId === updatedPatient.medicadoId);
    dbLocal.updateMedicado(updatedPatient);
    refreshPatients();
    logAction(
      "update", "Medicado", updatedPatient.medicadoId, updatedPatient.name, "Pacientes", undefined,
      describeChanges("Medicado", before, updatedPatient, MEDICADO_AUDIT_FIELDS)
    );
    showToast(`Dados de ${updatedPatient.name} atualizados!`);
  };

  const handleDeletePatient = (patientId: string) => {
    if (!activeUser) return;
    const patient = medicados.find((m) => m.medicadoId === patientId);
    // Excluir o paciente é só do titular: um coadministrador cuida do
    // tratamento, não descarta o prontuário de quem não é dele. Mesma regra do
    // `allow delete` em firestore.rules.
    if (patient && patient.userId !== activeUser.userId) {
      showToast("Só o titular da conta pode remover este paciente.");
      return;
    }
    dbLocal.deleteMedicado(patientId);
    refreshPatients();
    logAction(
      "delete", "Medicado", patientId, patient?.name ?? patientId, "Pacientes", undefined,
      describeChanges("Medicado", patient, undefined, MEDICADO_AUDIT_FIELDS)
    );
    showToast("Paciente removido com sucesso.");
  };

  // ==========================================
  // MEDICINES (MEDICAMENTOS) CRUD HANDLERS
  // ==========================================
  const refreshMedicines = () => setMedicamentos(dbLocal.getVisibleMedicamentos(activeUser!.userId));

  const handleAddMedicine = (medData: Omit<Medicamento, "medicamentoId" | "createdAt" | "userId"> & { createdAt?: string }) => {
    if (!activeUser) return;
    if (!assertCanEdit(medData.medicadoId)) return;
    const newMed: Medicamento = {
      ...medData,
      medicamentoId: `med_${Date.now()}`,
      ...inheritFromPatient(medData.medicadoId),
      createdAt: medData.createdAt || new Date().toISOString(),
    };
    dbLocal.addMedicamento(newMed);
    refreshMedicines();
    showToast(`Medicamento ${newMed.name} agendado!`);
  };

  const handleUpdateMedicine = (updatedMed: Medicamento) => {
    if (!activeUser) return;
    if (!assertCanEdit(updatedMed.medicadoId)) return;
    const before = medicamentos.find((m) => m.medicamentoId === updatedMed.medicamentoId);
    dbLocal.updateMedicamento(updatedMed);
    refreshMedicines();
    logAction(
      "update", "Medicamento", updatedMed.medicamentoId, updatedMed.name, "Medicamentos", undefined,
      describeChanges("Medicamento", before, updatedMed, MEDICAMENTO_AUDIT_FIELDS)
    );
  };

  const handleDeleteMedicine = (medId: string) => {
    if (!activeUser) return;
    const med = medicamentos.find((m) => m.medicamentoId === medId);
    if (med && !assertCanEdit(med.medicadoId)) return;
    dbLocal.deleteMedicamento(medId);
    refreshMedicines();
    logAction(
      "delete", "Medicamento", medId, med?.name ?? medId, "Medicamentos", undefined,
      describeChanges("Medicamento", med, undefined, MEDICAMENTO_AUDIT_FIELDS)
    );
    showToast("Medicamento removido da programação.");
  };

  // ==========================================
  // DOSE LOGS HANDLERS
  // ==========================================
  const handleAddDoseLog = (log: Omit<DoseLog, "userId">) => {
    if (!activeUser) return;
    if (!assertCanEdit(log.medicadoId)) return;
    dbLocal.addDoseLog({
      ...log,
      ...inheritFromPatient(log.medicadoId),
      // Quem clicou. É o campo que responde "o cuidador deu o remédio das 14h?"
      // — as regras o amarram ao uid autenticado, então não é falsificável.
      registradoPor: activeUser.userId,
    });
    setDoseLogs(dbLocal.getVisibleDoseLogs(activeUser.userId));
    showToast("Medicamento marcado como TOMADO! Saúde garantida.");
  };

  // ==========================================
  // APPOINTMENTS (CONSULTAS) CRUD HANDLERS
  // ==========================================
  const refreshAppointments = () => setConsultas(dbLocal.getVisibleConsultas(activeUser!.userId));

  const handleAddAppointment = (apptData: Omit<Consulta, "consultaId" | "createdAt">) => {
    if (!activeUser) return;
    if (!assertCanEdit(apptData.medicadoId)) return;
    const newAppt: Consulta = {
      ...apptData,
      consultaId: `appt_${Date.now()}`,
      ...inheritFromPatient(apptData.medicadoId),
      createdAt: new Date().toISOString(),
    };
    dbLocal.addConsulta(newAppt);
    refreshAppointments();
    showToast(`Consulta agendada com ${newAppt.doctorName}.`);
  };

  const handleUpdateAppointment = (updatedAppt: Consulta) => {
    if (!activeUser) return;
    if (!assertCanEdit(updatedAppt.medicadoId)) return;
    const before = consultas.find((c) => c.consultaId === updatedAppt.consultaId);
    dbLocal.updateConsulta(updatedAppt);
    refreshAppointments();
    logAction(
      "update", "Consulta", updatedAppt.consultaId, `${updatedAppt.doctorName} - ${updatedAppt.dateTime}`, "Agenda", undefined,
      describeChanges("Consulta", before, updatedAppt, CONSULTA_AUDIT_FIELDS)
    );
    showToast("Consulta atualizada.");
  };

  const handleDeleteAppointment = (apptId: string) => {
    if (!activeUser) return;
    const appt = consultas.find((c) => c.consultaId === apptId);
    if (appt && !assertCanEdit(appt.medicadoId)) return;
    dbLocal.deleteConsulta(apptId);
    refreshAppointments();
    logAction(
      "delete", "Consulta", apptId, appt ? `${appt.doctorName} - ${appt.dateTime}` : apptId, "Agenda", undefined,
      describeChanges("Consulta", appt, undefined, CONSULTA_AUDIT_FIELDS)
    );
    showToast("Consulta desmarcada.");
  };

  // ==========================================
  // PHARMACIES (FARMACIAS) CRUD HANDLERS
  // ==========================================
  const handleAddFarmacia = (farmData: Omit<Farmacia, "farmaciaId">) => {
    if (!activeUser) return;
    const newFarm: Farmacia = {
      ...farmData,
      farmaciaId: `pharm_${Date.now()}`,
    };
    dbLocal.addFarmacia(newFarm);
    setFarmacias(dbLocal.getFarmacias(activeUser.userId));
    showToast(`Farmácia ${newFarm.name} cadastrada.`);
  };

  const handleUpdateFarmacia = (updatedFarm: Farmacia) => {
    if (!activeUser) return;
    const before = farmacias.find((f) => f.farmaciaId === updatedFarm.farmaciaId);
    dbLocal.updateFarmacia(updatedFarm);
    setFarmacias(dbLocal.getFarmacias(activeUser.userId));
    logAction(
      "update", "Farmacia", updatedFarm.farmaciaId, updatedFarm.name, "Farmácias", undefined,
      describeChanges("Farmacia", before, updatedFarm, FARMACIA_AUDIT_FIELDS)
    );
  };

  const handleDeleteFarmacia = (farmId: string) => {
    if (!activeUser) return;
    const farm = farmacias.find((f) => f.farmaciaId === farmId);
    dbLocal.deleteFarmacia(farmId);
    setFarmacias(dbLocal.getFarmacias(activeUser.userId));
    logAction(
      "delete", "Farmacia", farmId, farm?.name ?? farmId, "Farmácias", undefined,
      describeChanges("Farmacia", farm, undefined, FARMACIA_AUDIT_FIELDS)
    );
    showToast("Farmácia excluída da lista.");
  };

  const handleAddCupom = (establishment: string, date: string, items: { name: string; price: number }[], totalPrice: number) => {
    if (!activeUser) return;
    const newCupom: CupomFiscal = {
      cupomId: `cup_${Date.now()}`,
      userId: activeUser.userId,
      establishment,
      date,
      items,
      totalPrice,
      createdAt: new Date().toISOString()
    };
    dbLocal.addCupom(newCupom);
    setCupons(dbLocal.getCupons(activeUser.userId));
    showToast(`Nota Fiscal da "${establishment}" lida e gravada com sucesso por Inteligência Artificial!`);
  };

  const handleDeleteCupom = (cupomId: string) => {
    if (!activeUser) return;
    const cupom = cupons.find((c) => c.cupomId === cupomId);
    dbLocal.deleteCupom(cupomId);
    setCupons(dbLocal.getCupons(activeUser.userId));
    logAction("delete", "CupomFiscal", cupomId, cupom?.establishment ?? cupomId, "Cupons Fiscais");
    showToast("Cupom fiscal removido.");
  };

  // ==========================================
  // ADMIN PANEL CONTROLS (SUPER-USER)
  // ==========================================
  // Awaits the real Firestore write before touching local state/cache. If the
  // server rejects the write (e.g. permission denied), the client state is
  // left untouched and an error toast is shown — no more optimistic
  // fire-and-forget updates that could silently diverge from the backend.
  const handleUpdateUser = async (updatedUser: User): Promise<boolean> => {
    const before = users.find((u) => u.userId === updatedUser.userId);

    // Só o que MUDOU vai para o Firestore. Mandar o documento inteiro montado a
    // partir da linha renderizada fazia qualquer ação do painel (inclusive um
    // toggle de isenção) reescrever freeTrialUntil/subscriptionCurrentPeriodEnd
    // com o valor que aquela linha tinha ao ser carregada — desfazendo em
    // silêncio um período gravado pelo webhook do Mercado Pago no meio do
    // caminho. As regras validam o documento resultante do merge, então um
    // patch parcial é igualmente válido.
    const patch: Partial<User> = {};
    (Object.keys(updatedUser) as (keyof User)[]).forEach((key) => {
      if (key === "userId" || key === "createdAt") return;
      if (!before || updatedUser[key] !== before[key]) {
        (patch as any)[key] = updatedUser[key];
      }
    });

    if (Object.keys(patch).length === 0) return true;

    try {
      await dbFirebase.updateUserFields(updatedUser.userId, patch);
    } catch (err: any) {
      console.error("Erro ao atualizar usuário no Firestore:", err);
      showToast(`Erro: não foi possível salvar as alterações de ${updatedUser.name} no servidor.`);
      return false;
    }

    // O que a gravação realmente produziu: a base do Firestore com o patch por
    // cima. Usar `updatedUser` aqui reintroduziria pela porta dos fundos o
    // mesmo problema que o patch resolve — os campos que o admin não tocou
    // voltariam ao valor que a linha tinha quando foi renderizada.
    const merged: User = { ...(before ?? updatedUser), ...patch };

    dbLocal.setUserCache(merged);
    if (activeAdminUser) {
      await refreshUsersFromFirestore();
    } else {
      setUsers(dbLocal.getUsers());
    }
    logAction(
      "update", "User", merged.userId, `${merged.name} (${merged.email})`, "Painel Admin", activeAdminUser ?? activeUser,
      describeChanges("User", before, merged, USER_AUDIT_FIELDS)
    );
    showToast(`Cadastro de ${merged.name} atualizado no diretório.`);

    // If the administrator edited their own status or role, update session
    if (activeUser && activeUser.userId === merged.userId) {
      setActiveUser(merged);
    }
    return true;
  };

  // Suspender/reativar NÃO passa por handleUpdateUser: gravar status no
  // Firestore é só um rótulo — as regras não consultam isUserActive() na
  // leitura e o token do usuário continua válido. Quem corta acesso de fato é
  // o Admin SDK (disabled + revokeRefreshTokens), daí o endpoint dedicado.
  const handleSetUserStatus = async (
    user: User,
    nextStatus: "active" | "suspended"
  ): Promise<boolean> => {
    try {
      const idToken = await auth.currentUser?.getIdToken();
      if (!idToken) {
        showToast("Sessão expirada. Faça login novamente no portal.");
        return false;
      }

      const response = await fetch(`/api/admin/users/${encodeURIComponent(user.userId)}/status`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({ status: nextStatus }),
      });

      if (!response.ok) {
        const errJson = await response.json().catch(() => ({}));
        throw new Error(errJson.error || "Falha ao alterar o status do usuário.");
      }
    } catch (err: any) {
      console.error("Erro ao alterar status do usuário:", err);
      showToast(err.message || "Não foi possível alterar o status do usuário.");
      return false;
    }

    const updated: User = { ...user, status: nextStatus };
    dbLocal.setUserCache(updated);
    if (activeAdminUser) {
      await refreshUsersFromFirestore();
    } else {
      setUsers(dbLocal.getUsers());
    }
    logAction(
      "update", "User", user.userId, `${user.name} (${user.email})`, "Painel Admin", activeAdminUser ?? activeUser,
      describeChanges("User", user, updated, USER_AUDIT_FIELDS)
    );
    showToast(
      nextStatus === "suspended"
        ? `${user.name} foi suspenso: login bloqueado e sessões ativas encerradas.`
        : `${user.name} foi reativado e já pode acessar novamente.`
    );
    return true;
  };

  const handleDeleteUser = async (userId: string): Promise<boolean> => {
    const targetUser = users.find((u) => u.userId === userId);

    // Deleting your own profile is a footgun: the Auth account survives (only
    // the Admin SDK can remove it), so the next admin login just recreates the
    // doc — it looks like the deletion silently "undid" itself.
    if (activeAdminUser && activeAdminUser.userId === userId) {
      showToast("Você não pode remover o próprio cadastro de administrador.");
      return false;
    }

    // Hard delete via the Admin SDK endpoint: wipes the whole Firestore tree
    // (prontuário, receitas, doses, cupons…) AND the Auth account. Deleting
    // only the profile doc from the client left the login working and every
    // subcollection orphaned — no good for an LGPD erasure request.
    try {
      const idToken = await auth.currentUser?.getIdToken();
      if (!idToken) {
        showToast("Sessão expirada. Faça login novamente no portal.");
        return false;
      }

      const response = await fetch(`/api/admin/users/${encodeURIComponent(userId)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${idToken}` },
      });

      if (!response.ok) {
        const errJson = await response.json().catch(() => ({}));
        throw new Error(errJson.error || "Falha ao excluir o usuário no servidor.");
      }
    } catch (err: any) {
      console.error("Erro ao excluir usuário:", err);
      showToast(err.message || "Não foi possível excluir o usuário.");
      return false;
    }

    dbLocal.removeUserCache(userId);
    if (activeAdminUser) {
      await refreshUsersFromFirestore();
    } else {
      setUsers(dbLocal.getUsers());
    }
    logAction(
      "delete", "User", userId, targetUser ? `${targetUser.name} (${targetUser.email})` : userId, "Painel Admin", activeAdminUser ?? activeUser,
      describeChanges("User", targetUser, undefined, USER_AUDIT_FIELDS)
    );
    showToast("Usuário excluído: dados, login e histórico removidos definitivamente.");
    return true;
  };

  // Não existe criação de usuário pelo admin: as contas nascem do cadastro da
  // própria pessoa (Firebase Auth) na AuthScreen. O handler antigo gravava só
  // no cache local, sem conta de login — um registro fantasma que sumia assim
  // que o diretório passou a vir do Firestore.

  // ==========================================
  // AI prescription scanner registration callback
  // ==========================================
  const handleAddReceita = (
    doctorName: string,
    date: string,
    extractedMedicines: any[],
    medicadoId: string
  ) => {
    if (!activeUser) return;

    if (!assertCanEdit(medicadoId)) return;
    // O titular e as listas de acesso saem do paciente, não de quem escaneou —
    // é o que permite um coadministrador cadastrar a receita do paciente
    // compartilhado sem que ela nasça fora do alcance dos outros cuidadores.
    const inherited = inheritFromPatient(medicadoId);

    // 1. Register Receipt Record
    const recipeId = `rec_${Date.now()}`;
    const newReceita: Receita = {
      receitaId: recipeId,
      medicadoId,
      ...inherited,
      date,
      doctorName,
      extracted: true,
      createdAt: new Date().toISOString(),
    };
    dbLocal.addReceita(newReceita);

    // 2. Register each medicine extracted from the image
    extractedMedicines.forEach((med) => {
      const newMed: Medicamento = {
        medicamentoId: `med_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
        receitaId: recipeId,
        medicadoId,
        ...inherited,
        name: med.name,
        dosage: med.dosage,
        intervalHours: med.intervalHours || 12,
        durationDays: med.durationDays || 30,
        instructions: med.instructions || "",
        category: med.category || "pill",
        status: "active",
        reminderOffset: med.reminderOffset ?? 10,
        pricePlaceholder: Math.floor(Math.random() * 40) + 15.90, // Generate low cost pricing
        createdAt: med.createdAt || new Date().toISOString(),
      };
      dbLocal.addMedicamento(newMed);
    });

    // Refresh layout queries
    setReceitas(dbLocal.getVisibleReceitas(activeUser.userId));
    refreshMedicines();

    showToast(`Receita de ${doctorName} lida e agendada com sucesso por Inteligência Artificial!`);
  };

  const handleDeleteReceita = (receitaId: string) => {
    if (!activeUser) return;
    const receita = receitas.find((r) => r.receitaId === receitaId);
    if (receita && !assertCanEdit(receita.medicadoId)) return;
    dbLocal.deleteReceita(receitaId);
    setReceitas(dbLocal.getVisibleReceitas(activeUser.userId));
    refreshMedicines();
    setDoseLogs(dbLocal.getVisibleDoseLogs(activeUser.userId));
    logAction("delete", "Receita", receitaId, receita ? `${receita.doctorName || "Receita"} - ${receita.date}` : receitaId, "Receitas");
    showToast("Receita médica e seus medicamentos associados foram removidos.");
  };

  // NÃO existe troca/simulação de sessão: o antigo handleSwitchUserSession
  // chamava setActiveUser() com qualquer conta do diretório, abrindo o
  // prontuário de terceiros para o admin sem consentimento (LGPD). O botão que
  // o acionava já tinha sido removido; a função ficou órfã e foi apagada para
  // não ser religada por engano. A única forma de entrar numa conta é o login
  // real dela. Ver "Admin panel scope" no CLAUDE.md.
  const handleLoginSuccess = (user: User) => {
    setActiveUser(user);
    // Reload users in memory so that newly registered users are visible in the user switching lists/admin panel
    setUsers(dbLocal.getUsers());
    localStorage.setItem("horacerta_active_user_id", user.userId);
    setActiveTab("home");
    showToast(`Bem-vindo, ${user.name}!`);
  };

  const handleLogout = async () => {
    // Remove this device's push subscription from the leaving user's tree BEFORE
    // clearing the session, so their reminders never reach a device that another
    // account might sign into next (isolation on shared devices).
    // MUST be awaited: it needs a valid ID token, and the signOut below would
    // null out auth.currentUser and make the unsubscribe silently no-op,
    // orphaning this device's subscription on the server.
    // Suppresses the orphaned-session teardown that the signOut below would
    // otherwise trigger (it fires onAuthStateChanged(null) while the
    // localStorage pointers are still set, a few lines further down).
    signingOutRef.current = true;
    await unsubscribeFromPush(() => auth.currentUser?.getIdToken() ?? Promise.resolve(undefined));
    setPushRegistered(false);
    // End the real Firebase Auth session too — otherwise auth.currentUser stays
    // signed in after "logout", so a next user on the same device could still
    // mint ID tokens for the previous account.
    await firebaseSignOut(auth).catch(() => {});
    // Wipe cached health data (PHI) so it never lingers in localStorage for the
    // next person on a shared device, then drop the in-memory copies.
    dbLocal.clearLocalData();
    setMedicados([]);
    setReceitas([]);
    setMedicamentos([]);
    setDoseLogs([]);
    setConsultas([]);
    setFarmacias([]);
    setCupons([]);
    setSharesAsOwner([]);
    setSharesAsGrantee([]);
    setActiveUser(null);
    localStorage.removeItem("horacerta_active_user_id");
    setActiveTab("home");
    showToast("Sessão encerrada com sucesso!");
    signingOutRef.current = false;
  };

  // ==========================================
  // COMPARTILHAMENTO ENTRE CUIDADORES
  // ==========================================

  // Recarrega os convites e, com eles, os dados dos pacientes compartilhados.
  // Chamado depois de toda mutação porque aceitar ou revogar muda o que este
  // usuário enxerga — não só a lista de convites.
  const reloadShares = useCallback(async () => {
    if (!activeUser) return;
    const { asOwner, asGrantee } = await listShares();
    setSharesAsOwner(asOwner);
    setSharesAsGrantee(asGrantee);

    const accepted = asGrantee.filter((s) => s.status === "accepted");
    // Purga antes de sincronizar, sempre — é este o caminho percorrido logo
    // depois de uma revogação (reloadShares roda após cada mutação).
    dbLocal.dropSharedData(
      activeUser.userId,
      accepted.map((s) => ({ ownerUid: s.ownerUid, medicadoId: s.medicadoId })),
    );
    if (accepted.length > 0) {
      await dbLocal.syncSharedFromFirebase(
        activeUser.userId,
        accepted.map((s) => ({ ownerUid: s.ownerUid, medicadoId: s.medicadoId })),
      );
    }
    setMedicados(dbLocal.getVisibleMedicados(activeUser.userId));
    setReceitas(dbLocal.getVisibleReceitas(activeUser.userId));
    setMedicamentos(dbLocal.getVisibleMedicamentos(activeUser.userId));
    setDoseLogs(dbLocal.getVisibleDoseLogs(activeUser.userId));
    setConsultas(dbLocal.getVisibleConsultas(activeUser.userId));
  }, [activeUser]);

  const handleInviteShare = async (medicadoId: string, email: string, role: ShareRole) => {
    const result = await createShare({ medicadoId, granteeEmail: email, role });
    await reloadShares();
    // O convite é gravado mesmo se o e-mail falhar (ver POST /api/shares), então
    // o aviso precisa distinguir os dois casos — senão o titular fica esperando
    // uma resposta que nunca vai chegar.
    showToast(
      result.emailSent
        ? `Convite enviado para ${email}.`
        : `Convite criado, mas o e-mail para ${email} não saiu. Reenvie mais tarde.`,
    );
  };

  const handleRevokeShare = async (shareId: string) => {
    await revokeShare(shareId);
    await reloadShares();
    showToast("Compartilhamento encerrado.");
  };

  const handleAcceptShare = async (shareId: string) => {
    await acceptShare(shareId);
    await reloadShares();
    showToast("Convite aceito! O paciente já aparece na sua lista.");
  };

  // ==========================================
  // SEPARATE ADMIN PORTAL HANDLERS
  // ==========================================
  const handleAdminLogin = async (email: string, pass: string) => {
    const trimmedEmail = normalizeEmail(email);

    let firebaseUser: FirebaseUser;
    try {
      const credential = await signInWithEmailAndPassword(auth, trimmedEmail, pass);
      firebaseUser = credential.user;
    } catch {
      throw new Error("E-mail ou senha incorretos.");
    }

    // Authorization is driven exclusively by the Firebase custom claim "admin",
    // never by client-side role/password checks.
    const tokenResult = await firebaseUser.getIdTokenResult(true);
    if (tokenResult.claims.admin !== true) {
      await firebaseSignOut(auth);
      throw new Error("Acesso negado: Este portal é restrito para administradores.");
    }

    let profile = await dbFirebase.getUser(firebaseUser.uid);
    if (!profile) {
      profile = {
        userId: firebaseUser.uid,
        name: firebaseUser.displayName || trimmedEmail.split("@")[0],
        email: trimmedEmail,
        role: "admin",
        status: "active",
        createdAt: new Date().toISOString(),
      };
      dbLocal.updateUser(profile);
    }

    if (profile.status === "suspended") {
      await firebaseSignOut(auth);
      throw new Error("Acesso negado: Esta conta está suspensa.");
    }

    setActiveAdminUser(profile);
    localStorage.setItem("horacerta_active_admin_id", profile.userId);
    firebaseUser.getIdToken().then((idToken) => reportLogin(idToken, profile!.name, profile!.email));
    showToast(`Olá, ${profile.name}! Portal de Controle ativado.`);
  };

  const handleAdminLogout = () => {
    firebaseSignOut(auth).catch(() => {});
    setActiveAdminUser(null);
    localStorage.removeItem("horacerta_active_admin_id");
    showToast("Sessão do portal de controle encerrada.");
  };

  // A simulação de sessão ("entrar como" outro usuário) foi REMOVIDA: com
  // contas reais ela dá ao operador acesso a prontuário, medicamentos e
  // receitas de terceiros sem consentimento — inaceitável num app de saúde
  // (LGPD). Para testar permissões, use uma conta de teste em desenvolvimento.

  // Check if session has admin role privileges
  const isAdminSession = activeUser?.role === "admin";

  // Redirect to the landing page is in flight (see effect above) — render
  // nothing so the raw mobile UI never flashes on desktop screens.
  if (isDesktop && !desktopEntered && !isAdminRoute) {
    return null;
  }

  if (isAdminRoute) {
    return (
      <div className="min-h-screen bg-brand-cream text-brand-teal relative selection:bg-brand-coral/20 select-none pb-12 font-sans">
        <UpdateBanner open={updateReady} onUpdate={() => void applyAppUpdate()} />

        {/* Visual Floating Toast */}
        {successToast && (
          <div className="fixed top-6 left-1/2 -translate-x-1/2 z-50 max-w-sm w-[90%] bg-brand-teal border-2 border-brand-coral-light/30 text-brand-cream rounded-2xl px-4 py-3.5 shadow-xl flex items-start gap-3 animate-slide-down">
            <CheckCircle2 className="w-5 h-5 text-brand-coral shrink-0 mt-0.5" />
            <div>
              <p className="text-xs font-bold font-display">Controle Administrativo</p>
              <p className="text-[11px] text-brand-cream/80 font-sans mt-0.5">{successToast}</p>
            </div>
          </div>
        )}

        {!activeAdminUser ? (
          /* Separate Admin Auth Screen */
          <div className="min-h-screen flex flex-col justify-center items-center px-4 py-8">
            <div className="w-full max-w-md bg-white border border-brand-cream-darker rounded-[2.5rem] p-8 shadow-xl relative overflow-hidden">
              <div className="absolute top-0 right-0 w-32 h-32 bg-brand-coral/10 rounded-full translate-x-12 -translate-y-12" />
              
              <div className="text-center relative z-10 mb-8">
                <div className="w-14 h-14 bg-brand-teal text-brand-cream rounded-3xl flex items-center justify-center mx-auto mb-4 border border-brand-cream-darker shadow-sm">
                  <Shield className="w-7 h-7 text-brand-cream" />
                </div>
                <h1 className="text-2xl font-display font-bold text-brand-teal tracking-tight">
                  Portal do Administrador
                </h1>
                <p className="text-xs text-ink-soft font-sans mt-1">
                  Acesso seguro e restrito para gestão global da plataforma
                </p>
              </div>

              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  const target = e.target as typeof e.target & {
                    email: { value: string };
                    password: { value: string };
                  };
                  try {
                    await handleAdminLogin(target.email.value, target.password.value);
                  } catch (err: any) {
                    showToast(err.message);
                  }
                }}
                className="space-y-4 relative z-10"
              >
                <div className="space-y-1.5">
                  <label htmlFor="admin-login-email" className="text-[11px] font-bold text-brand-teal uppercase tracking-wider block">
                    E-mail do Administrador
                  </label>
                  <div className="relative">
                    <span className="absolute inset-y-0 left-0 pl-3.5 flex items-center text-ink-soft">
                      <Mail className="w-4 h-4" />
                    </span>
                    <input
                      id="admin-login-email"
                      name="email"
                      type="email"
                      required
                      placeholder="seu.email@exemplo.com"
                      className="w-full bg-brand-cream/40 border border-brand-cream-darker rounded-xl pl-10 pr-4 py-3 text-xs text-brand-teal placeholder-gray-400 font-sans focus:outline focus:outline-2 focus:outline-offset-1 focus:outline-brand-coral focus:border-brand-teal/50 transition-all font-medium"
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="admin-login-password" className="text-[11px] font-bold text-brand-teal uppercase tracking-wider block">
                    Senha Secreta
                  </label>
                  <div className="relative">
                    <span className="absolute inset-y-0 left-0 pl-3.5 flex items-center text-ink-soft">
                      <Lock className="w-4 h-4" />
                    </span>
                    <input
                      id="admin-login-password"
                      name="password"
                      type="password"
                      required
                      placeholder="Senha de acesso admin"
                      className="w-full bg-brand-cream/40 border border-brand-cream-darker rounded-xl pl-10 pr-4 py-3 text-xs text-brand-teal placeholder-gray-400 font-sans focus:outline focus:outline-2 focus:outline-offset-1 focus:outline-brand-coral focus:border-brand-teal/50 transition-all font-medium"
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  className="w-full font-display font-semibold text-xs py-3.5 bg-brand-teal text-brand-cream rounded-xl hover:bg-brand-teal-light flex items-center justify-center gap-2 shadow-md transition-all active:scale-98"
                >
                  Entrar no Painel de Controle
                  <ArrowRight className="w-4 h-4" />
                </button>
              </form>
            </div>

            <div className="mt-6 text-center z-10">
              <button
                onClick={() => {
                  setIsAdminRoute(false);
                  window.location.hash = "";
                  window.history.pushState({}, "", "/app");
                }}
                className="text-xs font-bold text-brand-teal/50 hover:text-brand-teal transition-all flex items-center gap-1"
              >
                ← Voltar ao Aplicativo Principal
              </button>
            </div>
          </div>
        ) : (
          /* Separate Admin Dashboard Panel */
          <div className="max-w-4xl mx-auto py-6 px-4 space-y-6">
            <div className="flex items-center justify-between border-b border-brand-cream-darker pb-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-brand-teal text-white rounded-xl flex items-center justify-center">
                  <Shield className="w-5 h-5" />
                </div>
                <div>
                  <h1 className="text-lg font-display font-bold text-brand-teal leading-tight">
                    HoraCerta AI - Portal Admin
                  </h1>
                  <p className="text-xs text-ink-soft">
                    Sessão ativa: <strong className="text-brand-coral">{activeAdminUser.name}</strong>
                  </p>
                </div>
              </div>

              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setIsAdminRoute(false);
                    window.location.hash = "";
                    window.history.pushState({}, "", "/app");
                  }}
                  className="px-3.5 py-2 bg-brand-peach/80 hover:bg-brand-peach border border-brand-cream-darker text-brand-teal text-xs font-bold rounded-xl transition-all shadow-sm active:scale-95"
                >
                  Voltar ao App
                </button>
                <button
                  onClick={handleAdminLogout}
                  className="px-3.5 py-2 bg-error-50 hover:bg-error-100 border border-error-100 text-error-600 text-xs font-bold rounded-xl transition-all shadow-sm active:scale-95"
                >
                  Sair do Painel
                </button>
              </div>
            </div>

            <div className="flex bg-brand-cream-dark/50 border border-brand-cream-darker p-1 rounded-2xl">
              <button
                type="button"
                onClick={() => setAdminSection("users")}
                className={`flex-1 py-2 rounded-xl text-xs font-bold transition-all ${
                  adminSection === "users" ? "bg-brand-teal text-white shadow-xs" : "text-brand-teal/70 hover:text-brand-teal"
                }`}
              >
                Usuários
              </button>
              <button
                type="button"
                onClick={() => setAdminSection("payments")}
                className={`flex-1 py-2 rounded-xl text-xs font-bold transition-all ${
                  adminSection === "payments" ? "bg-brand-teal text-white shadow-xs" : "text-brand-teal/70 hover:text-brand-teal"
                }`}
              >
                Pagamentos
              </button>
              <button
                type="button"
                onClick={() => setAdminSection("logs")}
                className={`flex-1 py-2 rounded-xl text-xs font-bold transition-all ${
                  adminSection === "logs" ? "bg-brand-teal text-white shadow-xs" : "text-brand-teal/70 hover:text-brand-teal"
                }`}
              >
                Logs
              </button>
              <button
                type="button"
                onClick={() => setAdminSection("sistema")}
                className={`flex-1 py-2 rounded-xl text-xs font-bold transition-all ${
                  adminSection === "sistema" ? "bg-brand-teal text-white shadow-xs" : "text-brand-teal/70 hover:text-brand-teal"
                }`}
              >
                Sistema
              </button>
            </div>

            {adminSection === "users" ? (
              <AdminPanel
                users={users}
                onUpdateUser={handleUpdateUser}
                onSetUserStatus={handleSetUserStatus}
                onDeleteUser={handleDeleteUser}
                onNotify={showToast}
              />
            ) : adminSection === "payments" ? (
              <AdminPayments />
            ) : adminSection === "sistema" ? (
              <AdminDiagnostics />
            ) : (
              <AdminLogs />
            )}
          </div>
        )}
      </div>
    );
  }

  const appShell = (
    <div className="min-h-screen bg-brand-cream text-brand-teal relative selection:bg-brand-coral/20 select-none pb-20 lg:pb-8 lg:pl-24 lg:bg-paper-canvas">

      <UpdateBanner open={updateReady} onUpdate={() => void applyAppUpdate()} />

      {/* Visual Floating Toast */}
      {successToast && (
        <div className="fixed top-6 left-1/2 -translate-x-1/2 z-50 max-w-sm w-[90%] bg-brand-teal border-2 border-brand-coral-light/30 text-brand-cream rounded-2xl px-4 py-3.5 shadow-xl flex items-start gap-3 animate-slide-down">
          <CheckCircle2 className="w-5 h-5 text-brand-coral shrink-0 mt-0.5" />
          <div>
            <p className="text-xs font-bold font-display">Notificação de Saúde</p>
            <p className="text-[11px] text-brand-cream/80 font-sans mt-0.5">{successToast}</p>
          </div>
        </div>
      )}

      {/* "Install this app" invitation — hidden entirely once installed */}
      {activeUser && (
        <InstallAppSheet
          open={installSheetOpen}
          platform={install.platform}
          onInstall={installPWAApp}
          onDismiss={dismissInstallSheet}
        />
      )}
      <InstallGuideModal
        open={showInstallGuide}
        platform={install.platform}
        onClose={() => setShowInstallGuide(false)}
        onConfirmInstalled={confirmManualInstall}
      />

      {/* Privacy / LGPD full-screen page */}
      {showPrivacyPage && <PrivacyPolicy onBack={() => setShowPrivacyPage(false)} />}

      {showSupportModal && activeUser && (
        <SupportModal user={activeUser} onClose={() => setShowSupportModal(false)} />
      )}

      {/* Subscription / paywall full-screen page */}
      {showSubscription && activeUser && (
        <SubscriptionScreen
          user={activeUser}
          onBack={() => setShowSubscription(false)}
          onSubscribed={() => { syncSubscription(); }}
        />
      )}

      {/* Main app navigation switcher */}
      {!activeUser ? (
        <AuthScreen onLoginSuccess={handleLoginSuccess} />
      ) : (
        <div className="lg:max-w-[1080px] lg:mx-auto lg:my-8 lg:bg-paper lg:border lg:border-paper-border lg:rounded-[28px] lg:p-8 lg:shadow-[0_2px_10px_rgba(0,0,0,0.03)]">
          {/* As quatro abas ficam sempre montadas e só alternam visibilidade via
              CSS: desmontar/remontar a cada troca de aba perdia o estado local
              de UI de cada tela (filtros, modais abertos) e forçava o navegador
              a reemitir as requisições de imagem recriadas do zero — o que na
              aba Network parecia "releitura" a cada navegação. */}
          <div className={activeTab === "home" ? "" : "hidden"}>
            <Dashboard
              userName={activeUser.name}
              medicados={medicados}
              medicamentos={medicamentos}
              doseLogs={doseLogs}
              onAddPatient={handleAddPatient}
              onUpdatePatient={handleUpdatePatient}
              onDeletePatient={handleDeletePatient}
              onToggleDose={(medId, time) => {}}
              onViewSchedule={(date, patientId) => {
                setScheduleDate(date);
                setSchedulePatientId(patientId || "");
                setActiveTab("schedule");
              }}
              onNotify={showToast}
              canInstall={install.isInstallable && !isDesktop}
              onInstall={installPWAApp}
            />
          </div>

          <div className={activeTab === "schedule" ? "" : "hidden"}>
            <Schedule
              medicados={medicados}
              medicamentos={medicamentos}
              doseLogs={doseLogs}
              onAddMedicine={handleAddMedicine}
              onUpdateMedicine={handleUpdateMedicine}
              onDeleteMedicine={handleDeleteMedicine}
              onAddDoseLog={handleAddDoseLog}
              selectedDate={scheduleDate}
              setSelectedDate={setScheduleDate}
              selectedPatientFilterId={schedulePatientId}
              setSelectedPatientFilterId={setSchedulePatientId}
              onNotify={showToast}
            />
          </div>

          <div className={activeTab === "pharmacies" ? "" : "hidden"}>
            <Pharmacies
              farmacias={farmacias}
              medicamentos={medicamentos}
              cupons={cupons}
              onAddFarmacia={handleAddFarmacia}
              onUpdateFarmacia={handleUpdateFarmacia}
              onDeleteFarmacia={handleDeleteFarmacia}
              onAddCupom={handleAddCupom}
              onDeleteCupom={handleDeleteCupom}
              scanBlock={getScanBlockReason(activeUser, "receipt")}
              onBlockedScanAttempt={() => handleBlockedScanAttempt("receipt")}
            />
          </div>

          <div className={activeTab === "receitas" ? "" : "hidden"}>
            <Appointments
              medicados={medicados}
              receitas={receitas}
              medicamentos={medicamentos}
              onAddReceita={handleAddReceita}
              onDeleteReceita={handleDeleteReceita}
              scanBlock={getScanBlockReason(activeUser, "prescription")}
              onBlockedScanAttempt={() => handleBlockedScanAttempt("prescription")}
            />
          </div>

          {/* Profile Tab */}
          {activeTab === "profile" && (
            <div className="pb-32 px-4 max-w-md lg:max-w-none mx-auto lg:mx-0 pt-6 lg:pt-0 lg:px-0 animate-fade-in space-y-6">
              {/* User Identity Header Card */}
              <div className="bg-brand-teal text-brand-cream rounded-3xl p-6 shadow-md text-center relative overflow-hidden">
                {/* Profile Image Container */}
                <div className="relative w-24 h-24 mx-auto mb-4 group">
                  {activeUser?.avatarUrl ? (
                    <img
                      src={activeUser.avatarUrl}
                      alt={activeUser.name}
                      referrerPolicy="no-referrer"
                      loading="lazy"
                      className="w-full h-full object-cover rounded-full border-2 border-brand-coral shadow-inner"
                    />
                  ) : (
                    <div className="w-full h-full bg-brand-teal-light text-brand-cream rounded-full flex items-center justify-center border-2 border-brand-coral/35">
                      <UserIcon className="w-10 h-10" />
                    </div>
                  )}
                  
                  {/* Invisible file input */}
                  <input
                    type="file"
                    id="profile-upload-input"
                    accept="image/*"
                    onChange={handlePhotoUpload}
                    className="hidden"
                  />
                </div>

                <h3 className="text-lg font-display font-bold text-brand-cream leading-tight">
                  {activeUser?.name}
                </h3>
                <p className="text-xs text-brand-cream/80 font-sans mt-0.5">{activeUser?.email}</p>
                
                <div className="flex items-center justify-center gap-2 mt-3">
                  <span className="text-[10px] font-bold px-2.5 py-1 bg-brand-teal-light text-brand-cream rounded-full uppercase tracking-wider">
                    Perfil: {activeUser?.role}
                  </span>
                  <span className="text-[10px] font-bold px-2.5 py-1 bg-brand-peach text-brand-coral rounded-full uppercase tracking-wider">
                    {activeUser?.status === "active" ? "Ativo" : activeUser?.status}
                  </span>
                </div>

                {/* Photo Actions Row */}
                <div className="mt-5 flex gap-2 justify-center">
                  <button
                    onClick={() => {
                      document.getElementById("profile-upload-input")?.click();
                    }}
                    className="flex items-center gap-1 px-3 py-1.5 bg-brand-cream hover:bg-brand-peach border border-brand-cream-darker text-brand-teal text-xs font-bold rounded-xl transition-all shadow-sm active:scale-95"
                  >
                    <Upload className="w-3.5 h-3.5" />
                    Carregar Foto
                  </button>
                  <button
                    onClick={() => setIsCameraActive(!isCameraActive)}
                    className={`flex items-center gap-1 px-3 py-1.5 border text-xs font-bold rounded-xl transition-all shadow-sm active:scale-95 ${
                      isCameraActive 
                        ? "bg-brand-coral text-white border-brand-coral" 
                        : "bg-brand-cream hover:bg-brand-peach border-brand-cream-darker text-brand-teal"
                    }`}
                  >
                    <Camera className="w-3.5 h-3.5" />
                    {isCameraActive ? "Desativar Câmera" : "Tirar Foto"}
                  </button>
                </div>

                {/* Webcam Live Capture Area */}
                {isCameraActive && (
                  <div className="mt-4 p-4 bg-brand-teal-light border border-brand-cream/15 rounded-2xl animate-fade-in text-center">
                    <p className="text-[11px] font-bold text-brand-cream uppercase tracking-wide mb-2">Câmera Ativa</p>
                    <div className="relative w-48 h-48 mx-auto overflow-hidden rounded-full border-4 border-brand-coral/50 shadow-md mb-3 bg-black">
                      <video
                        ref={profileVideoRef}
                        autoPlay
                        playsInline
                        muted
                        className="w-full h-full object-cover scale-x-[-1]"
                      />
                    </div>
                    <div className="flex justify-center gap-2">
                      <button
                        onClick={handleCapturePhoto}
                        className="px-4 py-2 bg-brand-coral text-white hover:bg-brand-coral-dark text-xs font-bold rounded-xl transition-all shadow-sm"
                      >
                        Capturar Foto
                      </button>
                      <button
                        onClick={() => setIsCameraActive(false)}
                        className="px-4 py-2 bg-brand-teal text-brand-cream hover:bg-brand-teal-light text-xs font-bold rounded-xl transition-all border border-brand-cream/20"
                      >
                        Cancelar
                      </button>
                    </div>
                  </div>
                )}

                <div className="border-t border-brand-cream/15 mt-5 pt-4">
                  <button
                    id="btn-logout"
                    onClick={handleLogout}
                    className="flex items-center justify-center gap-2 mx-auto px-4 py-2 bg-brand-peach hover:bg-brand-peach/90 active:scale-95 text-brand-coral rounded-xl text-xs font-bold transition-all shadow-sm"
                  >
                    <LogOut className="w-4 h-4" />
                    Sair da Conta
                  </button>
                </div>
              </div>

              {/* Account Settings / Password Edit Card */}
              <div className="bg-white border border-brand-cream-darker rounded-3xl p-5 shadow-xs transition-all">
                {!isChangingPassword ? (
                  <button
                    onClick={() => setIsChangingPassword(true)}
                    className="w-full flex items-center justify-between text-left group"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 bg-brand-peach text-brand-coral rounded-xl flex items-center justify-center transition-all group-hover:scale-105">
                        <Key className="w-5 h-5" />
                      </div>
                      <div>
                        <h4 className="text-xs font-bold text-brand-teal uppercase tracking-wider">
                          Alterar Senha de Acesso
                        </h4>
                        <p className="text-[11px] text-ink-soft font-sans mt-0.5">
                          Proteja sua conta atualizando suas credenciais
                        </p>
                      </div>
                    </div>
                    <span className="text-[10px] font-bold text-brand-teal/40 group-hover:text-brand-teal transition-all bg-brand-cream px-2.5 py-1 rounded-lg">
                      Editar
                    </span>
                  </button>
                ) : (
                  <div className="space-y-4 animate-fade-in">
                    <div className="flex items-center justify-between border-b border-brand-cream-darker pb-2">
                      <h4 className="text-xs font-bold text-brand-teal uppercase tracking-wider flex items-center gap-1.5">
                        <Key className="w-4 h-4 text-brand-coral" /> Configurações de Acesso
                      </h4>
                      <button
                        onClick={() => {
                          setIsChangingPassword(false);
                          setShowPassword(false);
                          setProfilePassword("");
                        }}
                        className="text-[10px] font-bold text-ink-soft hover:text-brand-teal transition-all"
                      >
                        Cancelar
                      </button>
                    </div>

                    <div className="space-y-3">
                      <div>
                        <label htmlFor="profile-new-password" className="text-[10px] font-bold text-ink-soft uppercase tracking-wide block mb-1">
                          Nova Senha de Acesso
                        </label>
                        <div className="relative">
                          <input
                            id="profile-new-password"
                            type={showPassword ? "text" : "password"}
                            value={profilePassword}
                            onChange={(e) => setProfilePassword(e.target.value)}
                            placeholder="Insira sua nova senha"
                            className="w-full bg-brand-cream border border-brand-cream-darker rounded-xl px-3.5 py-2.5 text-xs font-medium text-brand-teal outline-none focus:outline focus:outline-2 focus:outline-offset-1 focus:outline-brand-coral focus:border-brand-teal focus:ring-1 focus:ring-brand-teal/15 transition-all pr-10"
                          />
                          <button
                            type="button"
                            onClick={() => setShowPassword(!showPassword)}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-brand-teal/50 hover:text-brand-teal transition-all"
                          >
                            {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                          </button>
                        </div>
                      </div>

                      <button
                        onClick={() => {
                          handleSavePassword();
                          setIsChangingPassword(false);
                          setShowPassword(false);
                        }}
                        className="w-full flex items-center justify-center gap-1.5 px-4 py-2.5 bg-brand-teal hover:bg-brand-teal-light text-brand-cream rounded-xl text-xs font-bold transition-all shadow-sm active:scale-95"
                      >
                        <Save className="w-4 h-4 text-brand-coral" />
                        Salvar Nova Senha
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Privacy / LGPD Card */}
              <div className="bg-white border border-brand-cream-darker rounded-3xl p-5 shadow-xs transition-all">
                <button
                  onClick={() => setShowPrivacyPage(true)}
                  className="w-full flex items-center justify-between text-left group"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-brand-peach text-brand-coral rounded-xl flex items-center justify-center transition-all group-hover:scale-105">
                      <Shield className="w-5 h-5" />
                    </div>
                    <div>
                      <h4 className="text-xs font-bold text-brand-teal uppercase tracking-wider">
                        Privacidade e Proteção de Dados (LGPD)
                      </h4>
                      <p className="text-[11px] text-ink-soft font-sans mt-0.5">
                        Veja como seus dados são coletados e usados
                      </p>
                    </div>
                  </div>
                  <span className="text-[10px] font-bold text-brand-teal/40 group-hover:text-brand-teal transition-all bg-brand-cream px-2.5 py-1 rounded-lg">
                    Ver
                  </span>
                </button>
              </div>

              {/* Suporte e Feedback */}
              <div className="bg-white border border-brand-cream-darker rounded-3xl p-5 shadow-xs transition-all">
                <button
                  onClick={() => setShowSupportModal(true)}
                  className="w-full flex items-center justify-between text-left group"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-brand-peach text-brand-coral rounded-xl flex items-center justify-center transition-all group-hover:scale-105">
                      <HelpCircle className="w-5 h-5" />
                    </div>
                    <div>
                      <h4 className="text-xs font-bold text-brand-teal uppercase tracking-wider">
                        Suporte e Feedback
                      </h4>
                      <p className="text-[11px] text-ink-soft font-sans mt-0.5">
                        Reporte um problema ou envie sua sugestão
                      </p>
                    </div>
                  </div>
                  <span className="text-[10px] font-bold text-brand-teal/40 group-hover:text-brand-teal transition-all bg-brand-cream px-2.5 py-1 rounded-lg">
                    Enviar
                  </span>
                </button>
              </div>

              {/* Compartilhamento entre cuidadores */}
              <SharingScreen
                myUid={activeUser.userId}
                medicados={medicados}
                sharesAsOwner={sharesAsOwner}
                sharesAsGrantee={sharesAsGrantee}
                onInvite={handleInviteShare}
                onRevoke={handleRevokeShare}
                onAccept={handleAcceptShare}
              />

              {/* Subscription & Trial Information Card */}
              <div className="bg-white border border-brand-cream-darker rounded-3xl p-5 shadow-xs space-y-4">
                <div className="flex items-center justify-between border-b border-brand-cream-darker pb-2">
                  <h4 className="text-xs font-bold text-brand-teal uppercase tracking-wider flex items-center gap-1.5">
                    <CreditCard className="w-4 h-4 text-brand-coral" /> Status da Assinatura
                  </h4>
                  <span className="text-[10px] font-mono text-ink-soft">Hora Certa Premium</span>
                </div>

                <div className="space-y-3">
                  {/* Free Trial Status — a paid subscription (active or in its
                      grace period) takes precedence over the trial: freeTrialUntil
                      is set once at signup and never cleared, so once someone
                      subscribes it stays in the future and, left unchecked here,
                      keeps advertising "days of free trial left" even though
                      access is now governed by the subscription, not the trial. */}
                  <div className="flex items-start gap-3">
                    {(() => {
                      const state = getAccessState(activeUser);
                      const subscriptionCovers = state === "active" || state === "grace";
                      return (
                        <div className={`w-8 h-8 rounded-lg border flex items-center justify-center shrink-0 ${
                          subscriptionCovers ? "bg-success-50 border-success-100" : "bg-orange-50 border-orange-100"
                        }`}>
                          <Gift className={`w-4 h-4 ${subscriptionCovers ? "text-success-600" : "text-orange-600"}`} />
                        </div>
                      );
                    })()}
                    <div>
                      <h5 className="text-[11px] font-bold text-brand-teal uppercase tracking-wide">Período de Gratuidade</h5>
                      <p className="text-[11px] text-ink-soft mt-0.5">
                        {(() => {
                          const state = getAccessState(activeUser);
                          if (state === "active" || state === "grace") {
                            return (
                              <span className="text-success-600 font-semibold">
                                Sua assinatura já está ativa — o período de gratuidade não é mais necessário.
                              </span>
                            );
                          }
                          if (!activeUser?.freeTrialUntil) {
                            return <span>Sem benefícios de gratuidade ativos no momento.</span>;
                          }
                          const expiry = new Date(activeUser.freeTrialUntil);
                          const diff = daysRemaining(activeUser.freeTrialUntil);
                          if (diff > 0) {
                            return (
                              <span>
                                Você tem <strong className="text-success-600 font-bold">{diff} {diff === 1 ? "dia" : "dias"}</strong> de teste gratuito restantes (até {expiry.toLocaleDateString("pt-BR")}).
                              </span>
                            );
                          }
                          return (
                            <span className="text-error-500 font-semibold">
                              Seu período de gratuidade expirou em {expiry.toLocaleDateString("pt-BR")}.
                            </span>
                          );
                        })()}
                      </p>
                    </div>
                  </div>

                  {/* Pro Subscription Plan */}
                  <div className="flex items-start gap-3">
                    <div className="w-8 h-8 rounded-lg bg-teal-50 border border-teal-100 flex items-center justify-center shrink-0">
                      <CreditCard className="w-4 h-4 text-brand-teal" />
                    </div>
                    <div>
                      <h5 className="text-[11px] font-bold text-brand-teal uppercase tracking-wide">Plano Contratado</h5>
                      <div className="text-[11px] text-ink-soft mt-0.5 flex flex-col">
                        <span>
                          Status: <strong className={activeUser?.subscriptionStatus === "active" ? "text-success-600 font-bold" : "text-ink-soft"}>
                            {activeUser?.subscriptionStatus === "active" ? "Assinatura Ativa" : "Nenhuma assinatura ativa"}
                          </strong>
                        </span>
                        {activeUser?.subscriptionStatus === "active" && (
                          <span className="text-[10px] text-ink-soft">
                            Plano: <span className="capitalize text-brand-teal font-semibold">{activeUser.subscriptionPlan === "monthly" ? "Mensal" : "Anual"}</span>
                          </span>
                        )}
                        {activeUser?.subscriptionCurrentPeriodEnd && getAccessState(activeUser) !== "blocked" && getAccessState(activeUser) !== "trial" && (
                          <span className="text-[10px] text-ink-soft">
                            Válida até {new Date(activeUser.subscriptionCurrentPeriodEnd).toLocaleDateString("pt-BR")}
                            {daysRemaining(activeUser.subscriptionCurrentPeriodEnd) > 0 && ` (${daysRemaining(activeUser.subscriptionCurrentPeriodEnd)} dias)`}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Subscribe / Renew CTA — reflects the live access state */}
                {(() => {
                  const st = getAccessState(activeUser);
                  const label = st === "active"
                    ? "Renovar assinatura antecipadamente"
                    : st === "blocked"
                    ? "Reativar assinatura"
                    : st === "grace"
                    ? "Renovar assinatura agora"
                    : "Assinar Hora Certa Premium";
                  return (
                    <button
                      onClick={() => setShowSubscription(true)}
                      className={`w-full flex items-center justify-center gap-2 font-display font-semibold text-xs py-3 rounded-xl transition-all active:scale-98 shadow-sm ${
                        st === "active"
                          ? "bg-white border border-brand-teal text-brand-teal hover:bg-brand-peach"
                          : "bg-brand-coral hover:bg-brand-coral-light text-brand-cream"
                      }`}
                    >
                      {st === "blocked" ? <Lock className="w-4 h-4" /> : <Sparkles className="w-4 h-4" />}
                      {label}
                    </button>
                  );
                })()}
              </div>

              {/* PWA & Background Alerts Card */}
              <div className="bg-white border border-brand-cream-darker rounded-3xl p-5 shadow-xs space-y-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-brand-peach text-brand-coral rounded-xl flex items-center justify-center">
                    <Smartphone className="w-5 h-5 text-brand-coral" />
                  </div>
                  <div>
                    <h4 className="text-xs font-bold text-brand-teal uppercase tracking-wider">
                      Instalação & Alertas do Celular (PWA)
                    </h4>
                    <p className="text-[11px] text-ink-soft font-sans mt-0.5">
                      Receba avisos de medicamentos mesmo com o aplicativo fechado
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2 pt-1">
                  {/* PWA Installation Button */}
                  <button
                    onClick={installPWAApp}
                    className={`flex flex-col items-center justify-center p-3 rounded-2xl border text-center transition-all active:scale-95 group ${
                      isPWAInstalled
                        ? "bg-brand-teal-pale/50 border-brand-teal/10 text-brand-teal/80"
                        : "bg-white border-brand-cream-darker hover:bg-brand-peach text-brand-teal"
                    }`}
                  >
                    <Download className={`w-5 h-5 mb-1.5 transition-transform group-hover:scale-110 ${isPWAInstalled ? "text-brand-teal/60" : "text-brand-coral"}`} />
                    <span className="text-[10px] font-bold uppercase tracking-wider">Instalar no Celular</span>
                    <span className="text-[9px] text-ink-soft font-sans mt-0.5">
                      {isPWAInstalled ? "Já Instalado" : "Adicionar à Tela Inicial"}
                    </span>
                  </button>

                  {/* Notification Status / Toggle Button */}
                  <button
                    onClick={requestNotificationPermission}
                    className={`flex flex-col items-center justify-center p-3 rounded-2xl border text-center transition-all active:scale-95 group ${
                      notificationPermission === "granted"
                        ? "bg-brand-teal-pale/50 border-brand-teal/10 text-brand-teal/80"
                        : "bg-white border-brand-cream-darker hover:bg-brand-peach text-brand-teal"
                    }`}
                  >
                    <Bell className={`w-5 h-5 mb-1.5 transition-transform group-hover:scale-110 ${notificationPermission === "granted" ? "text-brand-teal/60" : "text-brand-coral animate-pulse"}`} />
                    <span className="text-[10px] font-bold uppercase tracking-wider">Permitir Alertas</span>
                    <span className="text-[9px] text-ink-soft font-sans mt-0.5 capitalize">
                      Status: {
                        notificationPermission !== "granted"
                          ? (notificationPermission === "denied" ? "Bloqueado" : "Ativar")
                          // Permission granted is only half the story — without a real
                          // push subscription the reminder won't survive the app closing.
                          : (pushRegistered ? "Ativo" : "Só com app aberto")
                      }
                    </span>
                  </button>
                </div>

                {/* Proactive iOS guidance — shown BEFORE the user hits the confusing
                    "permission granted, still doesn't work" state, since the OS
                    permission dialog appears normally even outside standalone mode. */}
                {isIOSDevice() && !isPWAInstalled && (
                  <div className="bg-warning-50 border border-warning-200/60 rounded-2xl p-3 flex items-start gap-2 animate-fade-in">
                    <AlertCircle className="w-4 h-4 text-warning-600 shrink-0 mt-0.5" />
                    <p className="text-[10px] text-warning-900 font-sans leading-relaxed">
                      <strong className="font-bold">No iPhone, instale o app primeiro:</strong> toque em "Instalar no Celular" acima (Compartilhar {"→"} Adicionar à Tela de Início) e abra pelo ícone criado — só assim os lembretes chegam com a tela bloqueada.
                    </p>
                  </div>
                )}

                {notificationPermission === "granted" && !pushRegistered && !(isIOSDevice() && !isPWAInstalled) && (
                  <div className="bg-warning-50 border border-warning-200/60 rounded-2xl p-3 flex items-start gap-2 animate-fade-in">
                    <AlertCircle className="w-4 h-4 text-warning-600 shrink-0 mt-0.5" />
                    <p className="text-[10px] text-warning-900 font-sans leading-relaxed">
                      Alertas permitidos neste navegador, mas os lembretes só chegam com o app aberto — a inscrição para funcionar com o app fechado ainda não foi concluída. Toque em "Permitir Alertas" novamente.
                    </p>
                  </div>
                )}

                {notificationPermission === "granted" && (
                  <div className="bg-brand-peach/50 border border-brand-coral/10 rounded-2xl p-3 flex items-center justify-between gap-3 animate-fade-in">
                    <div className="min-w-0 flex-1">
                      <p className="text-[10px] font-bold text-brand-teal uppercase tracking-wider">
                        Testar Notificações Externas
                      </p>
                      <p className="text-[9px] text-ink-soft font-sans mt-0.5 leading-tight">
                        Clique ao lado para receber um alerta teste em 3 segundos. Minimize ou trave a tela para ver!
                      </p>
                    </div>
                    <button
                      onClick={triggerTestNotification}
                      className="px-3 py-2 bg-brand-coral hover:bg-brand-coral-light text-brand-cream text-[10px] font-bold uppercase rounded-xl shadow-xs transition-colors shrink-0"
                    >
                      Testar
                    </button>
                  </div>
                )}

                <div className="bg-brand-cream/60 border border-dashed border-brand-cream-darker rounded-2xl p-3">
                  <p className="text-[9px] text-ink-soft font-sans leading-tight">
                    💡 <strong>Como funciona:</strong> Ao instalar a PWA e conceder permissão de Alertas, o dispositivo rodará o Service Worker em segundo plano. O sistema avisa o horário correto de ministrar o medicamento mesmo se o celular estiver em standby ou você estiver em outro aplicativo!
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Persistent Elegant Bottom Navigation */}
      {activeUser && (
        <BottomNavBar
          activeTab={activeTab}
          setActiveTab={setActiveTab}
        />
      )}
    </div>
  );

  return appShell;
}
