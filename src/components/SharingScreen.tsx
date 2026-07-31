import React, { useState } from "react";
import { Users, UserPlus, Trash2, Check, Clock, Eye, Pencil, AlertCircle } from "lucide-react";
import { Medicado, Share, ShareRole } from "../types";
import { SHARE_ROLE_LABELS, SHARE_ROLE_DESCRIPTIONS } from "../shares";

interface SharingScreenProps {
  myUid: string;
  medicados: Medicado[];
  sharesAsOwner: Share[];
  sharesAsGrantee: Share[];
  onInvite: (medicadoId: string, email: string, role: ShareRole) => Promise<void>;
  onRevoke: (shareId: string) => Promise<void>;
  onAccept: (shareId: string) => Promise<void>;
}

const ROLE_ICON: Record<ShareRole, React.ReactNode> = {
  coadministrador: <Pencil className="w-3 h-3" />,
  acompanhante: <Eye className="w-3 h-3" />,
};

export default function SharingScreen({
  myUid,
  medicados,
  sharesAsOwner,
  sharesAsGrantee,
  onInvite,
  onRevoke,
  onAccept,
}: SharingScreenProps) {
  const [selectedPatient, setSelectedPatient] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<ShareRole>("coadministrador");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Só o titular convida. Um coadministrador cuida do tratamento; quem decide
  // que outra pessoa passa a ver o prontuário é sempre o dono da conta.
  const ownedPatients = medicados.filter((m) => m.userId === myUid);
  const pendingInvites = sharesAsGrantee.filter((s) => s.status === "pending");
  const acceptedForMe = sharesAsGrantee.filter((s) => s.status === "accepted");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedPatient || !email.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onInvite(selectedPatient, email.trim(), role);
      setEmail("");
      setSelectedPatient("");
    } catch (err: any) {
      setError(err?.message || "Não foi possível enviar o convite.");
    } finally {
      setBusy(false);
    }
  };

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err: any) {
      setError(err?.message || "Não foi possível concluir a ação.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Convites recebidos, ainda não aceitos — primeiro por serem acionáveis */}
      {pendingInvites.length > 0 && (
        <div className="bg-brand-peach border border-brand-coral/25 rounded-3xl p-5">
          <h3 className="text-sm font-display font-bold text-brand-teal mb-1">
            {pendingInvites.length === 1 ? "Você tem um convite" : `Você tem ${pendingInvites.length} convites`}
          </h3>
          <p className="text-[11px] text-gray-600 mb-4 leading-snug">
            O acesso só começa depois que você aceitar.
          </p>
          <div className="space-y-3">
            {pendingInvites.map((s) => (
              <div key={s.shareId} className="bg-white rounded-2xl p-4 border border-brand-cream-darker">
                <div className="text-sm font-semibold text-brand-teal">{s.medicadoName}</div>
                <div className="text-[11px] text-gray-500 mt-0.5">
                  Convite de {s.ownerName} — {SHARE_ROLE_LABELS[s.role]}
                </div>
                <div className="text-[11px] text-gray-500 mt-1 leading-snug">
                  {SHARE_ROLE_DESCRIPTIONS[s.role]}
                </div>
                <div className="flex gap-2 mt-3">
                  <button
                    disabled={busy}
                    onClick={() => act(() => onAccept(s.shareId))}
                    className="flex-1 bg-brand-coral text-brand-cream text-xs font-bold py-2.5 rounded-xl disabled:opacity-50 flex items-center justify-center gap-1.5"
                  >
                    <Check className="w-3.5 h-3.5" /> Aceitar
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => act(() => onRevoke(s.shareId))}
                    className="px-4 bg-brand-cream-dark text-brand-teal text-xs font-bold py-2.5 rounded-xl disabled:opacity-50"
                  >
                    Recusar
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {error && (
        <div className="bg-red-50 text-red-800 border border-red-100 rounded-2xl p-3.5 flex items-start gap-2.5 text-xs">
          <AlertCircle className="w-4 h-4 shrink-0 text-red-500 mt-0.5" />
          <span className="leading-snug">{error}</span>
        </div>
      )}

      {/* Convidar alguém para um paciente meu */}
      <div className="bg-white border border-brand-cream-darker rounded-3xl p-5 shadow-xs">
        <div className="flex items-center gap-2 mb-1">
          <UserPlus className="w-4 h-4 text-brand-coral" />
          <h3 className="text-sm font-display font-bold text-brand-teal">Convidar um cuidador</h3>
        </div>
        <p className="text-[11px] text-gray-500 mb-4 leading-snug">
          O convite vale para <strong>um paciente</strong> — quem você convidar não verá os seus outros pacientes.
        </p>

        {ownedPatients.length === 0 ? (
          <p className="text-xs text-gray-400 py-2">Cadastre um paciente para poder compartilhar.</p>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            <div>
              <label className="block text-[10px] font-bold text-brand-teal uppercase tracking-wider mb-1">Paciente</label>
              <select
                required
                value={selectedPatient}
                onChange={(e) => setSelectedPatient(e.target.value)}
                className="w-full bg-brand-cream-dark border border-brand-cream-darker rounded-xl px-3 py-2 text-xs text-brand-teal focus:outline-hidden"
              >
                <option value="">Selecione...</option>
                {ownedPatients.map((p) => (
                  <option key={p.medicadoId} value={p.medicadoId}>{p.name}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-[10px] font-bold text-brand-teal uppercase tracking-wider mb-1">E-mail do cuidador</label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="pessoa@exemplo.com"
                className="w-full bg-brand-cream-dark border border-brand-cream-darker rounded-xl px-3 py-2 text-xs text-brand-teal focus:outline-hidden"
              />
            </div>

            <div>
              <label className="block text-[10px] font-bold text-brand-teal uppercase tracking-wider mb-1.5">Tipo de acesso</label>
              <div className="grid grid-cols-2 gap-2">
                {(["coadministrador", "acompanhante"] as ShareRole[]).map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setRole(r)}
                    className={`text-left p-3 rounded-2xl border transition-all ${
                      role === r
                        ? "border-brand-coral bg-brand-peach"
                        : "border-brand-cream-darker bg-white hover:border-brand-coral/40"
                    }`}
                  >
                    <div className="flex items-center gap-1.5 text-[11px] font-bold text-brand-teal">
                      {ROLE_ICON[r]} {SHARE_ROLE_LABELS[r]}
                    </div>
                    <div className="text-[10px] text-gray-500 mt-1 leading-snug">{SHARE_ROLE_DESCRIPTIONS[r]}</div>
                  </button>
                ))}
              </div>
            </div>

            <button
              type="submit"
              disabled={busy || !selectedPatient || !email.trim()}
              className="w-full bg-brand-coral text-brand-cream font-bold text-sm py-3.5 rounded-2xl disabled:bg-gray-100 disabled:text-gray-400 transition-transform active:scale-95"
            >
              {busy ? "Enviando..." : "Enviar convite"}
            </button>
          </form>
        )}
      </div>

      {/* Quem já tem acesso aos meus pacientes */}
      {sharesAsOwner.filter((s) => s.status !== "revoked").length > 0 && (
        <div className="bg-white border border-brand-cream-darker rounded-3xl p-5 shadow-xs">
          <div className="flex items-center gap-2 mb-4">
            <Users className="w-4 h-4 text-brand-coral" />
            <h3 className="text-sm font-display font-bold text-brand-teal">Quem acompanha meus pacientes</h3>
          </div>
          <div className="space-y-2.5">
            {sharesAsOwner.filter((s) => s.status !== "revoked").map((s) => (
              <div key={s.shareId} className="flex items-center justify-between gap-3 bg-brand-cream-dark rounded-2xl p-3.5">
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-brand-teal truncate">{s.granteeEmail}</div>
                  <div className="text-[10px] text-gray-500 mt-0.5 flex items-center gap-1.5 flex-wrap">
                    <span>{s.medicadoName}</span>
                    <span className="text-gray-300">•</span>
                    <span className="inline-flex items-center gap-1">{ROLE_ICON[s.role]} {SHARE_ROLE_LABELS[s.role]}</span>
                    {s.status === "pending" && (
                      <>
                        <span className="text-gray-300">•</span>
                        <span className="inline-flex items-center gap-1 text-brand-coral font-semibold">
                          <Clock className="w-3 h-3" /> aguardando aceite
                        </span>
                      </>
                    )}
                  </div>
                </div>
                <button
                  disabled={busy}
                  onClick={() => act(() => onRevoke(s.shareId))}
                  title="Encerrar acesso"
                  className="shrink-0 p-2 text-gray-400 hover:text-red-500 disabled:opacity-50"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Pacientes que outras contas compartilharam comigo */}
      {acceptedForMe.length > 0 && (
        <div className="bg-white border border-brand-cream-darker rounded-3xl p-5 shadow-xs">
          <div className="flex items-center gap-2 mb-4">
            <Users className="w-4 h-4 text-brand-teal" />
            <h3 className="text-sm font-display font-bold text-brand-teal">Pacientes que acompanho</h3>
          </div>
          <div className="space-y-2.5">
            {acceptedForMe.map((s) => (
              <div key={s.shareId} className="flex items-center justify-between gap-3 bg-brand-cream-dark rounded-2xl p-3.5">
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-brand-teal truncate">{s.medicadoName}</div>
                  <div className="text-[10px] text-gray-500 mt-0.5 flex items-center gap-1.5">
                    <span>de {s.ownerName}</span>
                    <span className="text-gray-300">•</span>
                    <span className="inline-flex items-center gap-1">{ROLE_ICON[s.role]} {SHARE_ROLE_LABELS[s.role]}</span>
                  </div>
                </div>
                <button
                  disabled={busy}
                  onClick={() => act(() => onRevoke(s.shareId))}
                  title="Sair deste compartilhamento"
                  className="shrink-0 text-[10px] font-bold text-gray-400 hover:text-red-500 disabled:opacity-50 px-2"
                >
                  Sair
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
