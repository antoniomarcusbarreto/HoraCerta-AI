import React, { useState } from "react";
import { User } from "../types";
import { auth } from "../firebase";
import ConfirmDialog from "./ConfirmDialog";
import {
  Shield,
  ShieldAlert,
  UserCheck,
  UserX,
  Trash2,
  Plus,
  RefreshCw,
  Search,
  Calendar,
  Gift,
  CreditCard,
  Award,
  Key,
  Lock,
  X,
  Sparkles,
  CheckCircle,
  HelpCircle,
  AlertCircle
} from "lucide-react";

interface AdminPanelProps {
  users: User[];
  onUpdateUser: (user: User) => Promise<boolean>;
  onDeleteUser: (userId: string) => Promise<boolean>;
  onAddUser: (user: Omit<User, "createdAt">) => void;
  onNotify: (message: string) => void;
  activeTab?: string;
  setActiveTab?: (tab: string) => void;
  activeUserId?: string;
  onSimulateUser?: (user: User) => void;
}

export default function AdminPanel({
  users,
  onUpdateUser,
  onDeleteUser,
  onAddUser,
  onNotify,
  activeTab,
  setActiveTab,
  activeUserId,
  onSimulateUser,
}: AdminPanelProps) {
  const [showAddUserModal, setShowAddUserModal] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [confirmDialog, setConfirmDialog] = useState<{ title: string; message: string; onConfirm: () => void } | null>(null);

  // Add User states
  const [userName, setUserName] = useState("");
  const [userEmail, setUserEmail] = useState("");
  const [userRole, setUserRole] = useState<"user" | "admin">("user");
  const [userStatus, setUserStatus] = useState<"active" | "suspended">("active");

  // Change Password states (real Firebase Auth password, via server/admin endpoint)
  const [editingPasswordUser, setEditingPasswordUser] = useState<User | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [isSubmittingPassword, setIsSubmittingPassword] = useState(false);

  // Trial Extension states
  const [editingTrialUser, setEditingTrialUser] = useState<User | null>(null);
  const [daysToGrant, setDaysToGrant] = useState("15");

  // Subscription Edit states
  const [editingSubscriptionUser, setEditingSubscriptionUser] = useState<User | null>(null);
  const [subStatus, setSubStatus] = useState<'active' | 'inactive' | 'expired'>('inactive');
  const [subPlan, setSubPlan] = useState<'monthly' | 'yearly' | 'none'>('none');

  // Helper to format date nicely
  const formatDateString = (isoString?: string) => {
    if (!isoString) return "Não configurado";
    try {
      const d = new Date(isoString);
      return d.toLocaleDateString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric"
      });
    } catch {
      return "Data inválida";
    }
  };

  // Helper to calculate trial status
  const getTrialInfo = (freeTrialUntil?: string) => {
    if (!freeTrialUntil) {
      return { status: "none", text: "Sem período gratuito", daysLeft: 0 };
    }
    const expiration = new Date(freeTrialUntil);
    const now = new Date();
    const diffTime = expiration.getTime() - now.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays > 0) {
      return { 
        status: "active", 
        text: `${diffDays} ${diffDays === 1 ? "dia restante" : "dias restantes"}`, 
        daysLeft: diffDays 
      };
    } else {
      return { 
        status: "expired", 
        text: `Expirou em ${formatDateString(freeTrialUntil)}`, 
        daysLeft: diffDays 
      };
    }
  };

  // Every handler below awaits the Firestore write and only mutates local UI
  // state (closing modals, etc.) on confirmed success — onUpdateUser itself
  // shows the error toast and leaves everything untouched on failure.
  const handleToggleStatus = async (user: User) => {
    const nextStatus = user.status === "active" ? "suspended" : "active";
    await onUpdateUser({ ...user, status: nextStatus });
  };

  const handleToggleRole = async (user: User) => {
    const nextRole = user.role === "admin" ? "user" : "admin";
    await onUpdateUser({ ...user, role: nextRole });
  };

  const handleTrialSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingTrialUser) return;

    const days = parseInt(daysToGrant, 10);
    if (isNaN(days) || days < 0) return;

    const currentExpiry = editingTrialUser.freeTrialUntil ? new Date(editingTrialUser.freeTrialUntil) : new Date();
    // Start counting from today if it was expired, otherwise append to current expiry
    const baseDate = currentExpiry.getTime() > Date.now() ? currentExpiry : new Date();

    const nextExpiry = new Date(baseDate.getTime() + days * 24 * 60 * 60 * 1000);

    const success = await onUpdateUser({
      ...editingTrialUser,
      freeTrialUntil: nextExpiry.toISOString(),
    });

    if (success) {
      setEditingTrialUser(null);
    }
  };

  const handleSubscriptionSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingSubscriptionUser) return;

    const success = await onUpdateUser({
      ...editingSubscriptionUser,
      subscriptionStatus: subStatus,
      subscriptionPlan: subPlan,
    });

    if (success) {
      setEditingSubscriptionUser(null);
    }
  };

  // Changing another user's real login password requires the Admin SDK, which
  // only exists server-side. This calls a backend endpoint that verifies the
  // caller's `admin` custom claim before touching Firebase Auth.
  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingPasswordUser) return;
    if (newPassword.trim().length < 6) {
      onNotify("A nova senha deve ter pelo menos 6 caracteres.");
      return;
    }

    setIsSubmittingPassword(true);
    try {
      const idToken = await auth.currentUser?.getIdToken();
      if (!idToken) {
        onNotify("Sessão expirada. Faça login novamente no portal.");
        return;
      }

      const response = await fetch("/api/admin/change-user-password", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({ uid: editingPasswordUser.userId, newPassword }),
      });

      if (!response.ok) {
        const errJson = await response.json().catch(() => ({}));
        throw new Error(errJson.error || "Falha ao alterar a senha no servidor.");
      }

      onNotify(`Senha de ${editingPasswordUser.name} alterada com sucesso.`);
      setEditingPasswordUser(null);
      setNewPassword("");
    } catch (err: any) {
      onNotify(err.message || "Não foi possível alterar a senha.");
    } finally {
      setIsSubmittingPassword(false);
    }
  };

  const handleAddUserSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!userName.trim() || !userEmail.trim()) return;

    onAddUser({
      userId: `user_${Date.now()}`,
      name: userName,
      email: userEmail,
      role: userRole,
      status: userStatus,
      freeTrialUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), // 7 days of trial by default
      subscriptionStatus: "inactive",
      subscriptionPlan: "none",
    });

    setUserName("");
    setUserEmail("");
    setUserRole("user");
    setUserStatus("active");
    setShowAddUserModal(false);
  };

  // Filtered users for search query
  const filteredUsers = users.filter(u => 
    u.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
    u.email.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Stats Counters
  const activeCount = users.filter(u => u.status === "active").length;
  const trialActiveCount = users.filter(u => getTrialInfo(u.freeTrialUntil).status === "active").length;
  const subscribedCount = users.filter(u => u.subscriptionStatus === "active").length;

  return (
    <div className="pb-32 px-4 pt-6 animate-fade-in space-y-6">
      {/* Segmented Switcher for Admin Session */}
      {setActiveTab && activeTab && (
        <div className="flex bg-brand-cream-dark/50 border border-brand-cream-darker p-1 rounded-2xl">
          <button
            type="button"
            onClick={() => setActiveTab("profile")}
            className="flex-1 py-2 rounded-xl text-xs font-bold transition-all text-brand-teal/70 hover:text-brand-teal"
          >
            Meu Perfil
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("admin")}
            className="flex-1 py-2 rounded-xl text-xs font-bold transition-all bg-brand-teal text-white shadow-xs"
          >
            Painel de Controle
          </button>
        </div>
      )}

      {/* Admin Title Card */}
      <div className="bg-gradient-to-br from-brand-teal to-teal-800 text-brand-cream rounded-3xl p-6 shadow-md flex items-center justify-between">
        <div>
          <span className="text-[10px] font-bold text-brand-coral uppercase tracking-widest font-mono">
            Módulo Seguro RBAC
          </span>
          <h2 className="text-xl font-display font-bold">Gestão da Plataforma</h2>
          <p className="text-xs text-brand-cream/80 font-sans mt-0.5">
            Módulo geral para ativação, senhas e concessão de benefícios.
          </p>
        </div>
        <div className="w-12 h-12 bg-white/10 rounded-full flex items-center justify-center text-brand-peach shrink-0 ml-2">
          <Shield className="w-6 h-6 fill-brand-peach/10" />
        </div>
      </div>

      {/* Stats Board */}
      <div className="grid grid-cols-3 gap-2 lg:gap-4">
        <div className="bg-white border border-brand-cream-darker rounded-2xl p-3 text-center">
          <span className="text-[10px] text-gray-400 font-bold uppercase tracking-wider block">Cadastrados</span>
          <span className="text-lg font-display font-bold text-brand-teal">{users.length}</span>
        </div>
        <div className="bg-white border border-brand-cream-darker rounded-2xl p-3 text-center">
          <span className="text-[10px] text-gray-400 font-bold uppercase tracking-wider block">Ativos</span>
          <span className="text-lg font-display font-bold text-emerald-600">{activeCount}</span>
        </div>
        <div className="bg-white border border-brand-cream-darker rounded-2xl p-3 text-center">
          <span className="text-[10px] text-gray-400 font-bold uppercase tracking-wider block">Assinantes</span>
          <span className="text-lg font-display font-bold text-amber-600">{subscribedCount}</span>
        </div>
      </div>

      {/* Simulador de Perfis (Controle RBAC) */}
      {onSimulateUser && (
        <div className="bg-white border border-brand-cream-darker rounded-3xl p-5 shadow-xs space-y-4 animate-fade-in">
          <div className="flex items-center gap-2 border-b border-brand-cream-darker pb-2">
            <div className="p-1.5 bg-brand-peach text-brand-coral rounded-lg shrink-0">
              <Shield className="w-4 h-4" />
            </div>
            <div>
              <h4 className="text-xs font-bold text-brand-teal uppercase tracking-wider">
                Simulador de Perfis (Controle RBAC)
              </h4>
              <p className="text-[10px] text-gray-400 font-sans mt-0.5">
                Alterne entre contas para testar permissões e simular sessões de usuários no app
              </p>
            </div>
          </div>

          <div className="space-y-2">
            {users.map((u) => {
              const isCurrent = activeUserId === u.userId;
              const isSuspended = u.status === "suspended";
              return (
                <div
                  key={u.userId}
                  className={`flex items-center justify-between p-3 rounded-2xl border transition-all ${
                    isCurrent
                      ? "bg-brand-cream/60 border-brand-coral/40"
                      : "bg-gray-50/50 border-gray-100 hover:bg-gray-50"
                  }`}
                >
                  <div className="min-w-0 flex-1 pr-2">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-xs font-bold text-brand-teal truncate">{u.name}</span>
                      <span
                        className={`text-[8px] font-extrabold px-1.5 py-0.5 rounded-sm uppercase tracking-wide ${
                          u.role === "admin"
                            ? "bg-brand-coral/15 text-brand-coral"
                            : "bg-gray-200/70 text-gray-500"
                        }`}
                      >
                        {u.role}
                      </span>
                      {isSuspended && (
                        <span className="text-[8px] font-extrabold bg-red-100 text-red-600 px-1.5 py-0.5 rounded-sm uppercase tracking-wide">
                          Suspenso
                        </span>
                      )}
                    </div>
                    <p className="text-[9px] text-gray-400 font-mono mt-0.5 truncate">{u.email}</p>
                  </div>

                  <button
                    type="button"
                    onClick={() => {
                      if (isSuspended) {
                        onNotify(`Sessão Negada: O usuário ${u.name} está bloqueado pelo administrador. Ative-o novamente no Painel Administrativo usando a conta do Antonio Marcus!`);
                        return;
                      }
                      onSimulateUser(u);
                    }}
                    className={`px-3 py-1.5 rounded-xl text-[10px] font-bold uppercase transition-all shrink-0 ${
                      isCurrent
                        ? "bg-brand-teal text-white cursor-default"
                        : "bg-white border border-brand-cream-darker text-brand-teal hover:bg-brand-peach font-semibold"
                    }`}
                  >
                    {isCurrent ? "Simulando" : "Simular"}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Control Area */}
      <div className="space-y-4">
        {/* Search & Add Header */}
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-bold text-brand-teal uppercase tracking-wider flex items-center gap-1.5">
              Usuários Registrados ({filteredUsers.length})
            </h3>
            <button
              onClick={() => setShowAddUserModal(true)}
              className="text-xs font-semibold bg-brand-teal text-brand-cream hover:bg-brand-teal-light px-3 py-1.5 rounded-xl flex items-center gap-1 transition-all shadow-xs"
            >
              <Plus className="w-3.5 h-3.5" /> Novo Usuário
            </button>
          </div>

          <div className="relative">
            <Search className="absolute left-3 top-2.5 w-4 h-4 text-gray-400" />
            <input
              type="text"
              placeholder="Buscar por nome ou e-mail..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-white border border-brand-cream-darker rounded-xl pl-9 pr-4 py-2 text-xs text-brand-teal focus:outline-hidden focus:border-brand-coral font-sans"
            />
          </div>
        </div>

        {/* Registered Users List */}
        <div className="space-y-3 lg:grid lg:grid-cols-2 lg:gap-3 lg:space-y-0">
          {filteredUsers.length === 0 ? (
            <div className="bg-white border border-brand-cream-darker rounded-3xl p-8 text-center text-gray-400">
              <AlertCircle className="w-8 h-8 mx-auto mb-2 text-gray-300" />
              <p className="text-xs font-semibold">Nenhum usuário correspondente.</p>
            </div>
          ) : (
            filteredUsers.map((u) => {
              const isSuspended = u.status === "suspended";
              const isAdmin = u.role === "admin";
              const trial = getTrialInfo(u.freeTrialUntil);
              const hasActiveSub = u.subscriptionStatus === "active";

              return (
                <div
                  key={u.userId}
                  id={`user-row-${u.userId}`}
                  className={`rounded-2xl p-4 border transition-all space-y-3 ${
                    isSuspended 
                      ? "bg-red-50/40 border-red-100 opacity-80" 
                      : "bg-white border-brand-cream-darker shadow-2xs"
                  }`}
                >
                  {/* Top line identity */}
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <h4 className="text-xs font-bold text-brand-teal leading-tight">{u.name}</h4>
                        {isAdmin && (
                          <span className="text-[8px] font-extrabold bg-brand-coral/15 text-brand-coral px-1 py-0.5 rounded-sm uppercase tracking-wider">
                            Admin
                          </span>
                        )}
                        <span
                          className={`text-[8px] font-bold px-1.5 py-0.5 rounded-full uppercase tracking-wide ${
                            isSuspended ? "bg-red-100 text-red-600" : "bg-emerald-100 text-emerald-600"
                          }`}
                        >
                          {isSuspended ? "Bloqueado" : "Ativo"}
                        </span>
                      </div>
                      <p className="text-[10px] text-gray-400 font-mono mt-0.5">{u.email}</p>
                    </div>

                    {/* Quick switch roles & delete actions */}
                    <div className="flex items-center space-x-1">
                      {/* Change privilege role */}
                      <button
                        onClick={() => handleToggleRole(u)}
                        className={`p-1 rounded-md border text-[9px] font-bold transition-all ${
                          isAdmin 
                            ? "bg-brand-coral-light/10 text-brand-coral border-brand-coral/10 hover:bg-brand-coral/15" 
                            : "bg-gray-50 text-gray-500 border-gray-100 hover:bg-gray-100"
                        }`}
                        title={isAdmin ? "Rebaixar para Usuário" : "Promover a Admin"}
                      >
                        {isAdmin ? "Admin" : "Promover"}
                      </button>

                      {/* Delete user */}
                      <button
                        onClick={() => {
                          if (u.email === "antonio.marcus.barreto@gmail.com" && u.userId !== "user_antonio") {
                            onNotify("Não é possível remover o administrador principal bootstrapped!");
                            return;
                          }
                          setConfirmDialog({
                            title: "Remover usuário",
                            message: `Remover permanentemente o usuário ${u.name}? Essa ação não pode ser desfeita.`,
                            onConfirm: async () => {
                              await onDeleteUser(u.userId);
                              setConfirmDialog(null);
                            },
                          });
                        }}
                        className="p-1 rounded-md border border-red-100 bg-red-50 text-red-500 hover:bg-red-600 hover:text-white transition-all"
                        title="Excluir Usuário"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  {/* Divider line */}
                  <div className="border-t border-brand-cream-darker/60 my-1"></div>

                  {/* Core Platform Management (Trial & Subscription Details) */}
                  <div className="grid grid-cols-2 gap-2 text-[10px]">
                    {/* Trial Status Section */}
                    <div className="bg-brand-cream/40 rounded-xl p-2 border border-brand-cream-darker/50 space-y-1">
                      <div className="flex items-center gap-1 text-brand-teal font-semibold">
                        <Gift className="w-3 h-3 text-brand-coral shrink-0" />
                        <span>Gratuidade / Teste</span>
                      </div>
                      <div className="text-[9px] text-gray-500 leading-tight">
                        Status: <strong className={trial.status === "active" ? "text-emerald-600" : "text-red-500"}>
                          {trial.status === "active" ? "Válido" : "Expirado"}
                        </strong>
                        <div className="truncate text-gray-400 mt-0.5">{trial.text}</div>
                      </div>
                      <button
                        onClick={() => setEditingTrialUser(u)}
                        className="w-full mt-1.5 bg-white border border-brand-cream-darker hover:bg-brand-peach text-[9px] font-bold text-brand-teal uppercase rounded-lg py-1 transition-colors"
                      >
                        Conceder Dias
                      </button>
                    </div>

                    {/* Subscription Section */}
                    <div className="bg-brand-cream/40 rounded-xl p-2 border border-brand-cream-darker/50 space-y-1">
                      <div className="flex items-center gap-1 text-brand-teal font-semibold">
                        <CreditCard className="w-3 h-3 text-brand-teal shrink-0" />
                        <span>Assinatura</span>
                      </div>
                      <div className="text-[9px] text-gray-500 leading-tight">
                        Status: <strong className={hasActiveSub ? "text-emerald-600" : "text-gray-400"}>
                          {hasActiveSub ? "Ativa" : "Inativa"}
                        </strong>
                        <div className="truncate text-gray-400 mt-0.5">
                          Plano: <span className="capitalize font-semibold text-brand-teal">{u.subscriptionPlan || "Nenhum"}</span>
                        </div>
                      </div>
                      <button
                        onClick={() => {
                          setEditingSubscriptionUser(u);
                          setSubStatus(u.subscriptionStatus || 'inactive');
                          setSubPlan(u.subscriptionPlan || 'none');
                        }}
                        className="w-full mt-1.5 bg-white border border-brand-cream-darker hover:bg-brand-peach text-[9px] font-bold text-brand-teal uppercase rounded-lg py-1 transition-colors"
                      >
                        Gerenciar
                      </button>
                    </div>
                  </div>

                  {/* Actions Bar (Password edit & Activation Status) */}
                  <div className="flex items-center gap-1.5 pt-1">
                    {/* Alterar Senha Button */}
                    <button
                      onClick={() => {
                        setEditingPasswordUser(u);
                        setNewPassword("");
                      }}
                      className="flex-1 bg-brand-cream-dark text-brand-teal hover:bg-brand-peach border border-brand-cream-darker rounded-xl py-1.5 text-[10px] font-bold uppercase tracking-wider flex items-center justify-center gap-1 transition-colors"
                    >
                      <Lock className="w-3 h-3 text-brand-teal" /> Alterar Senha
                    </button>

                    {/* Ativar/Desativar Button */}
                    <button
                      onClick={() => handleToggleStatus(u)}
                      className={`flex-1 rounded-xl py-1.5 text-[10px] font-bold uppercase tracking-wider flex items-center justify-center gap-1 transition-all ${
                        isSuspended
                          ? "bg-emerald-50 text-emerald-600 border border-emerald-200 hover:bg-emerald-100"
                          : "bg-red-50 text-red-500 border border-red-100 hover:bg-red-100"
                      }`}
                    >
                      {isSuspended ? (
                        <>
                          <UserCheck className="w-3 h-3 text-emerald-600" /> Ativar Usuário
                        </>
                      ) : (
                        <>
                          <UserX className="w-3 h-3 text-red-500" /> Desativar Conta
                        </>
                      )}
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* MODAL: Conceder Período de Gratuidade */}
      {editingTrialUser && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 backdrop-blur-xs">
          <div className="bg-brand-cream rounded-3xl max-w-sm w-full p-6 shadow-xl border border-brand-cream-darker animate-scale-up">
            <div className="w-10 h-10 rounded-full bg-brand-peach text-brand-coral flex items-center justify-center mx-auto mb-3">
              <Gift className="w-5 h-5" />
            </div>

            <h3 className="text-base font-display font-bold text-brand-teal text-center mb-1">
              Conceder Período de Gratuidade
            </h3>
            <p className="text-[11px] text-gray-500 text-center mb-4 leading-tight">
              Apenas para o usuário <strong className="text-brand-teal">{editingTrialUser.name}</strong>.<br />
              O período será acrescentado à validade atual ou a partir de hoje.
            </p>

            <form onSubmit={handleTrialSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-brand-teal mb-1 uppercase tracking-wider">
                  Dias de Gratuidade a Conceder
                </label>
                <select
                  value={daysToGrant}
                  onChange={(e) => setDaysToGrant(e.target.value)}
                  className="w-full bg-white border border-brand-cream-darker rounded-xl px-3 py-2 text-sm text-brand-teal focus:outline-hidden"
                >
                  <option value="7">7 Dias Grátis (Semana)</option>
                  <option value="15">15 Dias Grátis (Quinzena)</option>
                  <option value="30">30 Dias Grátis (1 Mês)</option>
                  <option value="90">90 Dias Grátis (3 Meses)</option>
                  <option value="180">180 Dias Grátis (Semestre)</option>
                  <option value="365">365 Dias Grátis (1 Ano)</option>
                </select>
              </div>

              <div className="bg-white rounded-xl p-3 border border-brand-cream-darker text-[10px] text-gray-500 space-y-1">
                <div>Expiração Atual: <strong className="text-brand-teal">{formatDateString(editingTrialUser.freeTrialUntil)}</strong></div>
                <div>Status Atual: <span className="font-semibold capitalize">{getTrialInfo(editingTrialUser.freeTrialUntil).text}</span></div>
              </div>

              <div className="flex space-x-2 pt-2">
                <button
                  type="button"
                  onClick={() => setEditingTrialUser(null)}
                  className="flex-1 border border-brand-cream-darker text-gray-500 rounded-xl py-2.5 text-xs font-semibold hover:bg-gray-50 transition-all"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="flex-1 bg-brand-coral hover:bg-brand-coral-light text-brand-cream rounded-xl py-2.5 text-xs font-semibold transition-all shadow-md"
                >
                  Conceder Dias
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: Gerenciar Assinatura */}
      {editingSubscriptionUser && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 backdrop-blur-xs">
          <div className="bg-brand-cream rounded-3xl max-w-sm w-full p-6 shadow-xl border border-brand-cream-darker animate-scale-up">
            <div className="w-10 h-10 rounded-full bg-teal-50 text-brand-teal flex items-center justify-center mx-auto mb-3 border border-brand-teal/10">
              <CreditCard className="w-5 h-5 text-brand-teal" />
            </div>

            <h3 className="text-base font-display font-bold text-brand-teal text-center mb-1">
              Gerenciar Assinatura do Usuário
            </h3>
            <p className="text-[11px] text-gray-500 text-center mb-4">
              Verifique e atualize a assinatura de <strong className="text-brand-teal">{editingSubscriptionUser.name}</strong>.
            </p>

            <form onSubmit={handleSubscriptionSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-brand-teal mb-1 uppercase tracking-wider">
                  Status da Assinatura
                </label>
                <select
                  value={subStatus}
                  onChange={(e) => setSubStatus(e.target.value as any)}
                  className="w-full bg-white border border-brand-cream-darker rounded-xl px-3 py-2 text-sm text-brand-teal focus:outline-hidden"
                >
                  <option value="active">Ativa (Acesso Liberado)</option>
                  <option value="inactive">Inativa / Cancelada</option>
                  <option value="expired">Expirada / Sem Pagamento</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-bold text-brand-teal mb-1 uppercase tracking-wider">
                  Plano Contratado
                </label>
                <select
                  value={subPlan}
                  onChange={(e) => setSubPlan(e.target.value as any)}
                  className="w-full bg-white border border-brand-cream-darker rounded-xl px-3 py-2 text-sm text-brand-teal focus:outline-hidden"
                >
                  <option value="none">Nenhum Plano Ativo</option>
                  <option value="monthly">Plano Mensal (Recorrente)</option>
                  <option value="yearly">Plano Anual (Premium)</option>
                </select>
              </div>

              <div className="flex space-x-2 pt-2">
                <button
                  type="button"
                  onClick={() => setEditingSubscriptionUser(null)}
                  className="flex-1 border border-brand-cream-darker text-gray-500 rounded-xl py-2.5 text-xs font-semibold hover:bg-gray-50 transition-all"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="flex-1 bg-brand-teal text-brand-cream rounded-xl py-2.5 text-xs font-semibold hover:bg-brand-teal-light transition-all shadow-md"
                >
                  Salvar Assinatura
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: Alterar Senha */}
      {editingPasswordUser && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 backdrop-blur-xs">
          <div className="bg-brand-cream rounded-3xl max-w-sm w-full p-6 shadow-xl border border-brand-cream-darker animate-scale-up">
            <div className="w-10 h-10 rounded-full bg-amber-50 text-amber-600 flex items-center justify-center mx-auto mb-3 border border-amber-100">
              <Key className="w-5 h-5 text-amber-600" />
            </div>

            <h3 className="text-base font-display font-bold text-brand-teal text-center mb-1">
              Alterar Senha do Usuário
            </h3>
            <p className="text-[11px] text-gray-500 text-center mb-4">
              Defina uma nova senha de login para <strong className="text-brand-teal">{editingPasswordUser.name}</strong>. Isso altera a conta real no Firebase Auth.
            </p>

            <form onSubmit={handlePasswordSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-brand-teal mb-1 uppercase tracking-wider">
                  Nova Senha de Acesso
                </label>
                <input
                  type="text"
                  required
                  placeholder="Mínimo 6 caracteres"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="w-full bg-white border border-brand-cream-darker rounded-xl px-3 py-2 text-sm text-brand-teal focus:outline-hidden text-center font-mono"
                />
              </div>

              <div className="flex space-x-2 pt-2">
                <button
                  type="button"
                  onClick={() => setEditingPasswordUser(null)}
                  className="flex-1 border border-brand-cream-darker text-gray-500 rounded-xl py-2.5 text-xs font-semibold hover:bg-gray-50 transition-all"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={isSubmittingPassword}
                  className="flex-1 bg-brand-teal text-brand-cream rounded-xl py-2.5 text-xs font-semibold hover:bg-brand-teal-light transition-all shadow-md disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isSubmittingPassword ? "Salvando..." : "Confirmar Nova Senha"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: Registrar Novo Usuário */}
      {showAddUserModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 backdrop-blur-xs">
          <div className="bg-brand-cream rounded-3xl max-w-sm w-full p-6 shadow-xl border border-brand-cream-darker animate-scale-up">
            <h3 className="text-base font-display font-bold text-brand-teal mb-4">
              Registrar Novo Usuário
            </h3>
            <form onSubmit={handleAddUserSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-brand-teal mb-1 uppercase tracking-wider">
                  Nome do Usuário
                </label>
                <input
                  type="text"
                  required
                  placeholder="Ex: João da Silva"
                  value={userName}
                  onChange={(e) => setUserName(e.target.value)}
                  className="w-full bg-white border border-brand-cream-darker rounded-xl px-3 py-2 text-sm text-brand-teal focus:outline-hidden"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-brand-teal mb-1 uppercase tracking-wider">
                  Email
                </label>
                <input
                  type="email"
                  required
                  placeholder="Ex: joao@email.com"
                  value={userEmail}
                  onChange={(e) => setUserEmail(e.target.value)}
                  className="w-full bg-white border border-brand-cream-darker rounded-xl px-3 py-2 text-sm text-brand-teal focus:outline-hidden"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-brand-teal mb-1 uppercase tracking-wider">
                    Privilégio (Role)
                  </label>
                  <select
                    value={userRole}
                    onChange={(e) => setUserRole(e.target.value as "user" | "admin")}
                    className="w-full bg-white border border-brand-cream-darker rounded-xl px-3 py-2 text-sm text-brand-teal focus:outline-hidden"
                  >
                    <option value="user">Usuário Comum</option>
                    <option value="admin">Administrador</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-bold text-brand-teal mb-1 uppercase tracking-wider">
                    Status Inicial
                  </label>
                  <select
                    value={userStatus}
                    onChange={(e) => setUserStatus(e.target.value as "active" | "suspended")}
                    className="w-full bg-white border border-brand-cream-darker rounded-xl px-3 py-2 text-sm text-brand-teal focus:outline-hidden"
                  >
                    <option value="active">Ativo / Liberado</option>
                    <option value="suspended">Suspenso</option>
                  </select>
                </div>
              </div>

              <div className="flex space-x-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowAddUserModal(false)}
                  className="flex-1 border border-brand-cream-darker text-gray-500 rounded-xl py-2 text-sm font-semibold hover:bg-gray-50 transition-all"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="flex-1 bg-brand-teal text-brand-cream rounded-xl py-2 text-sm font-semibold hover:bg-brand-teal-light transition-all shadow-sm"
                >
                  Cadastrar
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!confirmDialog}
        title={confirmDialog?.title || ""}
        message={confirmDialog?.message || ""}
        danger
        confirmLabel="Remover"
        onConfirm={() => confirmDialog?.onConfirm()}
        onCancel={() => setConfirmDialog(null)}
      />
    </div>
  );
}

