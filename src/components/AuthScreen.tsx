import React, { useState } from "react";
import { User } from "../types";
import { dbLocal } from "../dbLocalFallback";
import { auth, dbFirebase } from "../firebase";
import { signInWithEmailAndPassword, createUserWithEmailAndPassword } from "firebase/auth";
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
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Password Complexity Validation Helpers
  const isMinLength = password.length >= 6;
  const hasLetter = /[a-zA-Z]/.test(password);
  const hasNumber = /[0-9]/.test(password);
  const isPasswordValid = isMinLength && hasLetter && hasNumber;

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    const trimmedEmail = email.trim().toLowerCase();
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
          userProfile = {
            userId: firebaseUser.uid,
            name: firebaseUser.displayName || trimmedEmail.split("@")[0],
            email: trimmedEmail,
            role: "user",
            status: "active",
            createdAt: new Date().toISOString()
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

        // Create Firebase Auth Account
        const userCredential = await createUserWithEmailAndPassword(auth, trimmedEmail, password);
        const firebaseUser = userCredential.user;

        // Create Firestore Profile Document
        const newUser: User = {
          userId: firebaseUser.uid,
          name: trimmedName,
          email: trimmedEmail,
          role: "user",
          status: "active",
          createdAt: new Date().toISOString(),
        };

        // Write both locally and to Firestore
        dbLocal.updateUser(newUser);

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
        <div className="flex bg-brand-cream p-1.5 rounded-2xl mb-6 relative z-10 border border-brand-cream-darker">
          <button
            type="button"
            onClick={() => {
              setIsLogin(true);
              setError(null);
              setSuccess(null);
            }}
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
            onClick={() => {
              setIsLogin(false);
              setError(null);
              setSuccess(null);
            }}
            className={`flex-1 py-2.5 rounded-xl text-xs font-bold transition-all ${
              !isLogin 
                ? "bg-brand-teal text-brand-cream shadow-md" 
                : "text-brand-teal/70 hover:text-brand-teal"
            }`}
          >
            Criar Conta
          </button>
        </div>

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

        {/* Form */}
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
