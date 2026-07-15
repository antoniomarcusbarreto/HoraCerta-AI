import React, { useState } from "react";
import { Medicado, Receita, Medicamento } from "../types";
import PrescriptionScanner from "./PrescriptionScanner";
import ConfirmDialog from "./ConfirmDialog";
import { FileText, Calendar, Trash2, User, Sparkles, ChevronDown, ChevronUp } from "lucide-react";

interface AppointmentsProps {
  medicados: Medicado[];
  receitas: Receita[];
  medicamentos: Medicamento[];
  onAddReceita: (
    doctorName: string,
    date: string,
    medicines: Omit<Medicamento, "medicamentoId" | "createdAt" | "userId">[],
    medicadoId: string
  ) => void;
  onDeleteReceita: (receitaId: string) => void;
}

export default function Appointments({
  medicados,
  receitas,
  medicamentos,
  onAddReceita,
  onDeleteReceita,
}: AppointmentsProps) {
  const [showPrescriptionScan, setShowPrescriptionScan] = useState(false);
  const [expandedReceitaId, setExpandedReceitaId] = useState<string | null>(null);
  const [confirmReceita, setConfirmReceita] = useState<{ id: string; doctorName: string } | null>(null);

  // Total medicines prescribed across all saved recipes
  const totalPrescribedMedicines = medicamentos.filter(m =>
    receitas.some(r => r.receitaId === m.receitaId)
  ).length;

  // If the scanner interface is triggered, render it in place
  if (showPrescriptionScan) {
    return (
      <PrescriptionScanner
        medicados={medicados}
        onScanComplete={(doctorName, date, medicines, medicadoId) => {
          onAddReceita(doctorName, date, medicines, medicadoId);
          setShowPrescriptionScan(false);
        }}
        onCancel={() => setShowPrescriptionScan(false)}
      />
    );
  }

  return (
    <div className="pb-32 px-4 max-w-md lg:max-w-4xl mx-auto pt-6 animate-fade-in">
      {/* Title Card */}
      <div className="bg-brand-teal text-brand-cream rounded-3xl p-6 shadow-md mb-6 flex items-center justify-between">
        <div>
          <span className="text-[10px] font-bold text-brand-coral uppercase tracking-widest font-mono">
            Histórico de Tratamentos
          </span>
          <h2 className="text-xl font-display font-bold">Receitas Salvas</h2>
          <p className="text-xs text-brand-cream/80 font-sans mt-0.5">
            Leitura inteligente e histórico de prescrições médicas.
          </p>
        </div>
        <div className="w-12 h-12 bg-brand-teal-light rounded-full flex items-center justify-center text-brand-coral">
          <FileText className="w-6 h-6 stroke-[2]" />
        </div>
      </div>

      <div className="space-y-6">
        {/* Summary + scan banner */}
        <div className="bg-brand-teal text-brand-cream rounded-3xl p-6 shadow-xs flex items-center justify-between">
          <div>
            <span className="text-[9px] font-bold text-brand-coral uppercase tracking-widest font-mono">
              Inteligência Artificial
            </span>
            <p className="text-xs text-brand-cream/70 mt-1 leading-none">Medicamentos Prescritos</p>
            <h3 className="text-2xl font-display font-extrabold text-brand-cream mt-1.5">
              {totalPrescribedMedicines}
            </h3>
          </div>

          <button
            onClick={() => setShowPrescriptionScan(true)}
            className="px-4 py-3 bg-brand-coral hover:bg-brand-coral-light hover:scale-[1.02] active:scale-[0.98] transition-all text-brand-cream text-xs font-bold rounded-2xl flex items-center gap-1.5 shadow-md animate-pulse"
          >
            <Sparkles className="w-4 h-4 fill-brand-cream/10" />
            Escanear Receita
          </button>
        </div>

        {/* List of scanned prescriptions */}
        <div className="space-y-4">
          <h3 className="text-xs font-bold text-brand-teal uppercase tracking-wider">
            Receitas Salvas ({receitas.length})
          </h3>

          {receitas.length === 0 ? (
            <div className="bg-white border border-brand-cream-darker rounded-3xl p-8 text-center text-xs text-gray-400 font-sans">
              <FileText className="w-8 h-8 mx-auto mb-2 text-brand-teal-pale" />
              Nenhuma receita escaneada.<br />
              <button
                onClick={() => setShowPrescriptionScan(true)}
                className="mt-3 text-xs font-bold text-brand-teal underline hover:text-brand-coral"
              >
                Escanear receita agora
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {receitas.map((recipe) => {
                const patient = medicados.find(p => p.medicadoId === recipe.medicadoId);
                const recipeMeds = medicamentos.filter(m => m.receitaId === recipe.receitaId);
                const isExpanded = expandedReceitaId === recipe.receitaId;

                return (
                  <div
                    key={recipe.receitaId}
                    id={`recipe-card-${recipe.receitaId}`}
                    className="bg-white border border-brand-cream-darker rounded-3xl p-5 shadow-xs transition-all hover:shadow-xs relative"
                  >
                    {/* Header info */}
                    <div className="flex justify-between items-start">
                      <div className="space-y-1 pr-8">
                        {patient && (
                          <div className="flex items-center gap-1.5 bg-brand-peach px-2.5 py-1 rounded-lg w-max text-[10px] font-bold text-brand-coral uppercase">
                            <User className="w-3 h-3 text-brand-coral" /> {patient.name}
                          </div>
                        )}
                        <h4 className="text-sm font-bold text-brand-teal font-display">
                          {recipe.doctorName || "Médico não informado"}
                        </h4>
                        <p className="text-[10px] text-gray-400 font-sans flex items-center gap-1">
                          <Calendar className="w-3.5 h-3.5 text-brand-teal/40" />
                          <span>Prescrito em: {recipe.date}</span>
                        </p>
                      </div>

                      <button
                        onClick={() => setConfirmReceita({ id: recipe.receitaId, doctorName: recipe.doctorName || "Médico não informado" })}
                        className="p-1.5 rounded-lg text-gray-300 hover:text-red-500 hover:bg-red-50 transition-all absolute top-4 right-4"
                        title="Remover receita e lembretes"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>

                    <div className="border-t border-brand-cream-darker mt-4 pt-3 flex items-center justify-between">
                      <div>
                        <span className="text-[9px] text-gray-400 uppercase tracking-wide block">Medicamentos</span>
                        <span className="text-base font-display font-extrabold text-brand-coral">
                          {recipeMeds.length}
                        </span>
                      </div>

                      <button
                        onClick={() => setExpandedReceitaId(isExpanded ? null : recipe.receitaId)}
                        className="flex items-center gap-1 text-[11px] font-bold text-brand-teal hover:text-brand-coral transition-colors"
                      >
                        {isExpanded ? (
                          <>
                            Ocultar Detalhes <ChevronUp className="w-4 h-4" />
                          </>
                        ) : (
                          <>
                            Ver {recipeMeds.length} {recipeMeds.length === 1 ? "Medicamento" : "Medicamentos"} <ChevronDown className="w-4 h-4" />
                          </>
                        )}
                      </button>
                    </div>

                    {/* Expandable medicine breakdown */}
                    {isExpanded && (
                      <div className="mt-4 pt-3 border-t border-dashed border-brand-cream-darker space-y-2 bg-brand-cream-dark/20 p-3 rounded-2xl animate-fade-in">
                        <p className="text-[9px] font-bold text-brand-teal/60 uppercase tracking-wider mb-1">
                          Detalhamento da Receita
                        </p>

                        {recipeMeds.length === 0 ? (
                          <p className="text-[11px] text-gray-400 italic">Nenhum lembrete ativo de medicamento associado.</p>
                        ) : (
                          <ul className="space-y-2">
                            {recipeMeds.map((med) => (
                              <li key={med.medicamentoId} className="text-xs text-gray-600 flex items-start gap-2 bg-white p-2.5 rounded-xl border border-brand-cream-darker/40">
                                <span className="w-2 h-2 rounded-full bg-brand-coral shrink-0 mt-1.5" />
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center justify-between gap-2">
                                    <span className="font-bold text-brand-teal truncate block">{med.name}</span>
                                    <span className="text-[9px] font-semibold bg-brand-teal-pale text-brand-teal px-1.5 py-0.5 rounded-md uppercase shrink-0">
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
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={!!confirmReceita}
        title="Excluir receita"
        message={`Remover a receita de "${confirmReceita?.doctorName}" e seus medicamentos e lembretes associados?`}
        danger
        confirmLabel="Excluir"
        onConfirm={() => {
          if (confirmReceita) onDeleteReceita(confirmReceita.id);
          setConfirmReceita(null);
        }}
        onCancel={() => setConfirmReceita(null)}
      />
    </div>
  );
}
