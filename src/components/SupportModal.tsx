import React, { useState } from "react";
import { X, CheckCircle2, HelpCircle, Loader2 } from "lucide-react";
import { useDialogA11y } from "../hooks/useDialogA11y";
import type { User } from "../types";

const SUPPORT_WEBHOOK_URL = "https://magenta-deer-711155.hostingersite.com/webhook/helpdesk-triagem";

interface SupportModalProps {
  user: User;
  onClose: () => void;
}

type Status = "idle" | "enviando" | "erro" | "enviado";

export default function SupportModal({ user, onClose }: SupportModalProps) {
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const panelRef = useDialogA11y<HTMLDivElement>(true, onClose);

  const isMessageValid = message.trim().length >= 10;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isMessageValid || status === "enviando") return;

    setStatus("enviando");
    try {
      const res = await fetch(SUPPORT_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          appSource: "HoraCerta-AI",
          userId: user.userId ?? null,
          userName: user.name ?? null,
          userEmail: user.email,
          message: message.trim(),
          metadata: {
            currentRoute: window.location.pathname,
            userAgent: navigator.userAgent,
            appVersion: "1.0.0",
            timestamp: new Date().toISOString(),
          },
        }),
      });
      if (!res.ok) throw new Error(`Webhook respondeu ${res.status}`);
      setStatus("enviado");
    } catch {
      setStatus("erro");
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4 backdrop-blur-xs animate-fade-in"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="support-modal-title"
        tabIndex={-1}
        className="bg-brand-cream rounded-3xl max-w-md w-full p-6 shadow-xl border border-brand-cream-darker animate-scale-up"
        onClick={(e) => e.stopPropagation()}
      >
        {status === "enviado" ? (
          <div className="text-center py-4">
            <div className="w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-4 bg-success-50 text-success-600">
              <CheckCircle2 className="w-6 h-6" />
            </div>
            <h3 className="text-lg font-display font-bold text-brand-teal mb-1">
              Mensagem enviada!
            </h3>
            <p className="text-xs text-ink-soft mb-6 leading-relaxed">
              Obrigado pelo contato. Nossa equipe vai analisar sua mensagem e retornar se
              necessário.
            </p>
            <button
              onClick={onClose}
              className="w-full py-3 rounded-xl bg-brand-teal hover:bg-brand-teal-dark text-white text-xs font-bold transition-all shadow-xs"
            >
              Concluir
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-brand-peach text-brand-coral rounded-xl flex items-center justify-center shrink-0">
                  <HelpCircle className="w-5 h-5" />
                </div>
                <div>
                  <h3 id="support-modal-title" className="text-base font-display font-bold text-brand-teal">
                    Suporte e Feedback
                  </h3>
                  <p className="text-[11px] text-ink-soft font-sans mt-0.5">
                    Reporte um problema ou envie sua sugestão
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Fechar"
                className="w-10 h-10 shrink-0 rounded-full flex items-center justify-center text-ink-soft hover:bg-brand-cream-darker transition-all"
              >
                <X className="w-4.5 h-4.5" />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label htmlFor="support-email" className="block text-[11px] font-bold text-brand-teal uppercase tracking-wider mb-1.5">
                  Seu e-mail
                </label>
                <input
                  id="support-email"
                  type="email"
                  value={user.email}
                  readOnly
                  disabled
                  className="w-full px-4 py-3 rounded-xl border border-brand-cream-darker bg-brand-cream-darker/40 text-sm text-ink-soft"
                />
              </div>

              <div>
                <label htmlFor="support-message" className="block text-[11px] font-bold text-brand-teal uppercase tracking-wider mb-1.5">
                  Mensagem
                </label>
                <textarea
                  id="support-message"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={5}
                  placeholder="Descreva o problema, dúvida ou sugestão..."
                  className="w-full px-4 py-3 rounded-xl border border-brand-cream-darker bg-white text-sm text-ink placeholder:text-ink-soft/60 focus:outline-none focus:ring-2 focus:ring-brand-coral resize-none"
                />
                <p className="text-[10px] text-ink-soft mt-1">Mínimo de 10 caracteres.</p>
              </div>

              {status === "erro" && (
                <p className="text-xs text-error-600 bg-error-50 rounded-xl px-4 py-3">
                  Não conseguimos enviar sua mensagem agora. Tente novamente em instantes.
                </p>
              )}

              <button
                type="submit"
                disabled={!isMessageValid || status === "enviando"}
                className="w-full py-3 rounded-xl bg-brand-teal hover:bg-brand-teal-dark disabled:opacity-40 disabled:hover:bg-brand-teal text-white text-xs font-bold transition-all shadow-xs flex items-center justify-center gap-2"
              >
                {status === "enviando" ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Enviando...
                  </>
                ) : (
                  "Enviar mensagem"
                )}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
