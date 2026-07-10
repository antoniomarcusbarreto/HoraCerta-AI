import React, { useState, useEffect } from "react";
import { dbLocal } from "./dbLocalFallback";
import { User, Medicado, Receita, Medicamento, DoseLog, Consulta, Farmacia, MedicineCategory, CupomFiscal } from "./types";
import BottomNavBar from "./components/BottomNavBar";
import Dashboard from "./components/Dashboard";
import Schedule from "./components/Schedule";
import PrescriptionScanner from "./components/PrescriptionScanner";
import AdminPanel from "./components/AdminPanel";
import Appointments from "./components/Appointments";
import Pharmacies from "./components/Pharmacies";
import AuthScreen from "./components/AuthScreen";
import { Shield, Sparkles, Heart, HelpCircle, LogOut, ShieldAlert, CheckCircle2, User as UserIcon, Camera, Key, Upload, Eye, EyeOff, Save, Smartphone, Bell, Download, Gift, CreditCard, Lock, Mail, ArrowRight } from "lucide-react";

export default function App() {
  // 1. Authentication State
  const [activeUser, setActiveUser] = useState<User | null>(null);
  const [activeAdminUser, setActiveAdminUser] = useState<User | null>(null);
  
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
  const [showScanFlow, setShowScanFlow] = useState(false);
  const [successToast, setSuccessToast] = useState<string | null>(null);
  const [scheduleDate, setScheduleDate] = useState<Date>(new Date());
  const [schedulePatientId, setSchedulePatientId] = useState<string>("");

  // 3.1 Separate Admin Page Route States
  const [isAdminRoute, setIsAdminRoute] = useState(() => {
    return typeof window !== "undefined" && (
      window.location.pathname === "/admin" || 
      window.location.pathname === "/admin/" || 
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

  // Listen for navigation / hash changes to toggle separate Admin Page mode
  useEffect(() => {
    const handleLocationChange = () => {
      setIsAdminRoute(
        window.location.pathname === "/admin" || 
        window.location.pathname === "/admin/" || 
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

  // Background check for scheduled medicine doses
  useEffect(() => {
    if (!activeUser || medicamentos.length === 0) return;

    // Helper to get dose times for a medicine on a given date
    const getDoseTimesForMedOnDate = (med: Medicamento, targetDate: Date): string[] => {
      const times: string[] = [];
      const createdAt = new Date(med.createdAt || new Date().toISOString());
      const intervalHours = med.intervalHours || 8;
      const durationDays = med.durationDays || 7;
      
      const durationMs = durationDays * 24 * 60 * 60 * 1000;
      const startMs = createdAt.getTime();
      const endMs = startMs + durationMs;

      const targetYear = targetDate.getFullYear();
      const targetMonth = targetDate.getMonth();
      const targetDay = targetDate.getDate();

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

    const checkDosesAndNotify = () => {
      const now = new Date();
      const currentHr = String(now.getHours()).padStart(2, "0");
      const currentMin = String(now.getMinutes()).padStart(2, "0");
      const currentTimeStr = `${currentHr}:${currentMin}`;

      const yyyy = now.getFullYear();
      const mm = String(now.getMonth() + 1).padStart(2, "0");
      const dd = String(now.getDate()).padStart(2, "0");
      const todayISOStr = `${yyyy}-${mm}-${dd}`;

      medicamentos.forEach((med) => {
        if (med.status !== "active") return;
        const times = getDoseTimesForMedOnDate(med, now);
        
        times.forEach((slotTime) => {
          if (slotTime === currentTimeStr) {
            const isTaken = doseLogs.some(
              (log) => log.medicamentoId === med.medicamentoId && log.plannedTime.includes(`${todayISOStr}T${slotTime}`)
            );

            if (!isTaken) {
              const notifiedKey = `notified_${med.medicamentoId}_${todayISOStr}_${slotTime}`;
              const alreadyNotified = localStorage.getItem(notifiedKey);
              
              if (!alreadyNotified) {
                const patient = medicados.find((p) => p.medicadoId === med.medicadoId);
                const patientName = patient ? patient.name : "Paciente";
                
                if ("serviceWorker" in navigator && Notification.permission === "granted") {
                  navigator.serviceWorker.ready.then((reg) => {
                    reg.showNotification(`Hora de remediar: ${med.name}!`, {
                      body: `Paciente: ${patientName}\nDosagem: ${med.dosage}\nHorário: ${slotTime}`,
                      icon: "https://images.unsplash.com/photo-1584017911766-d451b3d0e843?w=192&h=192&fit=crop&auto=format",
                      badge: "https://images.unsplash.com/photo-1584017911766-d451b3d0e843?w=192&h=192&fit=crop&auto=format",
                      vibrate: [300, 100, 300],
                      requireInteraction: true,
                      tag: `dose_${med.medicamentoId}_${slotTime}`,
                    } as any);
                  });
                } else if (Notification.permission === "granted") {
                  new Notification(`Hora de remediar: ${med.name}!`, {
                    body: `Paciente: ${patientName}\nDosagem: ${med.dosage}\nHorário: ${slotTime}`,
                  });
                }

                localStorage.setItem(notifiedKey, "true");
              }
            }
          }
        });
      });
    };

    checkDosesAndNotify();
    const interval = setInterval(checkDosesAndNotify, 20000);
    return () => clearInterval(interval);
  }, [activeUser, medicamentos, doseLogs, medicados]);

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
        if ("serviceWorker" in navigator) {
          navigator.serviceWorker.ready.then((reg) => {
            reg.showNotification("HoraCertaAI - Alertas Ativados", {
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
          reg.showNotification("Lembrete: Amoxicilina (Teste)", {
            body: "Paciente: Julia Barreto\nDosagem: 1 comprimido (500mg)\nHorário: Agora!",
            icon: "https://images.unsplash.com/photo-1584017911766-d451b3d0e843?w=192&h=192&fit=crop&auto=format",
            badge: "https://images.unsplash.com/photo-1584017911766-d451b3d0e843?w=192&h=192&fit=crop&auto=format",
            vibrate: [200, 100, 200],
            requireInteraction: true,
          } as any);
        });
      } else {
        new Notification("Lembrete: Amoxicilina (Teste)", {
          body: "Paciente: Julia Barreto\nDosagem: 1 comprimido (500mg)",
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
        showToast("HoraCertaAI instalado com sucesso!");
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

  // Synchronize profile inputs when active user changes
  useEffect(() => {
    if (activeUser) {
      setProfilePassword(activeUser.password || "");
    }
  }, [activeUser]);

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

  const handleCapturePhoto = () => {
    if (!profileVideoRef.current) return;
    const canvas = document.createElement("canvas");
    canvas.width = 300;
    canvas.height = 300;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.drawImage(profileVideoRef.current, 0, 0, 300, 300);
      const dataUrl = canvas.toDataURL("image/jpeg");
      if (activeUser) {
        const updated = { ...activeUser, avatarUrl: dataUrl };
        handleUpdateUser(updated);
        showToast("Sua foto de perfil foi atualizada com sucesso!");
      }
    }
    setIsCameraActive(false);
  };

  const handlePhotoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const dataUrl = event.target?.result as string;
      if (activeUser && dataUrl) {
        const updated = { ...activeUser, avatarUrl: dataUrl };
        handleUpdateUser(updated);
        showToast("Sua foto de perfil foi carregada com sucesso!");
      }
    };
    reader.readAsDataURL(file);
  };

  const handleSavePassword = () => {
    if (!activeUser) return;
    if (!profilePassword.trim()) {
      showToast("Por favor, digite uma senha válida.");
      return;
    }
    const updated = { ...activeUser, password: profilePassword };
    handleUpdateUser(updated);
    showToast("Sua senha de acesso foi atualizada!");
  };

  // Show visual toast notifications
  const showToast = (message: string) => {
    setSuccessToast(message);
    setTimeout(() => {
      setSuccessToast(null);
    }, 4000);
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
    showToast(`Dados de ${updatedPatient.name} atualizados!`);
  };

  const handleDeletePatient = (patientId: string) => {
    if (!activeUser) return;
    dbLocal.deleteMedicado(patientId);
    setMedicados(dbLocal.getMedicados(activeUser.userId));
    showToast("Paciente removido com sucesso.");
  };

  // ==========================================
  // MEDICINES (MEDICAMENTOS) CRUD HANDLERS
  // ==========================================
  const handleAddMedicine = (medData: Omit<Medicamento, "medicamentoId" | "createdAt"> & { createdAt?: string }) => {
    if (!activeUser) return;
    const newMed: Medicamento = {
      ...medData,
      medicamentoId: `med_${Date.now()}`,
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
  };

  const handleDeleteMedicine = (medId: string) => {
    if (!activeUser) return;
    dbLocal.deleteMedicamento(medId);
    setMedicamentos(dbLocal.getMedicamentos(activeUser.userId));
    showToast("Medicamento removido da programação.");
  };

  // ==========================================
  // DOSE LOGS HANDLERS
  // ==========================================
  const handleAddDoseLog = (log: DoseLog) => {
    if (!activeUser) return;
    dbLocal.addDoseLog(log);
    setDoseLogs(dbLocal.getDoseLogs(activeUser.userId));
    showToast("Medicamento marcado como TOMADO! Saúde garantida.");
  };

  const handleDeleteDoseLog = (logId: string) => {
    if (!activeUser) return;
    dbLocal.deleteDoseLog(logId);
    setDoseLogs(dbLocal.getDoseLogs(activeUser.userId));
    showToast("Status retornado para pendente.");
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
    showToast("Consulta atualizada.");
  };

  const handleDeleteAppointment = (apptId: string) => {
    if (!activeUser) return;
    dbLocal.deleteConsulta(apptId);
    setConsultas(dbLocal.getConsultas(activeUser.userId));
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
  };

  const handleDeleteFarmacia = (farmId: string) => {
    if (!activeUser) return;
    dbLocal.deleteFarmacia(farmId);
    setFarmacias(dbLocal.getFarmacias(activeUser.userId));
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
    dbLocal.deleteCupom(cupomId);
    setCupons(dbLocal.getCupons(activeUser.userId));
    showToast("Cupom fiscal removido.");
  };

  // ==========================================
  // ADMIN PANEL CONTROLS (SUPER-USER)
  // ==========================================
  const handleUpdateUser = (updatedUser: User) => {
    dbLocal.updateUser(updatedUser);
    setUsers(dbLocal.getUsers());
    showToast(`Cadastro de ${updatedUser.name} atualizado no diretório.`);
    
    // If the administrator edited their own status or role, update session
    if (activeUser && activeUser.userId === updatedUser.userId) {
      setActiveUser(updatedUser);
    }
  };

  const handleDeleteUser = (userId: string) => {
    dbLocal.deleteUser(userId);
    setUsers(dbLocal.getUsers());
    showToast("Cadastro de usuário removido com sucesso.");
  };

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
  const handleScanComplete = (
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
        pricePlaceholder: Math.floor(Math.random() * 40) + 15.90, // Generate low cost pricing
        createdAt: new Date().toISOString(),
      };
      dbLocal.addMedicamento(newMed);
    });

    // Refresh layout queries
    setReceitas(dbLocal.getReceitas(activeUser.userId));
    setMedicamentos(dbLocal.getMedicamentos(activeUser.userId));

    setShowScanFlow(false);
    setActiveTab("schedule");
    showToast(`Receita de ${doctorName} lida e agendada com sucesso por Inteligência Artificial!`);
  };

  const handleDeleteReceita = (receitaId: string) => {
    if (!activeUser) return;
    dbLocal.deleteReceita(receitaId);
    setReceitas(dbLocal.getReceitas(activeUser.userId));
    setMedicamentos(dbLocal.getMedicamentos(activeUser.userId));
    setDoseLogs(dbLocal.getDoseLogs(activeUser.userId));
    showToast("Receita médica e seus medicamentos associados foram removidos.");
  };

  // Switch between Admin Antonio (full control) and Normal User Maria (tenant isolated)
  const handleSwitchUserSession = (user: User) => {
    if (user.status === "suspended") {
      alert("Acesso negado: Sua conta está marcada como SUSPENSA pelo Administrador no Painel RBAC.");
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

  const handleLogout = () => {
    setActiveUser(null);
    localStorage.removeItem("horacerta_active_user_id");
    setActiveTab("home");
    showToast("Sessão encerrada com sucesso!");
  };

  // ==========================================
  // SEPARATE ADMIN PORTAL HANDLERS
  // ==========================================
  const handleAdminLogin = (email: string, pass: string) => {
    const found = users.find(u => u.email.toLowerCase() === email.toLowerCase().trim() && u.password === pass);
    if (!found) {
      throw new Error("E-mail ou senha incorretos.");
    }
    if (found.role !== "admin") {
      throw new Error("Acesso negado: Este portal é restrito para administradores.");
    }
    if (found.status === "suspended") {
      throw new Error("Acesso negado: Esta conta está suspensa.");
    }

    setActiveAdminUser(found);
    localStorage.setItem("horacerta_active_admin_id", found.userId);
    showToast(`Olá, ${found.name}! Portal de Controle ativado.`);
  };

  const handleAdminLogout = () => {
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
    if (window.location.pathname.startsWith("/admin")) {
      window.history.pushState({}, "", "/");
    }
  };

  // Check if session has admin role privileges
  const isAdminSession = activeUser?.role === "admin";

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
                onSubmit={(e) => {
                  e.preventDefault();
                  const target = e.target as typeof e.target & {
                    email: { value: string };
                    password: { value: string };
                  };
                  try {
                    handleAdminLogin(target.email.value, target.password.value);
                  } catch (err: any) {
                    alert(err.message);
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
                      placeholder="antonio.marcus.barreto@gmail.com"
                      defaultValue="antonio.marcus.barreto@gmail.com"
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
                      defaultValue="antonio123"
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
                  window.history.pushState({}, "", "/");
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
                    HoraCertaAI - Portal Admin
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
                    window.history.pushState({}, "", "/");
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

            <AdminPanel
              users={users}
              onUpdateUser={handleUpdateUser}
              onDeleteUser={handleDeleteUser}
              onAddUser={handleAddUser}
              activeUserId={activeUser?.userId}
              onSimulateUser={handleSimulateUser}
            />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-brand-cream text-brand-teal relative selection:bg-brand-coral/20 select-none pb-20">
      
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

      {/* Main app navigation switcher */}
      {!activeUser ? (
        <AuthScreen onLoginSuccess={handleLoginSuccess} />
      ) : showScanFlow ? (
        <div className="pt-4">
          <PrescriptionScanner
            medicados={medicados}
            onScanComplete={handleScanComplete}
            onCancel={() => setShowScanFlow(false)}
          />
        </div>
      ) : (
        <div>
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
              onDeleteDoseLog={handleDeleteDoseLog}
              selectedDate={scheduleDate}
              setSelectedDate={setScheduleDate}
              selectedPatientFilterId={schedulePatientId}
              setSelectedPatientFilterId={setSchedulePatientId}
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
            />
          )}

          {/* Profile Tab */}
          {activeTab === "profile" && (
            <div className="pb-32 px-4 max-w-md mx-auto pt-6 animate-fade-in space-y-6">
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
                          if (activeUser) {
                            setProfilePassword(activeUser.password || "");
                          }
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
                            Plano: <span className="capitalize text-brand-teal font-semibold">{activeUser.subscriptionPlan === "monthly" ? "Mensal Recorrente" : "Anual Premium"}</span>
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
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

              {/* Saved recipes list inside user panel */}
              <Appointments
                medicados={medicados}
                receitas={receitas}
                medicamentos={medicamentos}
                onDeleteReceita={handleDeleteReceita}
              />
            </div>
          )}
        </div>
      )}

      {/* Persistent Elegant Bottom Navigation */}
      {activeUser && !showScanFlow && (
        <BottomNavBar
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          onAddClick={() => setShowScanFlow(true)}
        />
      )}
    </div>
  );
}
