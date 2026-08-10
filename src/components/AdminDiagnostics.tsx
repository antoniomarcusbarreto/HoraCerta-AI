import React, { useEffect, useState } from "react";
import { auth } from "../firebase";
import { AlertCircle, RefreshCw, CheckCircle2, XCircle, AlertTriangle, ServerCog } from "lucide-react";

// Espelha a resposta de GET /api/admin/diagnostics. Nenhum campo aqui é
// segredo: só presença (booleano), o prefixo do token do Mercado Pago e
// valores públicos como APP_URL.
interface Diagnostics {
  mercadoPago: {
    tokenConfigured: boolean;
    mode: "ausente" | "teste" | "producao" | "desconhecido";
    webhookSecretConfigured: boolean;
    paymentsCount: number | null;
    lastPaymentAt: string | null;
    lastWebhookError: { createdAt: string; message: string } | null;
  };
  email: { resendConfigured: boolean; fromAddress: string };
  gemini: { configured: boolean; model: string };
  push: { vapidConfigured: boolean; cronSecretConfigured: boolean; schedulerFlag: string };
  firebase: { databaseId: string; serviceAccountEnv: boolean };
  app: { appUrl: string; nodeEnv: string };
}

type Level = "ok" | "warn" | "bad";

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function Row({ level, label, value, hint }: { level: Level; label: string; value: string; hint?: string }) {
  const styles: Record<Level, { cls: string; icon: React.ReactNode }> = {
    ok: { cls: "bg-emerald-50 border-emerald-100", icon: <CheckCircle2 className="w-4 h-4 text-emerald-600" /> },
    warn: { cls: "bg-amber-50 border-amber-100", icon: <AlertTriangle className="w-4 h-4 text-amber-600" /> },
    bad: { cls: "bg-red-50 border-red-100", icon: <XCircle className="w-4 h-4 text-red-600" /> },
  };
  const s = styles[level];
  return (
    <div className={`flex items-start gap-2.5 rounded-xl border p-3 ${s.cls}`}>
      <span className="shrink-0 mt-0.5">{s.icon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[11px] font-bold text-brand-teal">{label}</span>
          <span className="text-[11px] font-mono text-gray-600 text-right break-all">{value}</span>
        </div>
        {hint && <p className="text-[10px] text-gray-500 mt-1 leading-snug">{hint}</p>}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-bold text-brand-teal uppercase tracking-wider">{title}</h3>
      {children}
    </div>
  );
}

export default function AdminDiagnostics() {
  const [data, setData] = useState<Diagnostics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const idToken = await auth.currentUser?.getIdToken();
      if (!idToken) {
        setError("Sessão expirada. Faça login novamente no portal.");
        return;
      }
      const res = await fetch("/api/admin/diagnostics", { headers: { Authorization: `Bearer ${idToken}` } });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || "Falha ao carregar o diagnóstico.");
      setData(json as Diagnostics);
    } catch (err: any) {
      setError(err?.message || "Não foi possível carregar o diagnóstico.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const mp = data?.mercadoPago;
  // O alerta mais importante da tela: cobrando de verdade sem nenhum pagamento
  // jamais registrado significa que a confirmação automática nunca funcionou.
  const readyToCharge =
    !!mp && mp.mode === "producao" && mp.webhookSecretConfigured && (mp.paymentsCount ?? 0) > 0;

  return (
    <div className="pb-32 px-4 pt-6 animate-fade-in space-y-6">
      <div className="bg-gradient-to-br from-brand-teal to-teal-800 text-brand-cream rounded-3xl p-6 shadow-md flex items-center justify-between">
        <div>
          <span className="text-[10px] font-bold text-brand-coral uppercase tracking-widest font-mono">
            Configuração do ambiente
          </span>
          <h2 className="text-xl font-display font-bold">Sistema</h2>
          <p className="text-xs text-brand-cream/80 font-sans mt-0.5">
            O que está configurado neste deployment. Segredos nunca são exibidos.
          </p>
        </div>
        <div className="w-12 h-12 bg-white/10 rounded-full flex items-center justify-center text-brand-peach shrink-0 ml-2">
          <ServerCog className="w-6 h-6" />
        </div>
      </div>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="flex items-center gap-1.5 text-xs font-semibold bg-white border border-brand-cream-darker text-brand-teal hover:bg-brand-peach px-3 py-2 rounded-xl transition-all shadow-xs disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} /> Atualizar
        </button>
      </div>

      {error && (
        <div className="bg-red-50/60 border border-red-100 rounded-2xl p-4 text-xs text-red-600 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}

      {data && mp && (
        <div className="space-y-6">
          {/* Veredito de prontidão para cobrar */}
          <div
            className={`rounded-2xl border p-4 flex items-start gap-3 ${
              readyToCharge ? "bg-emerald-50 border-emerald-100" : "bg-amber-50 border-amber-100"
            }`}
          >
            {readyToCharge ? (
              <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
            ) : (
              <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
            )}
            <div className="text-[11px] leading-snug">
              <p className={`font-bold ${readyToCharge ? "text-emerald-800" : "text-amber-900"}`}>
                {readyToCharge ? "Pronto para cobrar" : "Ainda não está cobrando de verdade"}
              </p>
              <p className={readyToCharge ? "text-emerald-700 mt-0.5" : "text-amber-800 mt-0.5"}>
                {readyToCharge
                  ? "Credenciais de produção, webhook configurado e pagamentos já confirmados automaticamente."
                  : mp.mode !== "producao"
                  ? "O Mercado Pago está em modo de teste — nenhum pagamento real é recebido."
                  : !mp.webhookSecretConfigured
                  ? "Falta o segredo do webhook: os pagamentos serão cobrados mas não liberam a assinatura sozinhos."
                  : "Nenhum pagamento foi confirmado automaticamente até agora. Faça um pagamento real de teste para validar o webhook."}
              </p>
            </div>
          </div>

          <Section title="Mercado Pago">
            <Row
              level={mp.mode === "producao" ? "ok" : mp.mode === "teste" ? "warn" : "bad"}
              label="Credenciais"
              value={
                mp.mode === "producao" ? "PRODUÇÃO (APP_USR-…)"
                : mp.mode === "teste" ? "TESTE (TEST-…)"
                : mp.mode === "ausente" ? "ausente" : "formato desconhecido"
              }
              hint={mp.mode === "teste" ? "Troque por credenciais de produção na Vercel e faça um redeploy." : undefined}
            />
            <Row
              level={mp.webhookSecretConfigured ? "ok" : "bad"}
              label="Segredo do webhook"
              value={mp.webhookSecretConfigured ? "configurado" : "AUSENTE"}
              hint={!mp.webhookSecretConfigured ? "Sem ele, todo webhook é rejeitado e nenhuma assinatura ativa sozinha." : undefined}
            />
            <Row
              level={(mp.paymentsCount ?? 0) > 0 ? "ok" : "warn"}
              label="Pagamentos confirmados"
              value={mp.paymentsCount === null ? "erro ao contar" : String(mp.paymentsCount)}
              hint={
                (mp.paymentsCount ?? 0) > 0
                  ? `Último em ${formatDateTime(mp.lastPaymentAt)} — prova de que o webhook funciona.`
                  : "Nenhum registro: o webhook nunca confirmou um pagamento."
              }
            />
            {mp.lastWebhookError && (
              <Row
                level="bad"
                label="Último erro de webhook"
                value={formatDateTime(mp.lastWebhookError.createdAt)}
                hint={mp.lastWebhookError.message}
              />
            )}
          </Section>

          <Section title="E-mail (recuperação de senha)">
            <Row
              level={data.email.resendConfigured ? "ok" : "warn"}
              label="Resend"
              value={data.email.resendConfigured ? "configurado" : "AUSENTE"}
              hint={data.email.resendConfigured ? `Remetente: ${data.email.fromAddress}` : "Sem a chave, o código de redefinição de senha não é enviado."}
            />
          </Section>

          <Section title="Inteligência Artificial">
            <Row
              level={data.gemini.configured ? "ok" : "bad"}
              label="Gemini"
              value={data.gemini.configured ? data.gemini.model : "AUSENTE"}
              hint={!data.gemini.configured ? "Os scanners entram em modo demonstração." : undefined}
            />
          </Section>

          <Section title="Notificações">
            <Row
              level={data.push.vapidConfigured ? "ok" : "warn"}
              label="Push (VAPID)"
              value={data.push.vapidConfigured ? "ativo" : "desativado"}
            />
            <Row
              level={data.push.cronSecretConfigured ? "ok" : "warn"}
              label="Segredo do cron"
              value={data.push.cronSecretConfigured ? "configurado" : "AUSENTE"}
              hint={!data.push.cronSecretConfigured ? "O cron não consegue disparar os lembretes." : undefined}
            />
            <Row level="ok" label="ENABLE_PUSH_SCHEDULER" value={data.push.schedulerFlag} hint="Em serverless deve ser 'false' — quem agenda é o cron." />
          </Section>

          <Section title="Firebase">
            <Row
              level={data.firebase.serviceAccountEnv ? "ok" : "warn"}
              label="Service account (env)"
              value={data.firebase.serviceAccountEnv ? "configurado" : "ausente"}
              hint={!data.firebase.serviceAccountEnv ? "Em serverless não existe credencial padrão — sem isso o Admin SDK falha." : undefined}
            />
            <Row
              level="ok"
              label="Banco Firestore"
              value={data.firebase.databaseId}
              hint="Precisa ser o mesmo de firebase-applet-config.json, senão o servidor grava num banco que o app não lê."
            />
          </Section>

          <Section title="Aplicação">
            <Row
              level={data.app.appUrl.startsWith("http") ? "ok" : "bad"}
              label="APP_URL"
              value={data.app.appUrl}
              hint="Governa o CORS e o retorno do checkout. Sem barra no final."
            />
            <Row level="ok" label="NODE_ENV" value={data.app.nodeEnv} />
          </Section>
        </div>
      )}

      {!data && !error && loading && (
        <div className="bg-white border border-brand-cream-darker rounded-3xl p-8 text-center text-gray-400">
          <RefreshCw className="w-6 h-6 mx-auto mb-2 animate-spin text-gray-300" />
          <p className="text-xs font-semibold">Carregando diagnóstico...</p>
        </div>
      )}
    </div>
  );
}
