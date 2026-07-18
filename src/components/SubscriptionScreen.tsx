import React, { useState, useEffect, useRef, useCallback } from "react";
import { User } from "../types";
import { auth } from "../firebase";
import { PLANS, PlanId, getAccessState, daysRemaining } from "../subscription";
import {
  ArrowLeft, Gift, CreditCard, QrCode, Copy, Check, ShieldCheck,
  Sparkles, Loader2, Clock, Lock, AlertTriangle,
} from "lucide-react";

interface SubscriptionScreenProps {
  user: User;
  onBack: () => void;
  /** Chamado após a confirmação do pagamento para o App re-sincronizar o usuário. */
  onSubscribed: () => void;
}

interface PixData {
  paymentId: string | number;
  qrCode: string | null;
  qrCodeBase64: string | null;
  ticketUrl: string | null;
  amount: number;
}

async function authedPost(path: string, body?: any): Promise<any> {
  const token = await auth.currentUser?.getIdToken();
  const res = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || "Não foi possível concluir a solicitação.");
  return data;
}

export default function SubscriptionScreen({ user, onBack, onSubscribed }: SubscriptionScreenProps) {
  const [view, setView] = useState<"plans" | "pix" | "success">("plans");
  const [selectedPlan, setSelectedPlan] = useState<PlanId>("monthly");
  const [loadingMethod, setLoadingMethod] = useState<null | "pix" | "card">(null);
  const [error, setError] = useState<string | null>(null);
  const [pix, setPix] = useState<PixData | null>(null);
  const [copied, setCopied] = useState(false);
  const [checking, setChecking] = useState(false);

  const state = getAccessState(user);
  const trialDays = daysRemaining(user.freeTrialUntil);

  // Poll for confirmation while the PIX QR is on screen.
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const checkStatus = useCallback(async (): Promise<boolean> => {
    try {
      const data = await authedPost("/api/subscription/sync");
      if (data?.accessState === "active") {
        setView("success");
        onSubscribed();
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }, [onSubscribed]);

  useEffect(() => {
    if (view !== "pix") return;
    pollRef.current = setInterval(() => { checkStatus(); }, 4000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [view, checkStatus]);

  const handlePix = async () => {
    setError(null);
    setLoadingMethod("pix");
    try {
      const data = await authedPost("/api/subscription/pix", { plan: selectedPlan });
      setPix(data as PixData);
      setView("pix");
    } catch (e: any) {
      setError(e?.message || "Falha ao gerar o PIX.");
    } finally {
      setLoadingMethod(null);
    }
  };

  const handleCard = async () => {
    setError(null);
    setLoadingMethod("card");
    try {
      const data = await authedPost("/api/subscription/checkout", { plan: selectedPlan });
      if (data?.initPoint) {
        window.location.href = data.initPoint;
      } else {
        setError("Não foi possível abrir o checkout de cartão.");
      }
    } catch (e: any) {
      setError(e?.message || "Falha ao iniciar o pagamento com cartão.");
    } finally {
      setLoadingMethod(null);
    }
  };

  const handleCopy = async () => {
    if (!pix?.qrCode) return;
    try {
      await navigator.clipboard.writeText(pix.qrCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch { /* clipboard indisponível */ }
  };

  const handleManualCheck = async () => {
    setChecking(true);
    await checkStatus();
    setChecking(false);
  };

  // Banner contextual de estado atual
  const statusBanner = (() => {
    if (state === "trial") {
      return {
        icon: <Gift className="w-5 h-5 text-orange-600" />,
        cls: "bg-orange-50 border-orange-100 text-orange-800",
        text: `Você está no período gratuito — ${trialDays} ${trialDays === 1 ? "dia restante" : "dias restantes"}. Assine para não perder o acesso aos scanners.`,
      };
    }
    if (state === "grace") {
      return {
        icon: <Clock className="w-5 h-5 text-amber-600" />,
        cls: "bg-amber-50 border-amber-100 text-amber-800",
        text: "Sua assinatura venceu, mas você está nos 2 dias de bônus. Renove agora para não travar os scanners.",
      };
    }
    if (state === "blocked") {
      return {
        icon: <Lock className="w-5 h-5 text-red-600" />,
        cls: "bg-red-50 border-red-100 text-red-800",
        text: "Os scanners de receita e nota estão bloqueados. Assine para reativar a leitura inteligente.",
      };
    }
    return {
      icon: <ShieldCheck className="w-5 h-5 text-emerald-600" />,
      cls: "bg-emerald-50 border-emerald-100 text-emerald-800",
      text: "Sua assinatura está ativa. Você pode renovar antecipadamente — os dias são somados ao período atual.",
    };
  })();

  return (
    <div className="fixed inset-0 lg:left-24 z-[70] bg-brand-cream lg:bg-[#FAF6EC] text-brand-teal overflow-y-auto font-sans animate-fade-in">
      <div className="max-w-md lg:max-w-xl mx-auto px-4 py-6 lg:my-14 lg:bg-[#FDFBF5] lg:border lg:border-[#ECE6D8] lg:rounded-[28px] lg:p-10 lg:shadow-[0_2px_10px_rgba(0,0,0,0.03)]">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <button
            onClick={onBack}
            className="p-2 rounded-xl bg-white border border-brand-cream-darker text-brand-teal hover:bg-brand-peach transition-all shadow-sm active:scale-95"
            aria-label="Voltar"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h1 className="text-xl font-display font-bold text-brand-teal leading-tight">Hora Certa Premium</h1>
            <p className="text-[11px] text-gray-500">Leitura inteligente de receitas e notas</p>
          </div>
        </div>

        {view === "success" ? (
          <div className="bg-white border border-brand-cream-darker rounded-3xl p-8 text-center shadow-xs animate-scale-up">
            <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-emerald-50 border border-emerald-100 flex items-center justify-center">
              <Check className="w-8 h-8 text-emerald-600" />
            </div>
            <h2 className="text-lg font-display font-bold text-brand-teal">Assinatura confirmada!</h2>
            <p className="text-xs text-gray-500 mt-2 leading-relaxed">
              Pagamento aprovado. Seu acesso aos scanners já está liberado. Obrigado por cuidar da sua saúde com o Hora Certa.
            </p>
            <button
              onClick={onBack}
              className="mt-6 w-full bg-brand-coral hover:bg-brand-coral-light text-brand-cream font-display font-semibold text-sm py-3.5 rounded-xl shadow-md transition-all active:scale-98"
            >
              Voltar ao aplicativo
            </button>
          </div>
        ) : view === "pix" ? (
          <div className="bg-white border border-brand-cream-darker rounded-3xl p-6 shadow-xs space-y-4">
            <div className="flex items-center gap-2 text-brand-teal">
              <QrCode className="w-5 h-5 text-brand-coral" />
              <h2 className="text-sm font-display font-bold">Pague com PIX</h2>
            </div>
            <p className="text-[11px] text-gray-500 leading-relaxed">
              Escaneie o QR Code no app do seu banco ou copie o código. A confirmação é automática — pode levar alguns segundos.
            </p>

            {pix?.qrCodeBase64 ? (
              <div className="flex justify-center">
                <img
                  src={`data:image/png;base64,${pix.qrCodeBase64}`}
                  alt="QR Code PIX"
                  className="w-56 h-56 rounded-2xl border border-brand-cream-darker bg-white p-2"
                />
              </div>
            ) : (
              <div className="w-56 h-56 mx-auto rounded-2xl border border-dashed border-brand-cream-darker flex items-center justify-center text-gray-400 text-xs">
                QR Code indisponível — use o código abaixo
              </div>
            )}

            {pix?.qrCode && (
              <div className="space-y-2">
                <div className="bg-brand-cream/60 border border-brand-cream-darker rounded-xl p-3 text-[10px] text-gray-600 font-mono break-all max-h-24 overflow-y-auto">
                  {pix.qrCode}
                </div>
                <button
                  onClick={handleCopy}
                  className="w-full flex items-center justify-center gap-2 bg-brand-teal hover:bg-brand-teal-light text-brand-cream text-xs font-bold py-3 rounded-xl transition-all active:scale-98"
                >
                  {copied ? <><Check className="w-4 h-4" /> Código copiado!</> : <><Copy className="w-4 h-4" /> Copiar código PIX</>}
                </button>
              </div>
            )}

            <div className="flex items-center justify-center gap-2 text-[11px] text-brand-teal/70 pt-1">
              <Loader2 className="w-4 h-4 animate-spin" />
              Aguardando confirmação do pagamento...
            </div>

            <button
              onClick={handleManualCheck}
              disabled={checking}
              className="w-full border border-brand-cream-darker text-brand-teal text-xs font-bold py-3 rounded-xl hover:bg-brand-peach transition-all active:scale-98 disabled:opacity-60"
            >
              {checking ? "Verificando..." : "Já paguei, verificar agora"}
            </button>
            <button
              onClick={() => { setView("plans"); setPix(null); }}
              className="w-full text-[11px] text-gray-400 hover:text-brand-teal transition-all"
            >
              Escolher outro plano ou forma de pagamento
            </button>
          </div>
        ) : (
          <>
            {/* Status banner */}
            <div className={`flex items-start gap-2.5 rounded-2xl border p-3.5 mb-5 text-[11px] leading-snug ${statusBanner.cls}`}>
              <span className="shrink-0 mt-0.5">{statusBanner.icon}</span>
              <span className="font-medium">{statusBanner.text}</span>
            </div>

            {/* Plans */}
            <div className="space-y-3 mb-5">
              {(Object.keys(PLANS) as PlanId[]).map((planId) => {
                const plan = PLANS[planId];
                const selected = selectedPlan === planId;
                const monthlyEquivalent = planId === "yearly" ? (plan.amount / 12) : plan.amount;
                return (
                  <button
                    key={planId}
                    onClick={() => setSelectedPlan(planId)}
                    className={`w-full text-left rounded-2xl border-2 p-4 transition-all relative overflow-hidden ${
                      selected
                        ? "border-brand-coral bg-brand-peach/40 shadow-md"
                        : "border-brand-cream-darker bg-white hover:border-brand-coral/40"
                    }`}
                  >
                    {planId === "yearly" && (
                      <span className="absolute top-0 right-0 bg-brand-coral text-brand-cream text-[9px] font-bold px-2.5 py-1 rounded-bl-xl uppercase tracking-wide">
                        Melhor oferta
                      </span>
                    )}
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="text-sm font-display font-bold text-brand-teal">Plano {plan.label}</h3>
                        <p className="text-[10px] text-gray-500 mt-0.5">
                          {planId === "yearly"
                            ? `Equivale a R$ ${monthlyEquivalent.toFixed(2).replace(".", ",")}/mês`
                            : "Renovação a cada 30 dias"}
                        </p>
                      </div>
                      <div className="text-right">
                        <span className="text-lg font-display font-extrabold text-brand-coral">
                          R$ {plan.amount.toFixed(2).replace(".", ",")}
                        </span>
                        <p className="text-[9px] text-gray-400">{planId === "yearly" ? "por ano" : "por mês"}</p>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Benefits */}
            <div className="bg-white border border-brand-cream-darker rounded-2xl p-4 mb-5 space-y-2">
              {[
                "Scanner de receitas com IA",
                "Scanner de notas fiscais e controle de gastos",
                "Gestão de toda a família em uma conta",
                "Lembretes de dose ilimitados",
              ].map((b) => (
                <div key={b} className="flex items-center gap-2 text-[11px] text-brand-teal">
                  <Check className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                  {b}
                </div>
              ))}
            </div>

            {error && (
              <div className="mb-4 flex items-start gap-2 bg-red-50 border border-red-100 text-red-700 text-[11px] rounded-xl p-3">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            {/* Payment methods */}
            <div className="space-y-3">
              <button
                onClick={handlePix}
                disabled={!!loadingMethod}
                className="w-full flex items-center justify-center gap-2 bg-brand-coral hover:bg-brand-coral-light text-brand-cream font-display font-semibold text-sm py-3.5 rounded-xl shadow-md transition-all active:scale-98 disabled:opacity-60"
              >
                {loadingMethod === "pix" ? <Loader2 className="w-4 h-4 animate-spin" /> : <QrCode className="w-4 h-4" />}
                Pagar com PIX
                <span className="text-[10px] font-normal opacity-80">(instantâneo)</span>
              </button>
              <button
                onClick={handleCard}
                disabled={!!loadingMethod}
                className="w-full flex items-center justify-center gap-2 bg-white border-2 border-brand-teal text-brand-teal font-display font-semibold text-sm py-3.5 rounded-xl transition-all active:scale-98 hover:bg-brand-peach disabled:opacity-60"
              >
                {loadingMethod === "card" ? <Loader2 className="w-4 h-4 animate-spin" /> : <CreditCard className="w-4 h-4" />}
                Pagar com Cartão
              </button>
            </div>

            <p className="text-[10px] text-gray-400 text-center mt-4 leading-relaxed flex items-center justify-center gap-1">
              <ShieldCheck className="w-3.5 h-3.5" />
              Pagamento processado com segurança pelo Mercado Pago.
            </p>
            <div className="flex items-center justify-center gap-1.5 text-[10px] text-brand-teal/60 mt-2">
              <Sparkles className="w-3 h-3" />
              Cancele quando quiser — sem cobrança automática.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
