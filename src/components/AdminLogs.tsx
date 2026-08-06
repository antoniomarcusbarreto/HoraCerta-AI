import React, { useEffect, useState } from "react";
import { dbFirebase, LogDateRange } from "../firebase";
import { ActionLog, LoginLog, ErrorLog } from "../types";
import { AlertCircle, Search, LogIn, Pencil, Trash2, ServerCrash, RefreshCw, CalendarRange, Tag, MapPin, User as UserIcon, Mail, Globe } from "lucide-react";
import type { QueryDocumentSnapshot, DocumentData } from "firebase/firestore";

type LogTab = "acoes" | "login" | "erros";

const PAGE_SIZE = 30;

function formatDateTime(iso: string | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function AdminLogs() {
  const [subTab, setSubTab] = useState<LogTab>("acoes");
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filtro por data: strings no formato do <input type="date"> (yyyy-mm-dd).
  // Aplicado no servidor (where no mesmo campo do orderBy, sem índice extra),
  // não só no que já foi paginado — senão "De 01/01" não acharia nada se os
  // 30 registros mais recentes carregados forem todos de outro dia.
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const [actionLogs, setActionLogs] = useState<ActionLog[]>([]);
  const [loginLogs, setLoginLogs] = useState<LoginLog[]>([]);
  const [errorLogs, setErrorLogs] = useState<ErrorLog[]>([]);
  const [lastDoc, setLastDoc] = useState<QueryDocumentSnapshot<DocumentData> | null>(null);
  const [hasMore, setHasMore] = useState(true);

  const buildDateRange = (): LogDateRange | undefined => {
    if (!dateFrom && !dateTo) return undefined;
    const range: LogDateRange = {};
    if (dateFrom) range.start = new Date(`${dateFrom}T00:00:00`);
    if (dateTo) range.end = new Date(`${dateTo}T23:59:59.999`);
    return range;
  };

  const loadPage = async (tab: LogTab, cursor: QueryDocumentSnapshot<DocumentData> | null, reset: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const dateRange = buildDateRange();
      if (tab === "acoes") {
        const { logs, lastDoc: last } = await dbFirebase.getActionLogs(PAGE_SIZE, cursor, dateRange);
        setActionLogs((prev) => (reset ? logs : [...prev, ...logs]));
        setLastDoc(last);
        setHasMore(logs.length === PAGE_SIZE);
      } else if (tab === "login") {
        const { logs, lastDoc: last } = await dbFirebase.getLoginLogs(PAGE_SIZE, cursor, dateRange);
        setLoginLogs((prev) => (reset ? logs : [...prev, ...logs]));
        setLastDoc(last);
        setHasMore(logs.length === PAGE_SIZE);
      } else {
        const { logs, lastDoc: last } = await dbFirebase.getErrorLogs(PAGE_SIZE, cursor, dateRange);
        setErrorLogs((prev) => (reset ? logs : [...prev, ...logs]));
        setLastDoc(last);
        setHasMore(logs.length === PAGE_SIZE);
      }
    } catch (err: any) {
      console.error("Erro ao carregar logs:", err);
      setError("Não foi possível carregar os logs. Verifique suas permissões de administrador.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setLastDoc(null);
    setHasMore(true);
    loadPage(subTab, null, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subTab, dateFrom, dateTo]);

  const q = searchQuery.toLowerCase();
  const filteredActionLogs = actionLogs.filter(
    (l) => !q || l.actorName.toLowerCase().includes(q) || l.actorEmail.toLowerCase().includes(q) || l.entityLabel.toLowerCase().includes(q) || l.page.toLowerCase().includes(q)
  );
  const filteredLoginLogs = loginLogs.filter(
    (l) => !q || l.userName.toLowerCase().includes(q) || l.userEmail.toLowerCase().includes(q) || l.ip.toLowerCase().includes(q)
  );
  const filteredErrorLogs = errorLogs.filter(
    (l) => !q || l.action.toLowerCase().includes(q) || l.message.toLowerCase().includes(q)
  );

  return (
    <div className="pb-32 px-4 pt-6 animate-fade-in space-y-6">
      {/* Title Card */}
      <div className="bg-gradient-to-br from-brand-teal to-teal-800 text-brand-cream rounded-3xl p-6 shadow-md flex items-center justify-between">
        <div>
          <span className="text-[10px] font-bold text-brand-coral uppercase tracking-widest font-mono">
            Auditoria do Sistema
          </span>
          <h2 className="text-xl font-display font-bold">Logs</h2>
          <p className="text-xs text-brand-cream/80 font-sans mt-0.5">
            Login de usuários, alterações/exclusões de registros e erros de servidor.
          </p>
        </div>
        <div className="w-12 h-12 bg-white/10 rounded-full flex items-center justify-center text-brand-peach shrink-0 ml-2">
          <ServerCrash className="w-6 h-6" />
        </div>
      </div>

      {/* Sub-tabs */}
      <div className="flex bg-brand-cream-dark/50 border border-brand-cream-darker p-1 rounded-2xl">
        {([
          ["acoes", "Alterações/Exclusões"],
          ["login", "Login"],
          ["erros", "Erros"],
        ] as [LogTab, string][]).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setSubTab(key)}
            className={`flex-1 py-2 rounded-xl text-xs font-bold transition-all ${
              subTab === key ? "bg-brand-teal text-white shadow-xs" : "text-brand-teal/70 hover:text-brand-teal"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Search + Refresh */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-2.5 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="Buscar por usuário, registro, IP ou erro..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-white border border-brand-cream-darker rounded-xl pl-9 pr-4 py-2 text-xs text-brand-teal focus:outline-hidden focus:border-brand-coral font-sans"
          />
        </div>
        <button
          type="button"
          onClick={() => {
            setLastDoc(null);
            setHasMore(true);
            loadPage(subTab, null, true);
          }}
          className="shrink-0 p-2 bg-white border border-brand-cream-darker rounded-xl text-brand-teal hover:bg-brand-peach transition-all"
          title="Atualizar"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {/* Date range filter */}
      <div className="flex flex-wrap items-end gap-3 bg-white border border-brand-cream-darker rounded-2xl p-3">
        <CalendarRange className="w-4 h-4 text-brand-teal mb-2.5 shrink-0" />
        <div className="w-36">
          <label className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">De</label>
          <input
            type="date"
            value={dateFrom}
            max={dateTo || undefined}
            onChange={(e) => setDateFrom(e.target.value)}
            className="w-full bg-white border border-brand-cream-darker rounded-lg px-2 py-1.5 text-sm text-brand-teal focus:outline-hidden focus:border-brand-coral font-sans"
          />
        </div>
        <div className="w-36">
          <label className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">Até</label>
          <input
            type="date"
            value={dateTo}
            min={dateFrom || undefined}
            onChange={(e) => setDateTo(e.target.value)}
            className="w-full bg-white border border-brand-cream-darker rounded-lg px-2 py-1.5 text-sm text-brand-teal focus:outline-hidden focus:border-brand-coral font-sans"
          />
        </div>
        {(dateFrom || dateTo) && (
          <button
            type="button"
            onClick={() => {
              setDateFrom("");
              setDateTo("");
            }}
            className="shrink-0 text-xs font-bold uppercase text-brand-coral hover:text-brand-coral-dark px-2 py-1.5 rounded-lg transition-colors mb-0.5"
          >
            Limpar
          </button>
        )}
      </div>

      {error && (
        <div className="bg-red-50/60 border border-red-100 rounded-2xl p-4 text-xs text-red-600 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}

      {/* Lists */}
      <div className="space-y-3 lg:grid lg:grid-cols-2 lg:gap-3 lg:space-y-0">
        {subTab === "acoes" &&
          (filteredActionLogs.length === 0 && !loading ? (
            <EmptyState />
          ) : (
            filteredActionLogs.map((l) => (
              <div key={l.logId} className="bg-white border border-brand-cream-darker rounded-2xl p-5 shadow-2xs space-y-2">
                <div className="flex items-center justify-between">
                  <span
                    className={`text-[10px] font-extrabold px-2 py-1 rounded-full uppercase tracking-wide flex items-center gap-1 ${
                      l.action === "delete" ? "bg-red-100 text-red-600" : "bg-amber-100 text-amber-600"
                    }`}
                  >
                    {l.action === "delete" ? <Trash2 className="w-3 h-3" /> : <Pencil className="w-3 h-3" />}
                    {l.action === "delete" ? "Exclusão" : "Alteração"}
                  </span>
                  <span className="text-xs text-gray-500 font-mono">{formatDateTime(l.createdAt)}</span>
                </div>
                <p className="text-sm font-bold text-brand-teal leading-tight">{l.entityLabel}</p>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500">
                  <span className="flex items-center gap-1">
                    <Tag className="w-3.5 h-3.5 text-gray-400 shrink-0" /> {l.entityType}
                  </span>
                  <span className="flex items-center gap-1">
                    <MapPin className="w-3.5 h-3.5 text-gray-400 shrink-0" /> {l.page}
                  </span>
                  <span className="flex items-center gap-1 min-w-0">
                    <UserIcon className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                    <span className="truncate">{l.actorName} ({l.actorEmail})</span>
                  </span>
                </div>
              </div>
            ))
          ))}

        {subTab === "login" &&
          (filteredLoginLogs.length === 0 && !loading ? (
            <EmptyState />
          ) : (
            filteredLoginLogs.map((l) => (
              <div key={l.logId} className="bg-white border border-brand-cream-darker rounded-2xl p-5 shadow-2xs space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-extrabold px-2 py-1 rounded-full uppercase tracking-wide bg-blue-100 text-blue-600 flex items-center gap-1">
                    <LogIn className="w-3 h-3" /> Login
                  </span>
                  <span className="text-xs text-gray-500 font-mono">{formatDateTime(l.createdAt)}</span>
                </div>
                <p className="text-sm font-bold text-brand-teal leading-tight">{l.userName}</p>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500">
                  <span className="flex items-center gap-1 min-w-0">
                    <Mail className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                    <span className="truncate font-mono">{l.userEmail}</span>
                  </span>
                  <span className="flex items-center gap-1">
                    <Globe className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                    <span className="font-mono">{l.ip}</span>
                  </span>
                </div>
              </div>
            ))
          ))}

        {subTab === "erros" &&
          (filteredErrorLogs.length === 0 && !loading ? (
            <EmptyState />
          ) : (
            filteredErrorLogs.map((l) => (
              <div key={l.errorLogId} className="bg-white border border-brand-cream-darker rounded-2xl p-5 shadow-2xs space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-extrabold px-2 py-1 rounded-full uppercase tracking-wide bg-red-200 text-red-700 flex items-center gap-1">
                    <ServerCrash className="w-3 h-3" /> Erro
                  </span>
                  <span className="text-xs text-gray-500 font-mono">{formatDateTime(l.createdAt)}</span>
                </div>
                <p className="text-sm font-bold text-brand-teal leading-tight font-mono">{l.action}</p>
                <p className="text-xs text-gray-600 leading-relaxed break-words">{l.message}</p>
              </div>
            ))
          ))}
      </div>

      {hasMore && !searchQuery && (
        <div className="text-center">
          <button
            type="button"
            disabled={loading}
            onClick={() => loadPage(subTab, lastDoc, false)}
            className="text-xs font-semibold bg-white border border-brand-cream-darker text-brand-teal hover:bg-brand-peach px-4 py-2 rounded-xl transition-all shadow-xs disabled:opacity-50"
          >
            {loading ? "Carregando..." : "Carregar mais"}
          </button>
        </div>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="bg-white border border-brand-cream-darker rounded-3xl p-8 text-center text-gray-400 lg:col-span-2">
      <AlertCircle className="w-8 h-8 mx-auto mb-2 text-gray-300" />
      <p className="text-xs font-semibold">Nenhum registro encontrado.</p>
    </div>
  );
}
