import React, { useEffect, useState } from "react";
import { auth } from "../firebase";
import { PaymentRecord } from "../types";
import { AlertCircle, Search, RefreshCw, CalendarRange, CreditCard, QrCode, Wallet, Receipt } from "lucide-react";

const PAGE_SIZE = 30;

function formatDateTime(iso: string | undefined | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatBRL(value: number | null | undefined): string {
  if (typeof value !== "number") return "-";
  return `R$ ${value.toFixed(2).replace(".", ",")}`;
}

// O Mercado Pago devolve o meio de pagamento em snake_case ("credit_card",
// "account_money", ...). Registros gravados antes do campo existir vêm nulos.
function describeMethod(method: string | null | undefined): { label: string; isPix: boolean } {
  if (!method) return { label: "Não informado", isPix: false };
  if (method === "pix") return { label: "PIX", isPix: true };
  if (method === "credit_card") return { label: "Cartão de crédito", isPix: false };
  if (method === "debit_card") return { label: "Cartão de débito", isPix: false };
  if (method === "account_money") return { label: "Saldo Mercado Pago", isPix: false };
  return { label: method.replace(/_/g, " "), isPix: false };
}

export default function AdminPayments() {
  const [payments, setPayments] = useState<PaymentRecord[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Mesmo racional do filtro de data em AdminLogs: aplicado no servidor, não
  // sobre o que já foi paginado — senão "De 01/01" não acharia nada se os 30
  // registros mais recentes carregados forem todos de outro dia.
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  // `aggregated` diz se o total cobre o período INTEIRO (agregação do
  // Firestore) ou apenas o que está carregado — sem essa distinção explícita,
  // um total parcial passaria por faturamento do período.
  const [aggregated, setAggregated] = useState(false);
  const [totalAmount, setTotalAmount] = useState<number | null>(null);
  const [totalCount, setTotalCount] = useState<number | null>(null);

  const loadPage = async (cursor: string | null, reset: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const idToken = await auth.currentUser?.getIdToken();
      if (!idToken) {
        setError("Sessão expirada. Faça login novamente no portal.");
        return;
      }

      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (cursor) params.set("cursor", cursor);
      if (dateFrom) params.set("from", new Date(`${dateFrom}T00:00:00`).toISOString());
      if (dateTo) params.set("to", new Date(`${dateTo}T23:59:59.999`).toISOString());

      const response = await fetch(`/api/admin/payments?${params.toString()}`, {
        headers: { Authorization: `Bearer ${idToken}` },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data?.error || "Falha ao carregar os pagamentos.");
      }

      const list: PaymentRecord[] = data.payments || [];
      setPayments((prev) => (reset ? list : [...prev, ...list]));
      setNextCursor(data.nextCursor ?? null);
      setHasMore(!!data.hasMore);
      setAggregated(!!data.aggregated);
      setTotalAmount(typeof data.totalAmount === "number" ? data.totalAmount : null);
      setTotalCount(typeof data.totalCount === "number" ? data.totalCount : null);
    } catch (err: any) {
      console.error("Erro ao carregar pagamentos:", err);
      setError(err?.message || "Não foi possível carregar os pagamentos.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setNextCursor(null);
    setHasMore(true);
    loadPage(null, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateFrom, dateTo]);

  const q = searchQuery.toLowerCase();
  const filteredPayments = payments.filter(
    (p) =>
      !q ||
      (p.userName || "").toLowerCase().includes(q) ||
      (p.userEmail || "").toLowerCase().includes(q) ||
      p.paymentId.toLowerCase().includes(q)
  );

  // Quando o servidor não conseguiu agregar, some o que está em tela e rotule
  // como tal — um número parcial apresentado como total viraria decisão errada.
  const showingServerTotal = aggregated;
  const displayedAmount = showingServerTotal
    ? totalAmount ?? 0
    : payments.reduce((sum, p) => sum + (p.amount || 0), 0);
  const displayedCount = showingServerTotal ? totalCount ?? 0 : payments.length;

  return (
    <div className="pb-32 px-4 pt-6 animate-fade-in space-y-6">
      {/* Title Card */}
      <div className="bg-gradient-to-br from-brand-teal to-teal-800 text-brand-cream rounded-3xl p-6 shadow-md flex items-center justify-between">
        <div>
          <span className="text-[10px] font-bold text-brand-coral uppercase tracking-widest font-mono">
            Assinaturas
          </span>
          <h2 className="text-xl font-display font-bold">Pagamentos</h2>
          <p className="text-xs text-brand-cream/80 font-sans mt-0.5">
            Pagamentos aprovados e confirmados pelo Mercado Pago.
          </p>
        </div>
        <div className="w-12 h-12 bg-white/10 rounded-full flex items-center justify-center text-brand-peach shrink-0 ml-2">
          <Receipt className="w-6 h-6" />
        </div>
      </div>

      {/* Resumo do período */}
      <div className="bg-white border border-brand-cream-darker rounded-2xl p-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-9 h-9 rounded-xl bg-success-50 border border-success-100 flex items-center justify-center shrink-0">
            <Wallet className="w-4 h-4 text-success-600" />
          </div>
          <div className="min-w-0">
            <p className="text-[10px] font-bold text-ink-soft uppercase tracking-wide">
              {showingServerTotal ? "Total do período (bruto)" : "Total carregado (bruto)"}
            </p>
            <p className="text-lg font-display font-extrabold text-brand-teal leading-tight">
              {formatBRL(displayedAmount)}
            </p>
          </div>
        </div>
        <div className="text-right shrink-0">
          <p className="text-[10px] font-bold text-ink-soft uppercase tracking-wide">Pagamentos</p>
          <p className="text-lg font-display font-extrabold text-brand-coral leading-tight">{displayedCount ?? "-"}</p>
        </div>
      </div>
      <p className="text-[10px] text-ink-soft -mt-4 leading-snug px-1">
        Valor <strong>bruto</strong> cobrado — o Mercado Pago desconta a taxa dele antes de creditar.
        Consulte o valor líquido no painel do Mercado Pago.
      </p>

      {/* Search + Refresh */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-2.5 w-4 h-4 text-ink-soft" />
          <input
            type="text"
            placeholder="Buscar por nome, e-mail ou ID do pagamento..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-white border border-brand-cream-darker rounded-xl pl-9 pr-4 py-2 text-xs text-brand-teal focus:outline focus:outline-2 focus:outline-offset-1 focus:outline-brand-coral focus:border-brand-coral font-sans"
          />
        </div>
        <button
          type="button"
          onClick={() => {
            setNextCursor(null);
            setHasMore(true);
            loadPage(null, true);
          }}
          className="shrink-0 p-2 bg-white border border-brand-cream-darker rounded-xl text-brand-teal hover:bg-brand-peach transition-all"
          title="Atualizar"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {/* Date range filter */}
      <div className="flex items-end gap-2 bg-white border border-brand-cream-darker rounded-2xl p-3">
        <CalendarRange className="w-4 h-4 text-brand-teal mb-2 shrink-0" />
        <div className="flex-1">
          <label htmlFor="payments-date-from" className="block text-[10px] font-bold text-ink-soft uppercase tracking-wide mb-1">De</label>
          <input
            id="payments-date-from"
            type="date"
            value={dateFrom}
            max={dateTo || undefined}
            onChange={(e) => setDateFrom(e.target.value)}
            className="w-full bg-white border border-brand-cream-darker rounded-lg px-2 py-1.5 text-xs text-brand-teal focus:outline focus:outline-2 focus:outline-offset-1 focus:outline-brand-coral focus:border-brand-coral font-sans"
          />
        </div>
        <div className="flex-1">
          <label htmlFor="payments-date-to" className="block text-[10px] font-bold text-ink-soft uppercase tracking-wide mb-1">Até</label>
          <input
            id="payments-date-to"
            type="date"
            value={dateTo}
            min={dateFrom || undefined}
            onChange={(e) => setDateTo(e.target.value)}
            className="w-full bg-white border border-brand-cream-darker rounded-lg px-2 py-1.5 text-xs text-brand-teal focus:outline focus:outline-2 focus:outline-offset-1 focus:outline-brand-coral focus:border-brand-coral font-sans"
          />
        </div>
        {(dateFrom || dateTo) && (
          <button
            type="button"
            onClick={() => {
              setDateFrom("");
              setDateTo("");
            }}
            className="shrink-0 text-[10px] font-bold uppercase text-brand-coral hover:text-brand-coral-dark px-2 py-1.5 rounded-lg transition-colors"
          >
            Limpar
          </button>
        )}
      </div>

      {error && (
        <div className="bg-error-50/60 border border-error-100 rounded-2xl p-4 text-xs text-error-600 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}

      {/* Lista */}
      <div className="space-y-3 lg:grid lg:grid-cols-2 lg:gap-3 lg:space-y-0">
        {filteredPayments.length === 0 && !loading ? (
          <div className="bg-white border border-brand-cream-darker rounded-3xl p-8 text-center text-ink-soft lg:col-span-2">
            <AlertCircle className="w-8 h-8 mx-auto mb-2 text-gray-300" />
            <p className="text-xs font-semibold">Nenhum pagamento encontrado.</p>
          </div>
        ) : (
          filteredPayments.map((p) => {
            const method = describeMethod(p.paymentMethod);
            return (
              <div
                key={p.paymentId}
                className="bg-white border border-brand-cream-darker rounded-2xl p-4 shadow-2xs space-y-1.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[8px] font-extrabold px-1.5 py-0.5 rounded-full uppercase tracking-wide bg-success-100 text-success-700 flex items-center gap-1 shrink-0">
                    {method.isPix ? <QrCode className="w-2.5 h-2.5" /> : <CreditCard className="w-2.5 h-2.5" />}
                    {method.label}
                  </span>
                  <span className="text-[9px] text-ink-soft font-mono shrink-0">{formatDateTime(p.createdAt)}</span>
                </div>

                <div className="flex items-baseline justify-between gap-2">
                  <p className="text-xs font-bold text-brand-teal leading-tight truncate">
                    {p.userName || "Usuário removido"}
                  </p>
                  <span className="text-sm font-display font-extrabold text-brand-coral shrink-0">
                    {formatBRL(p.amount)}
                  </span>
                </div>

                <p className="text-[10px] text-ink-soft font-mono truncate">{p.userEmail || p.userId}</p>
                <p className="text-[10px] text-ink-soft">
                  Plano: <span className="font-semibold text-brand-teal">{p.plan === "yearly" ? "Anual" : "Mensal"}</span>
                  {p.periodEnd && <> · Válido até {formatDateTime(p.periodEnd)}</>}
                </p>
                <p className="text-[9px] text-gray-300 font-mono truncate">MP #{p.paymentId}</p>
              </div>
            );
          })
        )}
      </div>

      {hasMore && !searchQuery && (
        <div className="text-center">
          <button
            type="button"
            disabled={loading}
            onClick={() => loadPage(nextCursor, false)}
            className="text-xs font-semibold bg-white border border-brand-cream-darker text-brand-teal hover:bg-brand-peach px-4 py-2 rounded-xl transition-all shadow-xs disabled:opacity-50"
          >
            {loading ? "Carregando..." : "Carregar mais"}
          </button>
        </div>
      )}
    </div>
  );
}
