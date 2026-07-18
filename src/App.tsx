import React, { useState, useEffect, useCallback } from "react";
import { dbLocal } from "./dbLocalFallback";
import { auth, dbFirebase } from "./firebase";
import { subscribeToPush, unsubscribeFromPush } from "./push";
import { isScanAllowed, getAccessState, daysRemaining } from "./subscription";
import { dueDoseMs } from "./utils/doseSchedule";
import { processImageFile } from "./imageUtils";
import { reportLogin } from "./loginLog";
import { signInWithEmailAndPassword, signOut as firebaseSignOut, updatePassword, User as FirebaseUser } from "firebase/auth";
import { User, Medicado, Receita, Medicamento, DoseLog, Consulta, Farmacia, MedicineCategory, CupomFiscal } from "./types";
import BottomNavBar from "./components/BottomNavBar";
import Dashboard from "./components/Dashboard";
import Schedule from "./components/Schedule";
import AdminPanel from "./components/AdminPanel";
import AdminLogs from "./components/AdminLogs";
import Appointments from "./components/Appointments";
import Pharmacies from "./components/Pharmacies";
import AuthScreen from "./components/AuthScreen";
import PrivacyPolicy from "./components/PrivacyPolicy";
import SubscriptionScreen from "./components/SubscriptionScreen";
import { useIsDesktop } from "./hooks/useIsDesktop";
import { Shield, Sparkles, Heart, HelpCircle, LogOut, ShieldAlert, CheckCircle2, User as UserIcon, Camera, Key, Upload, Eye, EyeOff, Save, Smartphone, Bell, Download, Gift, CreditCard, Lock, Mail, ArrowRight } from "lucide-react";

// Set by the CTAs on the static landing page (root index.html) right before
// navigating to /app, so a desktop user who explicitly chose to enter the
// app isn't bounced straight back to the landing page below.
const DESKTOP_ENTER_FLAG = "horacerta_desktop_enter";

