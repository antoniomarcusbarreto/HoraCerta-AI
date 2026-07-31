import React, { useState } from "react";
import { User } from "../types";
import { dbLocal } from "../dbLocalFallback";
import { auth, dbFirebase } from "../firebase";
import { normalizeEmail } from "../utils/normalizeEmail";
import { TRIAL_DAYS } from "../subscription";
import { reportLogin } from "../loginLog";
import { signInWithEmailAndPassword, createUserWithEmailAndPassword, updateProfile } from "firebase/auth";
import { 
  Mail, 
  Lock, 
  User as UserIcon, 
  Eye, 
  EyeOff, 
  Check, 
  X, 
  Sparkles, 
  Heart, 
  ArrowRight, 
  AlertCircle,
  Shield
} from "lucide-react";

interface AuthScreenProps {
  onLoginSuccess: (user: User) => void;
}

export default function AuthScreen({ onLoginSuccess }: AuthScreenProps) {
  // O CTA de cadastro da landing page aponta para /app#cadastro para já abrir
  // esta tela na aba de criar conta. O hash é limpo logo após a leitura (efeito
  // abaixo) para que um refresh não force a aba de novo se o usuário trocar.
  const [isLogin, setIsLogin] = useState(
    () => !window.location.hash.startsWith("#cadastro")
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // O #cadastro NÃO é apagado ao ser lido: na primeira visita o service worker
  // assume o controle e App.tsx recarrega a página (listener de
  // "controllerchange"). Se o hash sumisse antes disso, o reload cairia na aba
  // de login de novo. Ele é limpo apenas quando o usuário troca de aba à mão.
  // replaceState não dispara hashchange, então a detecção da rota /app/admin
  // em App.tsx não é afetada.
  const selectTab = (login: boolean) => {
    setIsLogin(login);
    setError(null);
    setSuccess(null);
    const desired = login ? window.location.pathname : `${window.location.pathname}#cadastro`;
    window.history.replaceState({}, "", desired);
  };

  // "Esqueci minha senha": o projeto não usa sendPasswordResetEmail do
  // Firebase (ver CLAUDE.md). Em vez disso: se nome+e-mail baterem com o
  // cadastro, um código de verificação é enviado para o PRÓPRIO e-mail
  // cadastrado (prova de acesso à caixa de entrada — nome sozinho é
  // adivinhável) e o usuário troca a senha ali mesmo. Se não baterem, o
  // usuário pode optar por notificar o administrador para verificação manual.
  const [forgotPasswordMode, setForgotPasswordMode] = useState(false);
  const [resetStage, setResetStage] = useState<"form" | "otp" | "unmatched" | "done">("form");
  const [resetName, setResetName] = useState("");
  const [resetEmail, setResetEmail] = useState("");
  const [resetCode, setResetCode] = useState("");
  const [resetNewPassword, setResetNewPassword] = useState("");
  const [resetConfirmPassword, setResetConfirmPassword] = useState("");
  const [isSubmittingReset, setIsSubmittingReset] = useState(false);
  const [isSubmittingConfirm, setIsSubmittingConfirm] = useState(false);
  const [resetInfo, setResetInfo] = useState<string | null>(null);

  const resetIsMinLength = resetNewPassword.length >= 6;
  const resetHasLetter = /[a-zA-Z]/.test(resetNewPassword);
  const resetHasNumber = /[0-9]/.test(resetNewPassword);
  const resetIsPasswordValid = resetIsMinLength && resetHasLetter && resetHasNumber;
  const resetPasswordsMatch = resetConfirmPassword.length > 0 && resetNewPassword === resetConfirmPassword;

  const exitForgotPasswordMode = () => {
    setForgotPasswordMode(false);
    setResetStage("form");
    setResetName("");
    setResetEmail("");
    setResetCode("");
    setResetNewPassword("");
    setResetConfirmPassword("");
    setResetInfo(null);
    setError(null);
    setSuccess(null);
  };

  // Password Complexity Validation Helpers
  const isMinLength = password.length >= 6;
  const hasLetter = /[a-zA-Z]/.test(password);
  const hasNumber = /[0-9]/.test(password);
  const isPasswordValid = isMinLength && hasLetter && hasNumber;

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    const trimmedEmail = normalizeEmail(email);
    const trimmedName = name.trim();

    if (!trimmedEmail || !password) {
      setError("Por favor, preencha todos os campos obrigatórios.");
      return;
    }

    try {
      if (isLogin) {
        // LOGIN LOGIC — relies exclusively on the Firebase Auth SDK/session.
        let firebaseUser: any = null;
        let userProfile: User | null = null;

        try {
          // 1. Authenticate via Firebase Auth
          const userCredential = await signInWithEmailAndPassword(auth, trimmedEmail, password);
          firebaseUser = userCredential.user;

          // 2. Load user profile from Firestore
          userProfile = await dbFirebase.getUser(firebaseUser.uid);
        } catch (authErr: any) {
          let msg = "E-mail ou senha incorretos.";
          if (authErr.code === "auth/invalid-email") msg = "E-mail inválido.";
          if (authErr.code === "auth/user-disabled") msg = "Esta conta foi desativada.";
          if (authErr.code === "auth/too-many-requests") msg = "Muitas tentativas. Tente novamente mais tarde.";
          setError(msg);
          return;
        }

        // 3. Handle Profile Creation fallback if authenticated but profile document is missing in Firestore
        if (firebaseUser && !userProfile) {
          const now = new Date();
          userProfile = {
            userId: firebaseUser.uid,
            name: firebaseUser.displayName || trimmedEmail.split("@")[0],
            email: trimmedEmail,
            role: "user",
            status: "active",
            createdAt: now.toISOString(),
            // Concede o mesmo trial de novos cadastros a perfis sem documento.
            freeTrialUntil: new Date(now.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000).toISOString(),
            subscriptionStatus: "inactive",
            subscriptionPlan: "none",
          };
          dbLocal.updateUser(userProfile);
        }

        if (userProfile && userProfile.status === "suspended") {
          setError("Sua conta está suspensa pelo Administrador.");
          return;
        }

        if (userProfile) {
          // 5. Trigger cloud synchronization down to local database
          await dbLocal.syncFromFirebase(userProfile.userId);

          firebaseUser.getIdToken().then((idToken: string) => reportLogin(idToken, userProfile!.name, userProfile!.email));

          setSuccess("Autenticado com sucesso! Carregando painel...");
          setTimeout(() => {
            onLoginSuccess(userProfile!);
          }, 1000);
        }
      } else {
        // REGISTRATION LOGIC
        if (!trimmedName) {
          setError("Por favor, informe seu nome.");
          return;
        }

        if (!isPasswordValid) {
          setError("A senha não atende aos requisitos de complexidade exigidos.");
          return;
        }

        // Pré-checagem no servidor: evita criar uma segunda conta Firebase
        // Auth para um e-mail que já existe (o SDK client-side rejeita isso
        // sozinho na maioria dos casos, mas essa é uma trava própria da
        // aplicação, sem depender de configuração do projeto Firebase).
        const checkResponse = await fetch("/api/auth/check-email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: trimmedEmail }),
        });
        const checkData = await checkResponse.json().catch(() => ({}));
        if (checkResponse.ok && checkData.available === false) {
          setError("Este e-mail já está cadastrado. Faça login ou use \"Esqueci minha senha\".");
          return;
        }

        // Create Firebase Auth Account
        const userCredential = await createUserWithEmailAndPassword(auth, trimmedEmail, password);
        const firebaseUser = userCredential.user;

        // Grava o nome também no próprio Firebase Auth (displayName). É uma
        // rede de segurança: se a escrita do perfil no Firestore abaixo falhar
        // por qualquer motivo, o fallback de login (que hoje recorre ao
        // prefixo do e-mail) recupera o nome real em vez de um placeholder.
        await updateProfile(firebaseUser, { displayName: trimmedName }).catch(() => {});

        // Create Firestore Profile Document — inicia o período de 7 dias grátis.
        const now = new Date();
        const newUser: User = {
          userId: firebaseUser.uid,
          name: trimmedName,
          email: trimmedEmail,
          role: "user",
          status: "active",
          createdAt: now.toISOString(),
          freeTrialUntil: new Date(now.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000).toISOString(),
          subscriptionStatus: "inactive",
          subscriptionPlan: "none",
        };

        // Aguarda a escrita real no Firestore antes de liberar o login: um
        // registro fire-and-forget podia ser interrompido por um fechamento
        // rápido do app (comum em PWA/mobile), deixando o documento do
        // usuário ausente e disparando o fallback de nome quebrado no login
        // seguinte.
        try {
          await dbFirebase.createUserProfile(newUser);
        } catch (err) {
          console.error("Erro ao criar perfil do usuário no Firestore:", err);
          setError("Conta criada, mas houve um problema ao salvar seu perfil. Tente fazer login novamente em instantes.");
          return;
        }
        dbLocal.setUserCache(newUser);

        firebaseUser.getIdToken().then((idToken: string) => reportLogin(idToken, newUser.name, newUser.email));

        setSuccess("Conta criada com sucesso! Carregando painel...");
        setTimeout(() => {
          onLoginSuccess(newUser);
        }, 2500);
      }
    } catch (err: any) {
      console.error("Auth submit error:", err);
      let errMsg = "Ocorreu um erro ao processar a solicitação.";
      if (err.code === "auth/email-already-in-use") errMsg = "Este e-mail já está em uso.";
      if (err.code === "auth/weak-password") errMsg = "A senha fornecida é muito fraca.";
      if (err.code === "auth/invalid-email") errMsg = "O e-mail informado é inválido.";
      setError(errMsg);
    }
  };

  const submitPasswordResetRequest = async (e: React.FormEvent | null, forceSend: boolean) => {
    e?.preventDefault();
    setError(null);
    setResetInfo(null);
    if (!forceSend) setSuccess(null);

    const trimmedName = resetName.trim();
    const trimmedResetEmail = normalizeEmail(resetEmail);

    if (!trimmedName || !trimmedResetEmail) {
      setError("Por favor, informe seu nome e o e-mail cadastrado.");
      return;
    }

    setIsSubmittingReset(true);
    try {
      const response = await fetch("/api/auth/request-password-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmedName, email: trimmedResetEmail, forceSend }),
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "Não foi possível enviar a solicitação.");
      }

      if (data.matched) {
        // Nome + e-mail confirmados: código de verificação a caminho do
        // próprio e-mail cadastrado.
        setResetEmail(trimmedResetEmail);
        setResetStage("otp");
        setSuccess(data.message);
      } else if (forceSend) {
        setResetStage("done");
        setSuccess(data.message);
      } else {
        setResetStage("unmatched");
        setResetInfo(data.message);
      }
    } catch (err: any) {
      setError(err.message || "Não foi possível enviar a solicitação. Tente novamente.");
    } finally {
      setIsSubmittingReset(false);
    }
  };

  const handleConfirmResetSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (!/^\d{6}$/.test(resetCode)) {
      setError("Informe o código de 6 dígitos enviado ao seu e-mail.");
      return;
    }
    if (!resetIsPasswordValid) {
      setError("A nova senha não atende aos requisitos de complexidade exigidos.");
      return;
    }
    if (!resetPasswordsMatch) {
      setError("As senhas informadas não conferem.");
      return;
    }

    setIsSubmittingConfirm(true);
    try {
      const response = await fetch("/api/auth/confirm-password-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: normalizeEmail(resetEmail),
          code: resetCode.trim(),
          newPassword: resetNewPassword,
        }),
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "Não foi possível redefinir a senha.");
      }

      setResetStage("done");
      setSuccess("Senha redefinida com sucesso! Você já pode entrar com a nova senha.");
      setResetCode("");
      setResetNewPassword("");
      setResetConfirmPassword("");
      setTimeout(() => {
        exitForgotPasswordMode();
        setIsLogin(true);
      }, 2500);
    } catch (err: any) {
      setError(err.message || "Não foi possível redefinir a senha. Tente novamente.");
    } finally {
      setIsSubmittingConfirm(false);
    }
  };

  return (
    <div className="min-h-screen bg-brand-cream text-brand-teal flex flex-col justify-center items-center px-4 py-8 select-none font-sans">
      <div className="w-full max-w-md lg:max-w-lg bg-white border border-brand-cream-darker rounded-[2.5rem] p-8 lg:p-10 shadow-xl relative overflow-hidden">
        {/* Subtle background circles for branding */}
        <div className="absolute top-0 right-0 w-32 h-32 bg-brand-peach/35 rounded-full translate-x-12 -translate-y-12" />
        <div className="absolute bottom-0 left-0 w-24 h-24 bg-brand-cream rounded-full -translate-x-8 translate-y-8" />

        {/* Brand Header */}
        <div className="text-center relative z-10 mb-8">
          <div className="w-14 h-14 bg-brand-peach text-brand-coral rounded-3xl flex items-center justify-center mx-auto mb-4 border border-brand-coral/15 shadow-sm">
            <Heart className="w-7 h-7 fill-brand-coral/10" />
          </div>
          <h1 className="text-3xl font-display font-bold text-brand-teal tracking-tight">
            Hora Certa
          </h1>
          <p className="text-xs text-gray-500 font-sans mt-1">
            Gestão inteligente de medicamentos e receitas médicas
          </p>
        </div>

        {/* Tab Buttons (Entrar vs Criar Conta) */}
        {!forgotPasswordMode && (
          <div className="flex bg-brand-cream p-1.5 rounded-2xl mb-6 relative z-10 border border-brand-cream-darker">
            <button
              type="button"
              onClick={() => selectTab(true)}
              className={`flex-1 py-2.5 rounded-xl text-xs font-bold transition-all ${
                isLogin
                  ? "bg-brand-teal text-brand-cream shadow-md"
                  : "text-brand-teal/70 hover:text-brand-teal"
              }`}
            >
              Entrar
            </button>
            <button
              type="button"
              onClick={() => selectTab(false)}
              className={`flex-1 py-2.5 rounded-xl text-xs font-bold transition-all ${
                !isLogin
                  ? "bg-brand-teal text-brand-cream shadow-md"
                  : "text-brand-teal/70 hover:text-brand-teal"
              }`}
            >
              Criar Conta
            </button>
          </div>
        )}

        {/* Notifications */}
        {error && (
          <div className="mb-4 bg-red-50 border border-red-100 text-red-700 text-xs rounded-2xl p-3.5 flex items-start gap-2.5 animate-fade-in">
            <AlertCircle className="w-4.5 h-4.5 shrink-0 text-red-500 mt-0.5" />
            <span className="font-sans leading-snug">{error}</span>
          </div>
        )}

        {success && (
          <div className="mb-4 bg-emerald-50 border border-emerald-100 text-emerald-700 text-xs rounded-2xl p-3.5 flex items-start gap-2.5 animate-fade-in">
            <Check className="w-4.5 h-4.5 shrink-0 text-emerald-500 mt-0.5 animate-bounce" />
            <span className="font-sans leading-snug font-semibold">{success}</span>
          </div>
        )}

        {resetInfo && (
          <div className="mb-4 bg-amber-50 border border-amber-100 text-amber-800 text-xs rounded-2xl p-3.5 flex items-start gap-2.5 animate-fade-in">
            <AlertCircle className="w-4.5 h-4.5 shrink-0 text-amber-500 mt-0.5" />
            <span className="font-sans leading-snug">{resetInfo}</span>
          </div>
        )}

        {/* Form */}
        {forgotPasswordMode ? (
          resetStage === "otp" ? (
            <form onSubmit={handleConfirmResetSubmit} className="space-y-4 relative z-10">
              <p className="text-xs text-gray-500 font-sans leading-snug -mt-1 mb-2">
                Código enviado para <span className="font-semibold text-brand-teal">{resetEmail}</span>. Informe-o
                abaixo junto com sua nova senha.
              </p>

              <div className="space-y-1.5">
                <label className="text-[11px] font-bold text-brand-teal uppercase tracking-wider block ml-1">
                  Código de Verificação
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  required
                  placeholder="000000"
                  value={resetCode}
                  onChange={(e) => setResetCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  className="w-full bg-brand-cream/40 border border-brand-cream-darker rounded-xl px-4 py-3 text-sm tracking-[0.3em] text-center text-brand-teal placeholder-gray-400 font-sans focus:outline-none focus:border-brand-teal/50 transition-all font-semibold"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-[11px] font-bold text-brand-teal uppercase tracking-wider block ml-1">
                  Nova Senha
                </label>
                <div className="relative">
                  <span className="absolute inset-y-0 left-0 pl-3.5 flex items-center text-gray-400">
                    <Lock className="w-4 h-4" />
                  </span>
                  <input
                    type={showPassword ? "text" : "password"}
                    required
                    placeholder="Crie uma senha forte"
                    value={resetNewPassword}
                    onChange={(e) => setResetNewPassword(e.target.value)}
                    className="w-full bg-brand-cream/40 border border-brand-cream-darker rounded-xl pl-10 pr-10 py-3 text-xs text-brand-teal placeholder-gray-400 font-sans focus:outline-none focus:border-brand-teal/50 transition-all font-medium"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute inset-y-0 right-0 pr-3.5 flex items-center text-gray-400 hover:text-brand-teal"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-[11px] font-bold text-brand-teal uppercase tracking-wider block ml-1">
                  Confirmar Nova Senha
                </label>
                <input
                  type={showPassword ? "text" : "password"}
                  required
                  placeholder="Repita a nova senha"
                  value={resetConfirmPassword}
                  onChange={(e) => setResetConfirmPassword(e.target.value)}
                  className="w-full bg-brand-cream/40 border border-brand-cream-darker rounded-xl px-4 py-3 text-xs text-brand-teal placeholder-gray-400 font-sans focus:outline-none focus:border-brand-teal/50 transition-all font-medium"
                />
              </div>

              {resetNewPassword.length > 0 && (
                <div className="bg-brand-cream/65 border border-brand-cream-darker rounded-2xl p-3.5 space-y-2 text-[11px] animate-fade-in font-sans">
                  <p className="font-semibold text-brand-teal/90 mb-1">Requisitos de Segurança da Senha:</p>
                  <div className="flex items-center gap-2">
                    {resetIsMinLength ? (
                      <span className="w-4 h-4 bg-emerald-100 text-emerald-700 rounded-full flex items-center justify-center shrink-0">
                        <Check className="w-3 h-3" />
                      </span>
                    ) : (
                      <span className="w-4 h-4 bg-red-100 text-red-600 rounded-full flex items-center justify-center shrink-0">
                        <X className="w-3 h-3" />
                      </span>
                    )}
                    <span className={resetIsMinLength ? "text-emerald-800" : "text-gray-500"}>Mínimo de 6 caracteres</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {resetHasLetter ? (
                      <span className="w-4 h-4 bg-emerald-100 text-emerald-700 rounded-full flex items-center justify-center shrink-0">
                        <Check className="w-3 h-3" />
                      </span>
                    ) : (
                      <span className="w-4 h-4 bg-red-100 text-red-600 rounded-full flex items-center justify-center shrink-0">
                        <X className="w-3 h-3" />
                      </span>
                    )}
                    <span className={resetHasLetter ? "text-emerald-800" : "text-gray-500"}>Pelo menos uma letra (A-Z, a-z)</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {resetHasNumber ? (
                      <span className="w-4 h-4 bg-emerald-100 text-emerald-700 rounded-full flex items-center justify-center shrink-0">
                        <Check className="w-3 h-3" />
                      </span>
                    ) : (
                      <span className="w-4 h-4 bg-red-100 text-red-600 rounded-full flex items-center justify-center shrink-0">
                        <X className="w-3 h-3" />
                      </span>
                    )}
                    <span className={resetHasNumber ? "text-emerald-800" : "text-gray-500"}>Pelo menos um número (0-9)</span>
                  </div>
                  {resetConfirmPassword.length > 0 && (
                    <div className="flex items-center gap-2">
                      {resetPasswordsMatch ? (
                        <span className="w-4 h-4 bg-emerald-100 text-emerald-700 rounded-full flex items-center justify-center shrink-0">
                          <Check className="w-3 h-3" />
                        </span>
                      ) : (
                        <span className="w-4 h-4 bg-red-100 text-red-600 rounded-full flex items-center justify-center shrink-0">
                          <X className="w-3 h-3" />
                        </span>
                      )}
                      <span className={resetPasswordsMatch ? "text-emerald-800" : "text-gray-500"}>As senhas conferem</span>
                    </div>
                  )}
                </div>
              )}

              <button
                type="submit"
                disabled={isSubmittingConfirm || !resetIsPasswordValid || !resetPasswordsMatch}
                className={`w-full font-display font-semibold text-xs py-3.5 rounded-xl text-brand-cream flex items-center justify-center gap-2 shadow-md transition-all active:scale-98 ${
                  isSubmittingConfirm || !resetIsPasswordValid || !resetPasswordsMatch
                    ? "bg-gray-300 cursor-not-allowed shadow-none"
                    : "bg-brand-coral hover:bg-brand-coral-light"
                }`}
              >
                {isSubmittingConfirm ? "Redefinindo..." : "Definir Nova Senha"}
                <ArrowRight className="w-4 h-4" />
              </button>

              <button
                type="button"
                disabled={isSubmittingReset}
                onClick={() => submitPasswordResetRequest(null, false)}
                className="w-full text-center text-xs font-bold text-brand-teal/60 hover:text-brand-teal transition-all"
              >
                {isSubmittingReset ? "Reenviando..." : "Reenviar código"}
              </button>

              <button
                type="button"
                onClick={exitForgotPasswordMode}
                className="w-full text-center text-xs font-bold text-brand-teal/40 hover:text-brand-teal transition-all"
              >
                Voltar para o login
              </button>
            </form>
          ) : resetStage === "done" ? (
            <div className="space-y-4 relative z-10">
              <button
                type="button"
                onClick={exitForgotPasswordMode}
                className="w-full font-display font-semibold text-xs py-3.5 rounded-xl text-brand-cream flex items-center justify-center gap-2 shadow-md transition-all active:scale-98 bg-brand-coral hover:bg-brand-coral-light"
              >
                Voltar para o login
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <form onSubmit={(e) => submitPasswordResetRequest(e, false)} className="space-y-4 relative z-10">
              <p className="text-xs text-gray-500 font-sans leading-snug -mt-1 mb-2">
                Informe seu nome e o e-mail cadastrado. Se os dados conferirem, enviamos um código de verificação
                para você redefinir a senha na hora.
              </p>

              <div className="space-y-1.5">
                <label className="text-[11px] font-bold text-brand-teal uppercase tracking-wider block ml-1">
                  Nome Completo
                </label>
                <div className="relative">
                  <span className="absolute inset-y-0 left-0 pl-3.5 flex items-center text-gray-400">
                    <UserIcon className="w-4 h-4" />
                  </span>
                  <input
                    type="text"
                    required
                    placeholder="Seu nome"
                    value={resetName}
                    onChange={(e) => {
                      setResetName(e.target.value);
                      setResetStage("form");
                      setResetInfo(null);
                    }}
                    className="w-full bg-brand-cream/40 border border-brand-cream-darker rounded-xl pl-10 pr-4 py-3 text-xs text-brand-teal placeholder-gray-400 font-sans focus:outline-none focus:border-brand-teal/50 transition-all font-medium"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-[11px] font-bold text-brand-teal uppercase tracking-wider block ml-1">
                  E-mail Cadastrado
                </label>
                <div className="relative">
                  <span className="absolute inset-y-0 left-0 pl-3.5 flex items-center text-gray-400">
                    <Mail className="w-4 h-4" />
                  </span>
                  <input
                    type="email"
                    required
                    placeholder="seu.email@exemplo.com"
                    value={resetEmail}
                    onChange={(e) => {
                      setResetEmail(e.target.value);
                      setResetStage("form");
                      setResetInfo(null);
                    }}
                    className="w-full bg-brand-cream/40 border border-brand-cream-darker rounded-xl pl-10 pr-4 py-3 text-xs text-brand-teal placeholder-gray-400 font-sans focus:outline-none focus:border-brand-teal/50 transition-all font-medium"
                  />
                </div>
              </div>

              {resetStage === "unmatched" ? (
                <button
                  type="button"
                  disabled={isSubmittingReset}
                  onClick={() => submitPasswordResetRequest(null, true)}
                  className={`w-full font-display font-semibold text-xs py-3.5 rounded-xl text-brand-cream flex items-center justify-center gap-2 shadow-md transition-all active:scale-98 ${
                    isSubmittingReset
                      ? "bg-gray-300 cursor-not-allowed shadow-none"
                      : "bg-brand-coral hover:bg-brand-coral-light"
                  }`}
                >
                  {isSubmittingReset ? "Enviando..." : "Enviar mesmo assim"}
                  <ArrowRight className="w-4 h-4" />
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={isSubmittingReset}
                  className={`w-full font-display font-semibold text-xs py-3.5 rounded-xl text-brand-cream flex items-center justify-center gap-2 shadow-md transition-all active:scale-98 ${
                    isSubmittingReset
                      ? "bg-gray-300 cursor-not-allowed shadow-none"
                      : "bg-brand-coral hover:bg-brand-coral-light"
                  }`}
                >
                  {isSubmittingReset ? "Verificando..." : "Verificar Dados"}
                  <ArrowRight className="w-4 h-4" />
                </button>
              )}

              <button type="button" onClick={exitForgotPasswordMode} className="w-full text-center text-xs font-bold text-brand-teal/60 hover:text-brand-teal transition-all">
                Voltar para o login
              </button>
            </form>
          )
        ) : (
        <form onSubmit={handleAuthSubmit} className="space-y-4 relative z-10">
          {/* Campo Nome (Only on Register) */}
          {!isLogin && (
            <div className="space-y-1.5">
              <label className="text-[11px] font-bold text-brand-teal uppercase tracking-wider block ml-1">
                Nome Completo
              </label>
              <div className="relative">
                <span className="absolute inset-y-0 left-0 pl-3.5 flex items-center text-gray-400">
                  <UserIcon className="w-4 h-4" />
                </span>
                <input
                  type="text"
                  required
                  placeholder="Seu nome"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full bg-brand-cream/40 border border-brand-cream-darker rounded-xl pl-10 pr-4 py-3 text-xs text-brand-teal placeholder-gray-400 font-sans focus:outline-none focus:border-brand-teal/50 transition-all font-medium"
                />
              </div>
            </div>
          )}

          {/* Campo Email */}
          <div className="space-y-1.5">
            <label className="text-[11px] font-bold text-brand-teal uppercase tracking-wider block ml-1">
              E-mail de Acesso
            </label>
            <div className="relative">
              <span className="absolute inset-y-0 left-0 pl-3.5 flex items-center text-gray-400">
                <Mail className="w-4 h-4" />
              </span>
              <input
                type="email"
                required
                placeholder="seu.email@exemplo.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full bg-brand-cream/40 border border-brand-cream-darker rounded-xl pl-10 pr-4 py-3 text-xs text-brand-teal placeholder-gray-400 font-sans focus:outline-none focus:border-brand-teal/50 transition-all font-medium"
              />
            </div>
          </div>

          {/* Campo Senha */}
          <div className="space-y-1.5">
            <label className="text-[11px] font-bold text-brand-teal uppercase tracking-wider block ml-1">
              Senha
            </label>
            <div className="relative">
              <span className="absolute inset-y-0 left-0 pl-3.5 flex items-center text-gray-400">
                <Lock className="w-4 h-4" />
              </span>
              <input
                type={showPassword ? "text" : "password"}
                required
                placeholder={isLogin ? "Sua senha de acesso" : "Crie uma senha forte"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-brand-cream/40 border border-brand-cream-darker rounded-xl pl-10 pr-10 py-3 text-xs text-brand-teal placeholder-gray-400 font-sans focus:outline-none focus:border-brand-teal/50 transition-all font-medium"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute inset-y-0 right-0 pr-3.5 flex items-center text-gray-400 hover:text-brand-teal"
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            {isLogin && (
              <button
                type="button"
                onClick={() => {
                  setForgotPasswordMode(true);
                  setResetStage("form");
                  setResetEmail(email);
                  setResetInfo(null);
                  setError(null);
                  setSuccess(null);
                }}
                className="text-[11px] font-bold text-brand-teal/60 hover:text-brand-teal transition-all ml-1"
              >
                Esqueci minha senha
              </button>
            )}
          </div>

          {/* Password Complexity checklist - displayed only on Sign Up (Register) */}
          {!isLogin && password.length > 0 && (
            <div className="bg-brand-cream/65 border border-brand-cream-darker rounded-2xl p-3.5 space-y-2 text-[11px] animate-fade-in font-sans">
              <p className="font-semibold text-brand-teal/90 mb-1">Requisitos de Segurança da Senha:</p>
              
              <div className="flex items-center gap-2">
                {isMinLength ? (
                  <span className="w-4 h-4 bg-emerald-100 text-emerald-700 rounded-full flex items-center justify-center shrink-0">
                    <Check className="w-3 h-3" />
                  </span>
                ) : (
                  <span className="w-4 h-4 bg-red-100 text-red-600 rounded-full flex items-center justify-center shrink-0">
                    <X className="w-3 h-3" />
                  </span>
                )}
                <span className={isMinLength ? "text-emerald-800" : "text-gray-500"}>
                  Mínimo de 6 caracteres
                </span>
              </div>

              <div className="flex items-center gap-2">
                {hasLetter ? (
                  <span className="w-4 h-4 bg-emerald-100 text-emerald-700 rounded-full flex items-center justify-center shrink-0">
                    <Check className="w-3 h-3" />
                  </span>
                ) : (
                  <span className="w-4 h-4 bg-red-100 text-red-600 rounded-full flex items-center justify-center shrink-0">
                    <X className="w-3 h-3" />
                  </span>
                )}
                <span className={hasLetter ? "text-emerald-800" : "text-gray-500"}>
                  Pelo menos uma letra (A-Z, a-z)
                </span>
              </div>

              <div className="flex items-center gap-2">
                {hasNumber ? (
                  <span className="w-4 h-4 bg-emerald-100 text-emerald-700 rounded-full flex items-center justify-center shrink-0">
                    <Check className="w-3 h-3" />
                  </span>
                ) : (
                  <span className="w-4 h-4 bg-red-100 text-red-600 rounded-full flex items-center justify-center shrink-0">
                    <X className="w-3 h-3" />
                  </span>
                )}
                <span className={hasNumber ? "text-emerald-800" : "text-gray-500"}>
                  Pelo menos um número (0-9)
                </span>
              </div>
            </div>
          )}

          {/* Submit Button */}
          <button
            type="submit"
            disabled={!isLogin && !isPasswordValid}
            className={`w-full font-display font-semibold text-xs py-3.5 rounded-xl text-brand-cream flex items-center justify-center gap-2 shadow-md transition-all active:scale-98 ${
              !isLogin && !isPasswordValid
                ? "bg-gray-300 cursor-not-allowed shadow-none"
                : "bg-brand-coral hover:bg-brand-coral-light"
            }`}
          >
            {isLogin ? "Acessar Sistema" : "Criar Minha Conta"}
            <ArrowRight className="w-4 h-4" />
          </button>
        </form>
        )}
      </div>
      <div className="mt-6 text-center relative z-10">
        <a
          href="/app/admin"
          onClick={(e) => {
            e.preventDefault();
            window.location.hash = "#/admin";
            window.dispatchEvent(new HashChangeEvent("hashchange"));
          }}
          className="text-xs font-bold text-brand-teal/50 hover:text-brand-teal transition-all inline-flex items-center gap-1.5"
        >
          <Shield className="w-3.5 h-3.5" />
          Acesso Administrativo
        </a>
      </div>
    </div>
  );
}
