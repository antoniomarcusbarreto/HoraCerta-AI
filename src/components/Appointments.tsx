import React from "react";
import { Medicado, Receita, Medicamento } from "../types";
import { FileText, Calendar, Trash2, User, Pill, ShieldCheck } from "lucide-react";

interface AppointmentsProps {
  medicados: Medicado[];
  receitas: Receita[];
  medicamentos: Medicamento[];
  onDeleteReceita: (receitaId: string) => void;
}

export default function Appointments({
  medicados,
  receitas,
  medicamentos,
  onDeleteReceita,
}: AppointmentsProps) {
  const [deletingId, setDeletingId] = React.useState<string | null>(null);

  return (
    <div className="space-y-6">
      {/* Title Card */}
      <div className="bg-brand-teal text-brand-cream rounded-3xl p-6 shadow-md flex items-center justify-between">
        <div>
          <span className="text-[10px] font-bold text-brand-coral uppercase tracking-widest font-mono">
            Histórico de Tratamentos
          </span>
          <h2 className="text-xl font-display font-bold">Receitas Salvas</h2>
          <p className="text-xs text-brand-cream/80 font-sans mt-0.5">
            Histórico de receitas digitalizadas e prescrições médicas.
          </p>
        </div>
        <div className="w-12 h-12 bg-brand-teal-light rounded-full flex items-center justify-center text-brand-coral">
          <FileText className="w-6 h-6 stroke-[2]" />
        </div>
      </div>

      {/* Recipes List Section */}
      <div className="mb-4">
        <h3 className="text-sm font-bold text-brand-teal uppercase tracking-wider">
          Histórico de Receitas ({receitas.length})
        </h3>
      </div>

      {receitas.length === 0 ? (
        <div className="bg-white border border-brand-cream-darker rounded-3xl p-8 text-center shadow-xs animate-fade-in">
          <FileText className="w-10 h-10 text-gray-300 mx-auto mb-2" />
          <p className="text-sm text-gray-500 font-medium">Nenhuma receita salva para consulta.</p>
          <p className="text-xs text-gray-400 mt-1 leading-relaxed">
            Utilize o botão de escaneamento ("+") na barra inferior para ler e agendar uma nova receita com inteligência artificial.
          </p>
        </div>
      ) : (
        <div className="space-y-4 animate-fade-in">
          {receitas.map((recipe) => {
            const patient = medicados.find(p => p.medicadoId === recipe.medicadoId);
            const recipeMeds = medicamentos.filter(m => m.receitaId === recipe.receitaId);

            return (
              <div
                key={recipe.receitaId}
                id={`recipe-card-${recipe.receitaId}`}
                className="bg-white border border-brand-cream-darker rounded-3xl p-5 shadow-xs hover:shadow-md transition-all relative"
              >
                {/* Delete Receipt Button */}
                <div className="absolute top-4 right-4 flex items-center gap-1.5 z-10">
                  {deletingId === recipe.receitaId ? (
                    <div className="flex items-center gap-1 bg-red-50 p-1 rounded-xl border border-red-200 animate-fade-in">
                      <span className="text-[9px] font-bold text-red-600 px-1.5 py-0.5">Excluir receita?</span>
                      <button
                        onClick={() => {
                          onDeleteReceita(recipe.receitaId);
                          setDeletingId(null);
                        }}
                        className="px-2 py-1 rounded-lg bg-red-600 text-white hover:bg-red-700 text-[10px] font-bold transition-all"
                      >
                        Sim
                      </button>
                      <button
                        onClick={() => setDeletingId(null)}
                        className="px-2 py-1 rounded-lg bg-white border border-gray-300 text-gray-500 hover:text-gray-700 text-[10px] font-bold transition-all"
                      >
                        Não
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setDeletingId(recipe.receitaId)}
                      className="p-1.5 rounded-lg bg-red-50 hover:bg-red-100 text-red-500 hover:text-red-600 transition-all"
                      title="Remover receita e lembretes"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>

                {/* Patient tag */}
                {patient && (
                  <div className="flex items-center gap-1.5 bg-brand-peach px-2.5 py-1 rounded-lg w-max mb-3 text-[10px] font-bold text-brand-coral uppercase">
                    <User className="w-3 h-3 text-brand-coral" /> Paciente: {patient.name}
                  </div>
                )}

                {/* Doctor and Date details */}
                <h4 className="text-sm font-semibold text-brand-teal font-display">
                  {recipe.doctorName || "Médico não informado"}
                </h4>
                <div className="flex items-center gap-1.5 mt-1 text-xs text-gray-400 font-sans">
                  <Calendar className="w-3.5 h-3.5" />
                  <span>Prescrito em: {recipe.date}</span>
                </div>

                {/* Prescribed Medicines list */}
                <div className="mt-4 pt-3 border-t border-brand-cream-darker">
                  <p className="text-[10px] font-bold text-brand-teal uppercase tracking-wider mb-2">
                    Medicamentos Ministrados
                  </p>
                  
                  {recipeMeds.length === 0 ? (
                    <p className="text-[11px] text-gray-400 italic">Nenhum lembrete ativo de medicamento associado.</p>
                  ) : (
                    <ul className="space-y-3">
                      {recipeMeds.map((med) => (
                        <li key={med.medicamentoId} className="text-xs text-gray-600 flex items-start gap-2 bg-brand-cream-dark/30 p-2.5 rounded-xl border border-brand-cream-darker/40">
                          <span className="w-2 h-2 rounded-full bg-brand-coral shrink-0 mt-1.5" />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between">
                              <span className="font-bold text-brand-teal truncate block">{med.name}</span>
                              <span className="text-[9px] font-semibold bg-brand-teal-pale text-brand-teal px-1.5 py-0.5 rounded-md uppercase">
                                {med.category === "pill" ? "Comprimido" :
                                 med.category === "syrup" ? "Xarope" :
                                 med.category === "drop" ? "Gotas" :
                                 med.category === "cream" ? "Pomada" :
                                 med.category === "injection" ? "Injetável" : "Outro"}
                              </span>
                            </div>
                            <p className="text-[11px] text-gray-500 font-sans mt-0.5">
                              Dose: <span className="font-medium">{med.dosage}</span> • Intervalo: <span className="font-medium">{med.intervalHours}h</span> • Duração: <span className="font-medium">{med.durationDays} dias</span>
                            </p>
                            {med.instructions && (
                              <p className="text-[10px] text-gray-400 italic font-sans mt-1">
                                Obs: {med.instructions}
                              </p>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
