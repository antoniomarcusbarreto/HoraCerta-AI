import React, { useState } from "react";
import { User } from "../types";
import { auth } from "../firebase";
import { getAccessState, PLANS, TRIAL_SCAN_LIMIT, type PlanId } from "../subscription";
import ConfirmDialog from "./ConfirmDialog";
import { useDialogA11y } from "../hooks/useDialogA11y";
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
  Pencil,
  X,
  Sparkles,
  CheckCircle,
  HelpCircle,
  AlertCircle
} from "lucide-react";

interface AdminPanelProps {
  users: User[];
  onUpdateUser: (user: User) => Promise<boolean>;
  onSetUserStatus: (user: User, nextStatus: "active" | "suspended") => Promise<boolean>;
  onDeleteUser: (userId: string) => Promise<boolean>;
  onNotify: (message: string) => void;
  activeTab?: string;
  setActiveTab?: (tab: string) => void;
}

export default function AdminPanel({
  users,
  onUpdateUser,
  onSetUserStatus,
  onDeleteUser,
  onNotify,
  activeTab,
  setActiveTab,
}: AdminPanelProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [confirmDialog, setConfirmDialog] = useState<{ title: string; message: string; onConfirm: () => void } | null>(null);

  // Change Password states (real Firebase Auth password, via server/admin endpoint)
  const [editingPasswordUser, setEditingPasswordUser] = useState<User | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [isSubmittingPassword, setIsSubmittingPassword] = useState(false);

  // Name Edit states
  const [editingNameUser, setEditingNameUser] = useState<User | null>(null);
  const [nameInput, setNameInput] = useState("");
  const [isSubmittingName, setIsSubmittingName] = useState(false);

  // Trial Extension states
  const [editingTrialUser, setEditingTrialUser] = useState<User | null>(null);
  const [daysToGrant, setDaysToGrant] = useState("15");

  // Subscription Edit states
  const [editingSubscriptionUser, setEditingSubscriptionUser] = useState<User | null>(null);
  const [subStatus, setSubStatus] = useState<'active' | 'inactive' | 'expired'>('inactive');
  const [subPlan, setSubPlan] = useState<'monthly' | 'yearly' | 'none'>('none');
  // NÃO existe mais um campo livre de "dias a conceder" aqui. Este modal
  // reconcilia um PAGAMENTO aprovado, então o período é sempre a duração real
  // do plano (PLANS[plan].days) — o mesmo resultado de um pagamento processado
  // pelo webhook. Ter dois lugares diferentes concedendo "dias" (aqui e no card
  // de gratuidade, que escreve outro campo) era a origem da confusão: dava para
  // sair deste modal achando que tinha liberado acesso sem ter liberado nada.
  // Concessão de cortesia agora é exclusivamente "Conceder Gratuidade".

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
  // Suspender agora tem efeito real (bloqueia o login e encerra a sessão que
  // estiver aberta no dispositivo da pessoa), então passa por confirmação —
  // antes era só um rótulo no perfil e podia ser desfeito sem consequência.
  const handleToggleStatus = async (user: User) => {
    const nextStatus = user.status === "active" ? "suspended" : "active";

    if (nextStatus === "active") {
      await onSetUserStatus(user, "active");
      return;
    }

    setConfirmDialog({
      title: "Suspender usuário",
      message: `${user.name} perderá o acesso imediatamente: o login será bloqueado e a sessão aberta no dispositivo dele será encerrada. Os dados são preservados e você pode reativar a qualquer momento.`,
      onConfirm: () => {
        setConfirmDialog(null);
        void onSetUserStatus(user, "suspended");
      },
    });
  };

  // NÃO existe promover/rebaixar: o antigo handleToggleRole gravava o campo
  // `role`, que é apenas metadado de exibição e não concede nada — quem manda
  // é a custom claim `admin` do Firebase Auth, definida só por
  // server/setAdminClaim.js. O botão já tinha sido removido justamente por
  // parecer que concedia acesso sem conceder; a função ficou órfã e foi
  // apagada para não ser religada. Ver "Auth" no CLAUDE.md.

  // Bypasses the TRIAL_SCAN_LIMIT-per-type trial cap (src/subscription.ts's
  // canPerformScan) for this user specifically — protects Gemini quota abuse
  // in general while letting an operator whitelist a legitimate case (e.g. a
  // support/demo account) without granting a paid subscription.
  const handleToggleScanExempt = async (user: User) => {
    await onUpdateUser({ ...user, scanLimitExempt: !user.scanLimitExempt });
  };

  // ÚNICO caminho de concessão manual de acesso no painel. Conceder gratuidade
  // também DEVOLVE a cota de scans grátis: o teto de TRIAL_SCAN_LIMIT por tipo é
  // contado por período de gratuidade, não vitalício — sem o reset, conceder 30
  // dias a quem já gastou os 3 scans não liberava nada e o app continuava
  // exibindo "Assine para escanear", ou seja, a ação do admin não chegava ao
  // usuário. Reconciliar um pagamento é outra coisa e vive no modal de
  // assinatura (handleSubscriptionSubmit).
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
      trialPrescriptionScansUsed: 0,
      trialReceiptScansUsed: 0,
    });

    if (success) {
      setEditingTrialUser(null);
    }
  };

  // subscriptionStatus/subscriptionPlan são só rótulos de exibição — quem
  // realmente libera os scanners é subscriptionCurrentPeriodEnd (ver
  // getAccessState em src/subscription.ts). Este handler existe para
  // reconciliar manualmente um pagamento que o webhook do Mercado Pago não
  // processou (ver o log em Logs → Erros): marcar "Ativa" aqui precisa
  // conceder o mesmo período real que um pagamento automático concederia, e
  // marcar "Inativa"/"Expirada" precisa revogar o acesso de verdade — senão
  // um período pago ainda vigente continuaria liberando o app mesmo com o
  // rótulo dizendo "inativo".
  const handleSubscriptionSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingSubscriptionUser) return;

    let subscriptionCurrentPeriodEnd: string;
    if (subStatus === "active") {
      // "Ativa" sem plano gravava o rótulo e nenhum período: o usuário ficava
      // com "Plano: Mensal" no painel e acesso bloqueado no app — foi
      // exatamente esse estado inconsistente que apareceu em produção.
      if (subPlan === "none") {
        onNotify("Escolha o plano pago (mensal ou anual) que foi aprovado no Mercado Pago.");
        return;
      }
      const days = PLANS[subPlan as PlanId].days;
      const currentEnd = editingSubscriptionUser.subscriptionCurrentPeriodEnd
        ? new Date(editingSubscriptionUser.subscriptionCurrentPeriodEnd)
        : new Date();
      const base = currentEnd.getTime() > Date.now() ? currentEnd : new Date();
      subscriptionCurrentPeriodEnd = new Date(base.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
    } else {
      // Data bem no passado: garante que getAccessState nunca a trate como
      // vigente, sem precisar de suporte a "campo ausente" nas regras.
      subscriptionCurrentPeriodEnd = new Date(0).toISOString();
    }

    const success = await onUpdateUser({
      ...editingSubscriptionUser,
      subscriptionStatus: subStatus,
      subscriptionPlan: subPlan,
      subscriptionCurrentPeriodEnd,
    });

    if (success) {
      setEditingSubscriptionUser(null);
    }
  };

  const handleNameSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingNameUser) return;

    const trimmedName = nameInput.trim();
    if (!trimmedName) {
      onNotify("Informe um nome válido.");
      return;
    }

    setIsSubmittingName(true);
    try {
      const success = await onUpdateUser({ ...editingNameUser, name: trimmedName });
      if (success) {
        setEditingNameUser(null);
        setNameInput("");
      }
    } finally {
      setIsSubmittingName(false);
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

  // Filtered users for search query
  const filteredUsers = users.filter(u => 
    u.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
    u.email.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Stats Counters
  const activeCount = users.filter(u => u.status === "active").length;
  const trialActiveCount = users.filter(u => getTrialInfo(u.freeTrialUntil).status === "active").length;
  const subscribedCount = users.filter(u => u.subscriptionStatus === "active").length;

  const trialPanelRef = useDialogA11y<HTMLDivElement>(!!editingTrialUser, () => setEditingTrialUser(null));
  const subscriptionPanelRef = useDialogA11y<HTMLDivElement>(!!editingSubscriptionUser, () => setEditingSubscriptionUser(null));
  const namePanelRef = useDialogA11y<HTMLDivElement>(!!editingNameUser, () => { setEditingNameUser(null); setNameInput(""); });
  const passwordPanelRef = useDialogA11y<HTMLDivElement>(!!editingPasswordUser, () => setEditingPasswordUser(null));

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
          <span className="text-[10px] text-ink-soft font-bold uppercase tracking-wider block">Cadastrados</span>
          <span className="text-lg font-display font-bold text-brand-teal">{users.length}</span>
        </div>
        <div className="bg-white border border-brand-cream-darker rounded-2xl p-3 text-center">
          <span className="text-[10px] text-ink-soft font-bold uppercase tracking-wider block">Ativos</span>
          <span className="text-lg font-display font-bold text-success-600">{activeCount}</span>
        </div>
        <div className="bg-white border border-brand-cream-darker rounded-2xl p-3 text-center">
          <span className="text-[10px] text-ink-soft font-bold uppercase tracking-wider block">Assinantes</span>
          <span className="text-lg font-display font-bold text-warning-600">{subscribedCount}</span>
        </div>
      </div>

      {/* O "Simulador de Perfis" foi REMOVIDO de propósito. Ele entrava na
          sessão de qualquer usuário, o que com contas reais significa abrir
          prontuário, medicamentos e receitas de terceiros sem consentimento —
          inaceitável num app de saúde (LGPD). Não reintroduzir: para testar
          permissões, use uma conta de teste própria em ambiente de dev. */}

      {/* Control Area */}
      <div className="space-y-4">
        {/* Search & Add Header */}
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-bold text-brand-teal uppercase tracking-wider flex items-center gap-1.5">
              Usuários Registrados ({filteredUsers.length})
            </h3>
            {/* Sem botão "Novo Usuário": as contas nascem do cadastro do próprio
                usuário no app (Firebase Auth). O botão antigo criava um registro
                apenas local, sem conta de login, que sumia no próximo
                carregamento assim que a lista passou a vir do Firestore. */}
          </div>

          <div className="relative">
            <Search className="absolute left-3 top-2.5 w-4 h-4 text-ink-soft" />
            <input
              type="text"
              placeholder="Buscar por nome ou e-mail..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-white border border-brand-cream-darker rounded-xl pl-9 pr-4 py-2 text-xs text-brand-teal focus:outline focus:outline-2 focus:outline-offset-1 focus:outline-brand-coral focus:border-brand-coral font-sans"
            />
          </div>
        </div>

        {/* Registered Users List */}
        <div className="space-y-3">
          {filteredUsers.length === 0 ? (
            <div className="bg-white border border-brand-cream-darker rounded-3xl p-8 text-center text-ink-soft">
              <AlertCircle className="w-8 h-8 mx-auto mb-2 text-gray-300" />
              <p className="text-xs font-semibold">Nenhum usuário correspondente.</p>
            </div>
          ) : (
            filteredUsers.map((u) => {
              const isSuspended = u.status === "suspended";
              const isAdmin = u.role === "admin";
              const trial = getTrialInfo(u.freeTrialUntil);
              // O acesso REAL vem da data (subscriptionCurrentPeriodEnd via
              // getAccessState), não do rótulo subscriptionStatus — os dois
              // podem divergir se um pagamento foi reconciliado à mão antes
              // desta correção, ou se o período simplesmente já venceu.
              const accessState = getAccessState(u);
              const hasActiveSub = accessState === "active" || accessState === "grace";

              return (
                <div
                  key={u.userId}
                  id={`user-row-${u.userId}`}
                  className={`rounded-2xl p-4 border transition-all space-y-3 ${
                    isSuspended 
                      ? "bg-error-50/40 border-error-100 opacity-80" 
                      : "bg-white border-brand-cream-darker shadow-2xs"
                  }`}
                >
                  {/* Top line identity */}
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <h4 className="text-sm font-bold text-brand-teal leading-tight">{u.name}</h4>
                        <button
                          onClick={() => {
                            setEditingNameUser(u);
                            setNameInput(u.name);
                          }}
                          className="p-0.5 rounded-md text-ink-soft hover:text-brand-teal hover:bg-brand-cream transition-colors"
                          title="Editar Nome"
                        >
                          <Pencil className="w-3 h-3" />
                        </button>
                        {isAdmin && (
                          <span className="text-[10px] font-extrabold bg-brand-coral/15 text-brand-coral px-1.5 py-0.5 rounded-sm uppercase tracking-wider">
                            Admin
                          </span>
                        )}
                        <span
                          className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full uppercase tracking-wide ${
                            isSuspended ? "bg-error-100 text-error-600" : "bg-success-100 text-success-600"
                          }`}
                        >
                          {isSuspended ? "Bloqueado" : "Ativo"}
                        </span>
                      </div>
                      <p className="text-xs text-ink-soft font-mono mt-0.5">{u.email}</p>
                    </div>

                    {/* Quick switch roles & delete actions */}
                    <div className="flex items-center space-x-1">
                      {/* Role is READ-ONLY here. The old "Promover" button only
                          flipped this Firestore field, which grants nothing —
                          authorization comes exclusively from the `admin`
                          custom claim (firestore.rules / Admin Portal login).
                          Clicking it looked like it promoted someone and did
                          not. Granting admin is a deliberate operator action:
                          `node server/setAdminClaim.js <email>`. */}
                      {isAdmin && (
                        <span
                          className="p-1 rounded-md border text-xs font-bold bg-brand-coral-light/10 text-brand-coral border-brand-coral/10"
                          title="Papel definido pela custom claim do Firebase (server/setAdminClaim.js)"
                        >
                          Admin
                        </span>
                      )}

                      {/* Delete user */}
                      <button
                        onClick={() => {
                          // Protege qualquer conta que seja admin, em vez de um
                          // e-mail fixo no código (que ficou obsoleto assim que
                          // o admin do app mudou). Remover o próprio cadastro
                          // também é bloqueado em App.tsx.
                          if (isAdmin) {
                            onNotify("Não é possível remover uma conta de administrador pelo painel.");
                            return;
                          }
                          setConfirmDialog({
                            title: "Excluir usuário definitivamente",
                            message: `Excluir ${u.name} (${u.email})? Isso apaga a conta de login e TODOS os dados: pacientes monitorados, receitas, medicamentos, histórico de doses, consultas, farmácias e cupons. Essa ação não pode ser desfeita.`,
                            onConfirm: async () => {
                              await onDeleteUser(u.userId);
                              setConfirmDialog(null);
                            },
                          });
                        }}
                        className="p-1 rounded-md border border-error-100 bg-error-50 text-error-500 hover:bg-error-600 hover:text-white transition-all"
                        title="Excluir Usuário"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  {/* Divider line */}
                  <div className="border-t border-brand-cream-darker/60 my-1"></div>

                  {/* Core Platform Management (Trial & Subscription Details) */}
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    {/* Trial Status Section */}
                    <div className="bg-brand-cream/40 rounded-xl p-3 border border-brand-cream-darker/50 space-y-1">
                      <div className="flex items-center gap-1 text-brand-teal font-semibold">
                        <Gift className="w-3.5 h-3.5 text-brand-coral shrink-0" />
                        <span>Gratuidade / Teste</span>
                      </div>
                      {/* Um assinante em dia aparecia aqui em vermelho como
                          "Expirado" — tecnicamente verdade sobre o campo, mas
                          lido como "sem acesso". O que vale é o estado real. */}
                      <div className="text-xs text-ink-soft leading-relaxed">
                        Status: <strong className={hasActiveSub ? "text-ink-soft" : trial.status === "active" ? "text-success-600" : "text-error-500"}>
                          {hasActiveSub ? "Coberto pela assinatura" : trial.status === "active" ? "Válido" : "Expirado"}
                        </strong>
                        <div className="truncate text-ink-soft mt-0.5">{trial.text}</div>
                      </div>
                      <button
                        onClick={() => setEditingTrialUser(u)}
                        className="w-full mt-1.5 bg-white border border-brand-cream-darker hover:bg-brand-peach text-xs font-bold text-brand-teal uppercase rounded-lg py-1.5 transition-colors"
                      >
                        Conceder Gratuidade
                      </button>
                    </div>

                    {/* Subscription Section */}
                    <div className="bg-brand-cream/40 rounded-xl p-3 border border-brand-cream-darker/50 space-y-1">
                      <div className="flex items-center gap-1 text-brand-teal font-semibold">
                        <CreditCard className="w-3.5 h-3.5 text-brand-teal shrink-0" />
                        <span>Assinatura</span>
                      </div>
                      <div className="text-xs text-ink-soft leading-relaxed">
                        Acesso real: <strong className={hasActiveSub ? "text-success-600" : "text-ink-soft"}>
                          {accessState === "active" ? "Ativa" : accessState === "grace" ? "Carência" : accessState === "trial" ? "Trial" : "Bloqueada"}
                        </strong>
                        <div className="truncate text-ink-soft mt-0.5">
                          Plano: <span className="capitalize font-semibold text-brand-teal">{u.subscriptionPlan || "Nenhum"}</span>
                        </div>
                        {hasActiveSub && u.subscriptionCurrentPeriodEnd && (
                          <div className="truncate text-ink-soft mt-0.5">
                            Válida até {formatDateString(u.subscriptionCurrentPeriodEnd)}
                          </div>
                        )}
                      </div>
                      <button
                        onClick={() => {
                          setEditingSubscriptionUser(u);
                          setSubStatus(u.subscriptionStatus || 'inactive');
                          setSubPlan(u.subscriptionPlan || 'none');
                        }}
                        className="w-full mt-1.5 bg-white border border-brand-cream-darker hover:bg-brand-peach text-xs font-bold text-brand-teal uppercase rounded-lg py-1.5 transition-colors"
                      >
                        Gerenciar
                      </button>
                    </div>
                  </div>

                  {/* Trial Scan Limit Section (Gemini cost protection) */}
                  <div className="bg-brand-cream/40 rounded-xl p-3 border border-brand-cream-darker/50 flex items-center justify-between gap-2 text-xs">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1 text-brand-teal font-semibold">
                        <Award className="w-3.5 h-3.5 text-brand-coral shrink-0" />
                        <span>Limite de Scans Gratuitos</span>
                      </div>
                      {/* A cota só existe para quem está em gratuidade/trial:
                          assinante pago e isento escaneiam à vontade, e mostrar
                          "1/3" para eles sugeria um limite que não se aplica. */}
                      <div className="text-xs text-ink-soft mt-1 leading-relaxed">
                        {hasActiveSub ? (
                          <span>Sem limite — assinatura paga vigente.</span>
                        ) : u.scanLimitExempt ? (
                          <span>Sem limite — <span className="text-success-600 font-bold">isento pelo admin</span>.</span>
                        ) : (
                          <>
                            Receita: <strong>{u.trialPrescriptionScansUsed || 0}/{TRIAL_SCAN_LIMIT}</strong> · Nota: <strong>{u.trialReceiptScansUsed || 0}/{TRIAL_SCAN_LIMIT}</strong>
                          </>
                        )}
                      </div>
                    </div>
                    <button
                      onClick={() => handleToggleScanExempt(u)}
                      className={`shrink-0 text-xs font-bold uppercase rounded-lg px-2.5 py-1.5 border transition-colors ${
                        u.scanLimitExempt
                          ? "bg-success-50 text-success-600 border-success-200 hover:bg-success-100"
                          : "bg-white text-brand-teal border-brand-cream-darker hover:bg-brand-peach"
                      }`}
                    >
                      {u.scanLimitExempt ? "Remover Isenção" : "Isentar do Limite"}
                    </button>
                  </div>

                  {/* Actions Bar (Password edit & Activation Status) */}
                  <div className="flex items-center gap-1.5 pt-1">
                    {/* Alterar Senha Button */}
                    <button
                      onClick={() => {
                        setEditingPasswordUser(u);
                        setNewPassword("");
                      }}
                      className="flex-1 bg-brand-cream-dark text-brand-teal hover:bg-brand-peach border border-brand-cream-darker rounded-xl py-1.5 text-xs font-bold uppercase tracking-wider flex items-center justify-center gap-1 transition-colors"
                    >
                      <Lock className="w-3.5 h-3.5 text-brand-teal" /> Alterar Senha
                    </button>

                    {/* Ativar/Desativar Button */}
                    <button
                      onClick={() => handleToggleStatus(u)}
                      className={`flex-1 rounded-xl py-1.5 text-xs font-bold uppercase tracking-wider flex items-center justify-center gap-1 transition-all ${
                        isSuspended
                          ? "bg-success-50 text-success-600 border border-success-200 hover:bg-success-100"
                          : "bg-error-50 text-error-500 border border-error-100 hover:bg-error-100"
                      }`}
                    >
                      {isSuspended ? (
                        <>
                          <UserCheck className="w-3.5 h-3.5 text-success-600" /> Ativar Usuário
                        </>
                      ) : (
                        <>
                          <UserX className="w-3.5 h-3.5 text-error-500" /> Desativar Conta
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
          <div
            ref={trialPanelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="trial-modal-title"
            tabIndex={-1}
            className="bg-brand-cream rounded-3xl max-w-sm w-full p-6 shadow-xl border border-brand-cream-darker animate-scale-up"
          >
            <div className="w-10 h-10 rounded-full bg-brand-peach text-brand-coral flex items-center justify-center mx-auto mb-3">
              <Gift className="w-5 h-5" />
            </div>

            <h3 id="trial-modal-title" className="text-base font-display font-bold text-brand-teal text-center mb-1">
              Conceder Período de Gratuidade
            </h3>
            <p className="text-[11px] text-ink-soft text-center mb-4 leading-tight">
              Apenas para o usuário <strong className="text-brand-teal">{editingTrialUser.name}</strong>.<br />
              É esta a forma de liberar acesso de cortesia: o período é acrescentado à
              validade atual ou contado a partir de hoje.
            </p>

            <form onSubmit={handleTrialSubmit} className="space-y-4">
              <div>
                <label htmlFor="trial-days" className="block text-xs font-bold text-brand-teal mb-1 uppercase tracking-wider">
                  Dias de Gratuidade a Conceder
                </label>
                <select
                  id="trial-days"
                  value={daysToGrant}
                  onChange={(e) => setDaysToGrant(e.target.value)}
                  className="w-full bg-white border border-brand-cream-darker rounded-xl px-3 py-2 text-sm text-brand-teal focus:outline focus:outline-2 focus:outline-offset-1 focus:outline-brand-coral"
                >
                  <option value="7">7 Dias Grátis (Semana)</option>
                  <option value="15">15 Dias Grátis (Quinzena)</option>
                  <option value="30">30 Dias Grátis (1 Mês)</option>
                  <option value="90">90 Dias Grátis (3 Meses)</option>
                  <option value="180">180 Dias Grátis (Semestre)</option>
                  <option value="365">365 Dias Grátis (1 Ano)</option>
                </select>
              </div>

              <div className="bg-white rounded-xl p-3 border border-brand-cream-darker text-[10px] text-ink-soft space-y-1">
                {/* Estado REAL (getAccessState), não só a data do trial: é ele
                    que decide se os scanners abrem no app do usuário. */}
                <div>
                  Acesso Atual:{" "}
                  <strong className="text-brand-teal">
                    {{ active: "Assinatura ativa", grace: "Carência", trial: "Gratuidade válida", blocked: "Bloqueado" }[getAccessState(editingTrialUser)]}
                  </strong>
                </div>
                <div>Expiração da Gratuidade: <strong className="text-brand-teal">{formatDateString(editingTrialUser.freeTrialUntil)}</strong> ({getTrialInfo(editingTrialUser.freeTrialUntil).text})</div>
                <div className="pt-1 border-t border-brand-cream-darker/60 text-brand-teal">
                  Também zera os scans gratuitos já usados (Receita{" "}
                  {editingTrialUser.trialPrescriptionScansUsed || 0}/{TRIAL_SCAN_LIMIT} → 0/{TRIAL_SCAN_LIMIT} · Nota{" "}
                  {editingTrialUser.trialReceiptScansUsed || 0}/{TRIAL_SCAN_LIMIT} → 0/{TRIAL_SCAN_LIMIT}).
                </div>
              </div>

              <div className="flex space-x-2 pt-2">
                <button
                  type="button"
                  onClick={() => setEditingTrialUser(null)}
                  className="flex-1 border border-brand-cream-darker text-ink-soft rounded-xl py-2.5 text-xs font-semibold hover:bg-gray-50 transition-all"
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
          <div
            ref={subscriptionPanelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="subscription-modal-title"
            tabIndex={-1}
            className="bg-brand-cream rounded-3xl max-w-sm w-full p-6 shadow-xl border border-brand-cream-darker animate-scale-up"
          >
            <div className="w-10 h-10 rounded-full bg-teal-50 text-brand-teal flex items-center justify-center mx-auto mb-3 border border-brand-teal/10">
              <CreditCard className="w-5 h-5 text-brand-teal" />
            </div>

            <h3 id="subscription-modal-title" className="text-base font-display font-bold text-brand-teal text-center mb-1">
              Assinatura Paga do Usuário
            </h3>
            <p className="text-[11px] text-ink-soft text-center mb-4">
              Reconcilia o pagamento de <strong className="text-brand-teal">{editingSubscriptionUser.name}</strong> —
              não é aqui que se concede cortesia.
            </p>

            <form onSubmit={handleSubscriptionSubmit} className="space-y-4">
              <div>
                <label htmlFor="sub-status" className="block text-xs font-bold text-brand-teal mb-1 uppercase tracking-wider">
                  Status da Assinatura
                </label>
                <select
                  id="sub-status"
                  value={subStatus}
                  onChange={(e) => setSubStatus(e.target.value as any)}
                  className="w-full bg-white border border-brand-cream-darker rounded-xl px-3 py-2 text-sm text-brand-teal focus:outline focus:outline-2 focus:outline-offset-1 focus:outline-brand-coral"
                >
                  <option value="active">Ativa (Acesso Liberado)</option>
                  <option value="inactive">Inativa / Cancelada</option>
                  <option value="expired">Expirada / Sem Pagamento</option>
                </select>
              </div>

              <div>
                <label htmlFor="sub-plan" className="block text-xs font-bold text-brand-teal mb-1 uppercase tracking-wider">
                  Plano Contratado
                </label>
                <select
                  id="sub-plan"
                  value={subPlan}
                  onChange={(e) => setSubPlan(e.target.value as 'monthly' | 'yearly' | 'none')}
                  className="w-full bg-white border border-brand-cream-darker rounded-xl px-3 py-2 text-sm text-brand-teal focus:outline focus:outline-2 focus:outline-offset-1 focus:outline-brand-coral"
                >
                  <option value="none">Nenhum Plano Ativo</option>
                  <option value="monthly">Plano Mensal (Recorrente)</option>
                  <option value="yearly">Plano Anual (Premium)</option>
                </select>
              </div>

              <div className="bg-white rounded-xl p-3 border border-brand-cream-darker text-[10px] text-ink-soft leading-snug space-y-1">
                {subStatus === "active" ? (
                  <>
                    <p className="text-brand-teal font-bold uppercase tracking-wider text-[10px]">
                      Registrar pagamento aprovado
                    </p>
                    <p>
                      Use apenas para reconciliar um pagamento aprovado no Mercado Pago que não ativou
                      sozinho — confira o valor/ID do pagamento no painel deles antes de salvar. Para
                      liberar acesso de cortesia, use <strong className="text-brand-teal">Conceder Gratuidade</strong>.
                    </p>
                    <p>
                      Período concedido:{" "}
                      <strong className="text-brand-teal">
                        {subPlan === "none" ? "escolha o plano acima" : `${PLANS[subPlan as PlanId].days} dias (${PLANS[subPlan as PlanId].label})`}
                      </strong>
                      , somado ao que ainda restar.
                      {editingSubscriptionUser.subscriptionCurrentPeriodEnd && (
                        <> Válido atualmente até {formatDateString(editingSubscriptionUser.subscriptionCurrentPeriodEnd)}.</>
                      )}
                    </p>
                  </>
                ) : (
                  <p>
                    Salvar com este status <strong className="text-brand-teal">encerra o período pago</strong> deste
                    usuário imediatamente. Isso não mexe na gratuidade: se ela ainda estiver válida, o acesso
                    continua liberado por ela.
                  </p>
                )}
              </div>

              <div className="flex space-x-2 pt-2">
                <button
                  type="button"
                  onClick={() => setEditingSubscriptionUser(null)}
                  className="flex-1 border border-brand-cream-darker text-ink-soft rounded-xl py-2.5 text-xs font-semibold hover:bg-gray-50 transition-all"
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

      {/* MODAL: Editar Nome */}
      {editingNameUser && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 backdrop-blur-xs">
          <div
            ref={namePanelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="name-modal-title"
            tabIndex={-1}
            className="bg-brand-cream rounded-3xl max-w-sm w-full p-6 shadow-xl border border-brand-cream-darker animate-scale-up"
          >
            <div className="w-10 h-10 rounded-full bg-brand-teal-pale text-brand-teal flex items-center justify-center mx-auto mb-3 border border-brand-cream-darker">
              <Pencil className="w-5 h-5 text-brand-teal" />
            </div>

            <h3 id="name-modal-title" className="text-base font-display font-bold text-brand-teal text-center mb-1">
              Editar Nome do Usuário
            </h3>
            <p className="text-[11px] text-ink-soft text-center mb-4">
              Corrige o nome exibido para <strong className="text-brand-teal">{editingNameUser.email}</strong>. Isso atualiza o perfil real no Firestore.
            </p>

            <form onSubmit={handleNameSubmit} className="space-y-4">
              <div>
                <label htmlFor="admin-edit-name" className="block text-xs font-bold text-brand-teal mb-1 uppercase tracking-wider">
                  Nome Completo
                </label>
                <input
                  id="admin-edit-name"
                  type="text"
                  required
                  placeholder="Nome do usuário"
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  className="w-full bg-white border border-brand-cream-darker rounded-xl px-3 py-2 text-sm text-brand-teal focus:outline focus:outline-2 focus:outline-offset-1 focus:outline-brand-coral text-center font-sans"
                />
              </div>

              <div className="flex space-x-2 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    setEditingNameUser(null);
                    setNameInput("");
                  }}
                  className="flex-1 border border-brand-cream-darker text-ink-soft rounded-xl py-2.5 text-xs font-semibold hover:bg-gray-50 transition-all"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={isSubmittingName}
                  className="flex-1 bg-brand-teal text-brand-cream rounded-xl py-2.5 text-xs font-semibold hover:bg-brand-teal-light transition-all shadow-md disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isSubmittingName ? "Salvando..." : "Salvar Nome"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: Alterar Senha */}
      {editingPasswordUser && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 backdrop-blur-xs">
          <div
            ref={passwordPanelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="password-modal-title"
            tabIndex={-1}
            className="bg-brand-cream rounded-3xl max-w-sm w-full p-6 shadow-xl border border-brand-cream-darker animate-scale-up"
          >
            <div className="w-10 h-10 rounded-full bg-warning-50 text-warning-600 flex items-center justify-center mx-auto mb-3 border border-warning-100">
              <Key className="w-5 h-5 text-warning-600" />
            </div>

            <h3 id="password-modal-title" className="text-base font-display font-bold text-brand-teal text-center mb-1">
              Alterar Senha do Usuário
            </h3>
            <p className="text-[11px] text-ink-soft text-center mb-4">
              Defina uma nova senha de login para <strong className="text-brand-teal">{editingPasswordUser.name}</strong>. Isso altera a conta real no Firebase Auth.
            </p>

            <form onSubmit={handlePasswordSubmit} className="space-y-4">
              <div>
                <label htmlFor="admin-new-password" className="block text-xs font-bold text-brand-teal mb-1 uppercase tracking-wider">
                  Nova Senha de Acesso
                </label>
                <input
                  id="admin-new-password"
                  type="text"
                  required
                  placeholder="Mínimo 6 caracteres"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="w-full bg-white border border-brand-cream-darker rounded-xl px-3 py-2 text-sm text-brand-teal focus:outline focus:outline-2 focus:outline-offset-1 focus:outline-brand-coral text-center font-mono"
                />
              </div>

              <div className="flex space-x-2 pt-2">
                <button
                  type="button"
                  onClick={() => setEditingPasswordUser(null)}
                  className="flex-1 border border-brand-cream-darker text-ink-soft rounded-xl py-2.5 text-xs font-semibold hover:bg-gray-50 transition-all"
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