export default function App() {
  const isDesktop = useIsDesktop();
  // Read once: the landing page CTA sets this flag right before a full page
  // navigation to /app, so there is no in-app moment where it needs to change.
  const desktopEntered = typeof window !== "undefined" && sessionStorage.getItem(DESKTOP_ENTER_FLAG) === "1";
  // 1. Authentication State
  const [activeUser, setActiveUser] = useState<User | null>(null);
  const [activeAdminUser, setActiveAdminUser] = useState<User | null>(null);
  const [adminSection, setAdminSection] = useState<"users" | "logs">("users");

  // 2. Global Database States
  const [users, setUsers] = useState<User[]>([]);
  const [medicados, setMedicados] = useState<Medicado[]>([]);
  const [receitas, setReceitas] = useState<Receita[]>([]);
  const [medicamentos, setMedicamentos] = useState<Medicamento[]>([]);
  const [doseLogs, setDoseLogs] = useState<DoseLog[]>([]);
  const [consultas, setConsultas] = useState<Consulta[]>([]);
  const [farmacias, setFarmacias] = useState<Farmacia[]>([]);
  const [cupons, setCupons] = useState<CupomFiscal[]>([]);

  // 3. Navigation State
  const [activeTab, setActiveTab] = useState<string>("home");
  const [successToast, setSuccessToast] = useState<string | null>(null);
  const [scheduleDate, setScheduleDate] = useState<Date>(new Date());
  const [schedulePatientId, setSchedulePatientId] = useState<string>("");
  const [showPrivacyPage, setShowPrivacyPage] = useState(false);
  const [showSubscription, setShowSubscription] = useState(false);

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
  const [isPWAInstalled, setIsPWAInstalled] = useState(false);
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null);

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

  // Sync data whenever active user shifts (isolated queries per tenant)
  useEffect(() => {
    if (!activeUser) return;
    
    const loadFromCache = () => {
      setMedicados(dbLocal.getMedicados(activeUser.userId));
      setReceitas(dbLocal.getReceitas(activeUser.userId));
      setMedicamentos(dbLocal.getMedicamentos(activeUser.userId));
      setDoseLogs(dbLocal.getDoseLogs(activeUser.userId));
      setConsultas(dbLocal.getConsultas(activeUser.userId));
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
      }
    });
  }, [activeUser]);

  // Reconcile subscription/trial state with the server. Grants the 7-day trial
  // to legacy users (server-side, since the client can't write freeTrialUntil)
  // and pulls any status set by the payment webhook. Updates `activeUser` in
  // place only when something actually changed, so it can't loop.
  const syncSubscription = useCallback(async () => {
    const current = auth.currentUser;
    if (!current) return;
    try {
      const token = await current.getIdToken();
      const res = await fetch("/api/subscription/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const data = await res.json();
      setActiveUser((prev) => {
        if (!prev) return prev;
        const next: User = {
          ...prev,
          freeTrialUntil: data.freeTrialUntil ?? prev.freeTrialUntil,
          subscriptionStatus: data.subscriptionStatus ?? prev.subscriptionStatus,
          subscriptionPlan: data.subscriptionPlan ?? prev.subscriptionPlan,
          subscriptionCurrentPeriodEnd: data.subscriptionCurrentPeriodEnd ?? prev.subscriptionCurrentPeriodEnd,
        };
        if (JSON.stringify(next) === JSON.stringify(prev)) return prev;
        dbLocal.setUserCache(next);
        return next;
      });
    } catch {
      /* rede offline — o app segue com o estado em cache */
    }
  }, []);

  // Sync subscription on login/user change.
  useEffect(() => {
    if (!activeUser) return;
    syncSubscription();
  }, [activeUser?.userId, syncSubscription]);

  // Returning from the card Checkout Pro (MP redirects to /app?sub=...): refresh
  // the subscription and clean the query string so it doesn't re-trigger.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const sub = params.get("sub");
    if (!sub) return;
    syncSubscription().then(() => {
      if (sub === "success") showToast("Pagamento recebido! Verificando sua assinatura...");
    });
    params.delete("sub");
    const clean = window.location.pathname + (params.toString() ? `?${params}` : "") + window.location.hash;
    window.history.replaceState({}, "", clean);
  }, [syncSubscription]);

  // ==========================================
  // PWA & Background Notification Services
  // ==========================================
  
  // Service Worker Registration and PWA Install Prompt handling
  useEffect(() => {
    if (typeof window !== "undefined") {
      if ("Notification" in window) {
        setNotificationPermission(Notification.permission);
      }

      const isStandalone = window.matchMedia("(display-mode: standalone)").matches || (window.navigator as any).standalone === true;
      setIsPWAInstalled(isStandalone);

      if ("serviceWorker" in navigator) {
        navigator.serviceWorker.register("/sw.js")
          .then((reg) => {
            console.log("Service Worker registrado com sucesso:", reg.scope);
          })
          .catch((err) => {
            console.error("Falha ao registrar Service Worker:", err);
          });
      }

      const handleBeforeInstallPrompt = (e: Event) => {
        e.preventDefault();
        setDeferredPrompt(e);
      };

      window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);

      return () => {
        window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      };
    }
  }, []);

  // Register this browser for server-sent (VAPID) push once a user is signed in
  // and has granted notification permission — this is what delivers dose
  // reminders when the app is fully closed. Isolation is enforced server-side:
  // the subscription is stored under the authenticated uid from the ID token.
  useEffect(() => {
    if (!activeUser || notificationPermission !== "granted") return;
    subscribeToPush(() => auth.currentUser?.getIdToken() ?? Promise.resolve(undefined));
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
        subscribeToPush(() => auth.currentUser?.getIdToken() ?? Promise.resolve(undefined));
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

  const installPWAApp = async () => {
    if (!deferredPrompt) {
      showToast("Dica: No iOS (Safari), toque em 'Compartilhar' > 'Adicionar à Tela de Início'.");
      return;
    }

    try {
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === "accepted") {
        setIsPWAInstalled(true);
        showToast("HoraCerta AI instalado com sucesso!");
      }
      setDeferredPrompt(null);
    } catch (err) {
      console.error("PWA install error:", err);
    }
  };

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
    actor?: User | null
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
        entityLabel,
        page,
      })
      .catch((e) => console.warn("Falha ao registrar log de ação:", e));
  };

  // ==========================================
  // PATIENTS (MEDICADOS) CRUD HANDLERS
  // ==========================================
  const handleAddPatient = (patientData: Omit<Medicado, "medicadoId" | "createdAt" | "userId">) => {
    if (!activeUser) return;
    const newPatient: Medicado = {
      ...patientData,
      medicadoId: `pat_${Date.now()}`,
      userId: activeUser.userId,
      createdAt: new Date().toISOString(),
    };
    dbLocal.addMedicado(newPatient);
    setMedicados(dbLocal.getMedicados(activeUser.userId));
    showToast(`Paciente ${newPatient.name} cadastrado com sucesso!`);
  };

  const handleUpdatePatient = (updatedPatient: Medicado) => {
    if (!activeUser) return;
    dbLocal.updateMedicado(updatedPatient);
    setMedicados(dbLocal.getMedicados(activeUser.userId));
    logAction("update", "Medicado", updatedPatient.medicadoId, updatedPatient.name, "Pacientes");
    showToast(`Dados de ${updatedPatient.name} atualizados!`);
  };

  const handleDeletePatient = (patientId: string) => {
    if (!activeUser) return;
    const patient = medicados.find((m) => m.medicadoId === patientId);
    dbLocal.deleteMedicado(patientId);
    setMedicados(dbLocal.getMedicados(activeUser.userId));
    logAction("delete", "Medicado", patientId, patient?.name ?? patientId, "Pacientes");
    showToast("Paciente removido com sucesso.");
  };

  // ==========================================
  // MEDICINES (MEDICAMENTOS) CRUD HANDLERS
  // ==========================================
  const handleAddMedicine = (medData: Omit<Medicamento, "medicamentoId" | "createdAt" | "userId"> & { createdAt?: string }) => {
    if (!activeUser) return;
    const newMed: Medicamento = {
      ...medData,
      medicamentoId: `med_${Date.now()}`,
      userId: activeUser.userId,
      createdAt: medData.createdAt || new Date().toISOString(),
    };
    dbLocal.addMedicamento(newMed);
    setMedicamentos(dbLocal.getMedicamentos(activeUser.userId));
    showToast(`Medicamento ${newMed.name} agendado!`);
  };

  const handleUpdateMedicine = (updatedMed: Medicamento) => {
    if (!activeUser) return;
    dbLocal.updateMedicamento(updatedMed);
    setMedicamentos(dbLocal.getMedicamentos(activeUser.userId));
    logAction("update", "Medicamento", updatedMed.medicamentoId, updatedMed.name, "Medicamentos");
  };

  const handleDeleteMedicine = (medId: string) => {
    if (!activeUser) return;
    const med = medicamentos.find((m) => m.medicamentoId === medId);
    dbLocal.deleteMedicamento(medId);
    setMedicamentos(dbLocal.getMedicamentos(activeUser.userId));
    logAction("delete", "Medicamento", medId, med?.name ?? medId, "Medicamentos");
    showToast("Medicamento removido da programação.");
  };

  // ==========================================
  // DOSE LOGS HANDLERS
  // ==========================================
  const handleAddDoseLog = (log: Omit<DoseLog, "userId">) => {
    if (!activeUser) return;
    dbLocal.addDoseLog({ ...log, userId: activeUser.userId });
    setDoseLogs(dbLocal.getDoseLogs(activeUser.userId));
    showToast("Medicamento marcado como TOMADO! Saúde garantida.");
  };

  // ==========================================
  // APPOINTMENTS (CONSULTAS) CRUD HANDLERS
  // ==========================================
  const handleAddAppointment = (apptData: Omit<Consulta, "consultaId" | "createdAt">) => {
    if (!activeUser) return;
    const newAppt: Consulta = {
      ...apptData,
      consultaId: `appt_${Date.now()}`,
      createdAt: new Date().toISOString(),
    };
    dbLocal.addConsulta(newAppt);
    setConsultas(dbLocal.getConsultas(activeUser.userId));
    showToast(`Consulta agendada com ${newAppt.doctorName}.`);
  };

  const handleUpdateAppointment = (updatedAppt: Consulta) => {
    if (!activeUser) return;
    dbLocal.updateConsulta(updatedAppt);
    setConsultas(dbLocal.getConsultas(activeUser.userId));
    logAction("update", "Consulta", updatedAppt.consultaId, `${updatedAppt.doctorName} - ${updatedAppt.dateTime}`, "Agenda");
    showToast("Consulta atualizada.");
  };

  const handleDeleteAppointment = (apptId: string) => {
    if (!activeUser) return;
    const appt = consultas.find((c) => c.consultaId === apptId);
    dbLocal.deleteConsulta(apptId);
    setConsultas(dbLocal.getConsultas(activeUser.userId));
    logAction("delete", "Consulta", apptId, appt ? `${appt.doctorName} - ${appt.dateTime}` : apptId, "Agenda");
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
    dbLocal.updateFarmacia(updatedFarm);
    setFarmacias(dbLocal.getFarmacias(activeUser.userId));
    logAction("update", "Farmacia", updatedFarm.farmaciaId, updatedFarm.name, "Farmácias");
  };

  const handleDeleteFarmacia = (farmId: string) => {
    if (!activeUser) return;
    const farm = farmacias.find((f) => f.farmaciaId === farmId);
    dbLocal.deleteFarmacia(farmId);
    setFarmacias(dbLocal.getFarmacias(activeUser.userId));
    logAction("delete", "Farmacia", farmId, farm?.name ?? farmId, "Farmácias");
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
    try {
      await dbFirebase.updateUserProfile(updatedUser);
    } catch (err: any) {
      console.error("Erro ao atualizar usuário no Firestore:", err);
      showToast(`Erro: não foi possível salvar as alterações de ${updatedUser.name} no servidor.`);
      return false;
    }

    dbLocal.setUserCache(updatedUser);
    setUsers(dbLocal.getUsers());
    logAction("update", "User", updatedUser.userId, `${updatedUser.name} (${updatedUser.email})`, "Painel Admin", activeAdminUser ?? activeUser);
    showToast(`Cadastro de ${updatedUser.name} atualizado no diretório.`);

    // If the administrator edited their own status or role, update session
    if (activeUser && activeUser.userId === updatedUser.userId) {
      setActiveUser(updatedUser);
    }
    return true;
  };

  const handleDeleteUser = async (userId: string): Promise<boolean> => {
    const targetUser = users.find((u) => u.userId === userId);
    try {
      await dbFirebase.deleteUserProfile(userId);
    } catch (err: any) {
      console.error("Erro ao remover usuário no Firestore:", err);
      showToast("Erro: permissão negada no servidor ao remover o usuário.");
      return false;
    }

    dbLocal.removeUserCache(userId);
    setUsers(dbLocal.getUsers());
    logAction("delete", "User", userId, targetUser ? `${targetUser.name} (${targetUser.email})` : userId, "Painel Admin", activeAdminUser ?? activeUser);
    showToast("Cadastro de usuário removido com sucesso.");
    return true;
  };

  // Note: unlike update/delete above, admin-created users have no real
  // Firebase Auth account behind them (that requires the Admin SDK on a
  // trusted backend, which is out of scope here) — this stays a local-only
  // demo record, intentionally not wired through the same await/rollback path.
  const handleAddUser = (userData: Omit<User, "createdAt">) => {
    const newUser: User = {
      ...userData,
      createdAt: new Date().toISOString(),
    };
    dbLocal.updateUser(newUser);
    setUsers(dbLocal.getUsers());
    showToast(`Usuário ${newUser.name} registrado pelo administrador.`);
  };

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

    // 1. Register Receipt Record
    const recipeId = `rec_${Date.now()}`;
    const newReceita: Receita = {
      receitaId: recipeId,
      medicadoId,
      userId: activeUser.userId,
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
        userId: activeUser.userId,
        name: med.name,
        dosage: med.dosage,
        intervalHours: med.intervalHours || 12,
        durationDays: med.durationDays || 30,
        instructions: med.instructions || "",
        category: med.category || "pill",
        status: "active",
        reminderOffset: med.reminderOffset ?? 10,
        pricePlaceholder: Math.floor(Math.random() * 40) + 15.90, // Generate low cost pricing
        createdAt: new Date().toISOString(),
      };
      dbLocal.addMedicamento(newMed);
    });

    // Refresh layout queries
    setReceitas(dbLocal.getReceitas(activeUser.userId));
    setMedicamentos(dbLocal.getMedicamentos(activeUser.userId));

    showToast(`Receita de ${doctorName} lida e agendada com sucesso por Inteligência Artificial!`);
  };

  const handleDeleteReceita = (receitaId: string) => {
    if (!activeUser) return;
    const receita = receitas.find((r) => r.receitaId === receitaId);
    dbLocal.deleteReceita(receitaId);
    setReceitas(dbLocal.getReceitas(activeUser.userId));
    setMedicamentos(dbLocal.getMedicamentos(activeUser.userId));
    setDoseLogs(dbLocal.getDoseLogs(activeUser.userId));
    logAction("delete", "Receita", receitaId, receita ? `${receita.doctorName || "Receita"} - ${receita.date}` : receitaId, "Receitas");
    showToast("Receita médica e seus medicamentos associados foram removidos.");
  };

  // Switch between Admin Antonio (full control) and Normal User Maria (tenant isolated)
  const handleSwitchUserSession = (user: User) => {
    if (user.status === "suspended") {
      showToast("Acesso negado: Sua conta está marcada como SUSPENSA pelo Administrador no Painel RBAC.");
      return;
    }
    setActiveUser(user);
    localStorage.setItem("horacerta_active_user_id", user.userId);
    setActiveTab("home");
    showToast(`Sessão alterada: Logado como ${user.name} (${user.role.toUpperCase()})`);
  };

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
    await unsubscribeFromPush(() => auth.currentUser?.getIdToken() ?? Promise.resolve(undefined));
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
    setActiveUser(null);
    localStorage.removeItem("horacerta_active_user_id");
    setActiveTab("home");
    showToast("Sessão encerrada com sucesso!");
  };

  // ==========================================
  // SEPARATE ADMIN PORTAL HANDLERS
  // ==========================================
  const handleAdminLogin = async (email: string, pass: string) => {
    const trimmedEmail = email.trim().toLowerCase();

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

  const handleSimulateUser = (simUser: User) => {
    setActiveUser(simUser);
    localStorage.setItem("horacerta_active_user_id", simUser.userId);
    showToast(`Sessão simulada com sucesso como: ${simUser.name}`);
    
    // Redirect back to user app
    setIsAdminRoute(false);
    window.location.hash = "";
    if (window.location.pathname.startsWith("/app/admin")) {
      window.history.pushState({}, "", "/app");
    }
  };

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
                <p className="text-xs text-gray-400 font-sans mt-1">
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
                  <label className="text-[11px] font-bold text-brand-teal uppercase tracking-wider block">
                    E-mail do Administrador
                  </label>
                  <div className="relative">
                    <span className="absolute inset-y-0 left-0 pl-3.5 flex items-center text-gray-400">
                      <Mail className="w-4 h-4" />
                    </span>
                    <input
                      name="email"
                      type="email"
                      required
                      placeholder="seu.email@exemplo.com"
                      className="w-full bg-brand-cream/40 border border-brand-cream-darker rounded-xl pl-10 pr-4 py-3 text-xs text-brand-teal placeholder-gray-400 font-sans focus:outline-none focus:border-brand-teal/50 transition-all font-medium"
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label className="text-[11px] font-bold text-brand-teal uppercase tracking-wider block">
                    Senha Secreta
                  </label>
                  <div className="relative">
                    <span className="absolute inset-y-0 left-0 pl-3.5 flex items-center text-gray-400">
                      <Lock className="w-4 h-4" />
                    </span>
                    <input
                      name="password"
                      type="password"
                      required
                      placeholder="Senha de acesso admin"
                      className="w-full bg-brand-cream/40 border border-brand-cream-darker rounded-xl pl-10 pr-4 py-3 text-xs text-brand-teal placeholder-gray-400 font-sans focus:outline-none focus:border-brand-teal/50 transition-all font-medium"
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
                  <p className="text-xs text-gray-400">
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
                  className="px-3.5 py-2 bg-red-50 hover:bg-red-100 border border-red-100 text-red-600 text-xs font-bold rounded-xl transition-all shadow-sm active:scale-95"
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
                onClick={() => setAdminSection("logs")}
                className={`flex-1 py-2 rounded-xl text-xs font-bold transition-all ${
                  adminSection === "logs" ? "bg-brand-teal text-white shadow-xs" : "text-brand-teal/70 hover:text-brand-teal"
                }`}
              >
                Logs
              </button>
            </div>

            {adminSection === "users" ? (
              <AdminPanel
                users={users}
                onUpdateUser={handleUpdateUser}
                onDeleteUser={handleDeleteUser}
                onAddUser={handleAddUser}
                onNotify={showToast}
                activeUserId={activeUser?.userId}
                onSimulateUser={handleSimulateUser}
              />
            ) : (
              <AdminLogs />
            )}
          </div>
        )}
      </div>
    );
  }

  const appShell = (
    <div className="min-h-screen bg-brand-cream text-brand-teal relative selection:bg-brand-coral/20 select-none pb-20 lg:pb-8 lg:pl-24 lg:bg-[#FAF6EC]">

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

      {/* Privacy / LGPD full-screen page */}
      {showPrivacyPage && <PrivacyPolicy onBack={() => setShowPrivacyPage(false)} />}

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
        <div className="lg:max-w-[1080px] lg:mx-auto lg:my-8 lg:bg-[#FDFBF5] lg:border lg:border-[#ECE6D8] lg:rounded-[28px] lg:p-8 lg:shadow-[0_2px_10px_rgba(0,0,0,0.03)]">
          {activeTab === "home" && (
            <Dashboard
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
            />
          )}

          {activeTab === "schedule" && (
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
          )}

          {activeTab === "pharmacies" && (
            <Pharmacies
              farmacias={farmacias}
              medicamentos={medicamentos}
              cupons={cupons}
              onAddFarmacia={handleAddFarmacia}
              onUpdateFarmacia={handleUpdateFarmacia}
              onDeleteFarmacia={handleDeleteFarmacia}
              onAddCupom={handleAddCupom}
              onDeleteCupom={handleDeleteCupom}
              canScan={isScanAllowed(activeUser)}
              onSubscribe={() => setShowSubscription(true)}
            />
          )}

          {activeTab === "receitas" && (
            <Appointments
              medicados={medicados}
              receitas={receitas}
              medicamentos={medicamentos}
              onAddReceita={handleAddReceita}
              onDeleteReceita={handleDeleteReceita}
              canScan={isScanAllowed(activeUser)}
              onSubscribe={() => setShowSubscription(true)}
            />
          )}

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
                        <p className="text-[11px] text-gray-400 font-sans mt-0.5">
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
                        className="text-[10px] font-bold text-gray-400 hover:text-gray-600 transition-all"
                      >
                        Cancelar
                      </button>
                    </div>

                    <div className="space-y-3">
                      <div>
                        <label className="text-[10px] font-bold text-gray-400 uppercase tracking-wide block mb-1">
                          Nova Senha de Acesso
                        </label>
                        <div className="relative">
                          <input
                            type={showPassword ? "text" : "password"}
                            value={profilePassword}
                            onChange={(e) => setProfilePassword(e.target.value)}
                            placeholder="Insira sua nova senha"
                            className="w-full bg-brand-cream border border-brand-cream-darker rounded-xl px-3.5 py-2.5 text-xs font-medium text-brand-teal outline-none focus:border-brand-teal focus:ring-1 focus:ring-brand-teal/15 transition-all pr-10"
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
                      <p className="text-[11px] text-gray-400 font-sans mt-0.5">
                        Veja como seus dados são coletados e usados
                      </p>
                    </div>
                  </div>
                  <span className="text-[10px] font-bold text-brand-teal/40 group-hover:text-brand-teal transition-all bg-brand-cream px-2.5 py-1 rounded-lg">
                    Ver
                  </span>
                </button>
              </div>

              {/* Subscription & Trial Information Card */}
              <div className="bg-white border border-brand-cream-darker rounded-3xl p-5 shadow-xs space-y-4">
                <div className="flex items-center justify-between border-b border-brand-cream-darker pb-2">
                  <h4 className="text-xs font-bold text-brand-teal uppercase tracking-wider flex items-center gap-1.5">
                    <CreditCard className="w-4 h-4 text-brand-coral" /> Status da Assinatura
                  </h4>
                  <span className="text-[10px] font-mono text-gray-400">Hora Certa Premium</span>
                </div>

                <div className="space-y-3">
                  {/* Free Trial Status */}
                  <div className="flex items-start gap-3">
                    <div className="w-8 h-8 rounded-lg bg-orange-50 border border-orange-100 flex items-center justify-center shrink-0">
                      <Gift className="w-4 h-4 text-orange-600" />
                    </div>
                    <div>
                      <h5 className="text-[11px] font-bold text-brand-teal uppercase tracking-wide">Período de Gratuidade</h5>
                      <p className="text-[11px] text-gray-500 mt-0.5">
                        {activeUser?.freeTrialUntil ? (
                          (() => {
                            const expiry = new Date(activeUser.freeTrialUntil);
                            const now = new Date();
                            const diff = Math.ceil((expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
                            if (diff > 0) {
                              return (
                                <span>
                                  Você tem <strong className="text-emerald-600 font-bold">{diff} {diff === 1 ? "dia" : "dias"}</strong> de teste gratuito restantes (até {expiry.toLocaleDateString("pt-BR")}).
                                </span>
                              );
                            } else {
                              return (
                                <span className="text-red-500 font-semibold">
                                  Seu período de gratuidade expirou em {expiry.toLocaleDateString("pt-BR")}.
                                </span>
                              );
                            }
                          })()
                        ) : (
                          <span>Sem benefícios de gratuidade ativos no momento.</span>
                        )}
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
                      <div className="text-[11px] text-gray-500 mt-0.5 flex flex-col">
                        <span>
                          Status: <strong className={activeUser?.subscriptionStatus === "active" ? "text-emerald-600 font-bold" : "text-gray-400"}>
                            {activeUser?.subscriptionStatus === "active" ? "Assinatura Ativa" : "Nenhuma assinatura ativa"}
                          </strong>
                        </span>
                        {activeUser?.subscriptionStatus === "active" && (
                          <span className="text-[10px] text-gray-400">
                            Plano: <span className="capitalize text-brand-teal font-semibold">{activeUser.subscriptionPlan === "monthly" ? "Mensal" : "Anual"}</span>
                          </span>
                        )}
                        {activeUser?.subscriptionCurrentPeriodEnd && getAccessState(activeUser) !== "blocked" && getAccessState(activeUser) !== "trial" && (
                          <span className="text-[10px] text-gray-400">
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
                    <p className="text-[11px] text-gray-400 font-sans mt-0.5">
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
                    <span className="text-[9px] text-gray-400 font-sans mt-0.5">
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
                    <span className="text-[9px] text-gray-400 font-sans mt-0.5 capitalize">
                      Status: {notificationPermission === "granted" ? "Ativo" : notificationPermission === "denied" ? "Bloqueado" : "Ativar"}
                    </span>
                  </button>
                </div>

                {notificationPermission === "granted" && (
                  <div className="bg-brand-peach/50 border border-brand-coral/10 rounded-2xl p-3 flex items-center justify-between gap-3 animate-fade-in">
                    <div className="min-w-0 flex-1">
                      <p className="text-[10px] font-bold text-brand-teal uppercase tracking-wider">
                        Testar Notificações Externas
                      </p>
                      <p className="text-[9px] text-gray-500 font-sans mt-0.5 leading-tight">
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
                  <p className="text-[9px] text-gray-400 font-sans leading-tight">
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
