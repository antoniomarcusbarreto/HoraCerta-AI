import React, { useState } from "react";
import { Farmacia, Medicamento, CupomFiscal } from "../types";
import ReceiptScanner from "./ReceiptScanner";
import ConfirmDialog from "./ConfirmDialog";
import { Sparkles, Trash2, Receipt, ChevronDown, ChevronUp, Calendar } from "lucide-react";

interface PharmaciesProps {
  farmacias?: Farmacia[];
  medicamentos?: Medicamento[];
  cupons: CupomFiscal[];
  onAddFarmacia?: (f: Omit<Farmacia, "farmaciaId">) => void;
  onUpdateFarmacia?: (f: Farmacia) => void;
  onDeleteFarmacia?: (id: string) => void;
  onAddCupom: (establishment: string, date: string, items: { name: string; price: number }[], totalPrice: number) => void;
  onDeleteCupom: (id: string) => void;
}

export default function Pharmacies({
  cupons = [],
  onAddCupom,
  onDeleteCupom,
}: PharmaciesProps) {
  const [showReceiptScan, setShowReceiptScan] = useState(false);
  const [expandedCupomId, setExpandedCupomId] = useState<string | null>(null);
  const [confirmCupomId, setConfirmCupomId] = useState<{ id: string; establishment: string } | null>(null);

  // Calculate total spent in all receipts
  const totalSpent = cupons.reduce((sum, c) => sum + (c.totalPrice || 0), 0);

  // If the scanner interface is triggered, render it in place
  if (showReceiptScan) {
    return (
      <ReceiptScanner
        onScanComplete={(est, dt, items, total) => {
          onAddCupom(est, dt, items, total);
          setShowReceiptScan(false);
        }}
        onCancel={() => setShowReceiptScan(false)}
      />
    );
  }

  return (
    <div className="pb-32 px-4 max-w-md lg:max-w-4xl mx-auto pt-6 animate-fade-in">
      {/* Title Card */}
      <div className="bg-brand-teal text-brand-cream rounded-3xl p-6 shadow-md mb-6 flex items-center justify-between">
        <div>
          <span className="text-[10px] font-bold text-brand-coral uppercase tracking-widest font-mono">
            Economia & Saúde
          </span>
          <h2 className="text-xl font-display font-bold">Notas Fiscais</h2>
          <p className="text-xs text-brand-cream/80 font-sans mt-0.5">Leitura inteligente e histórico de comprovantes.</p>
        </div>
        <div className="w-12 h-12 bg-brand-teal-light rounded-full flex items-center justify-center text-brand-coral">
          <Receipt className="w-6 h-6 stroke-[2]" />
        </div>
      </div>

      <div className="space-y-6">
        {/* Expenditure Summary banner */}
        <div className="bg-brand-teal text-brand-cream rounded-3xl p-6 shadow-xs flex items-center justify-between">
          <div>
            <span className="text-[9px] font-bold text-brand-coral uppercase tracking-widest font-mono">
              Gastos Farmacêuticos
            </span>
            <p className="text-xs text-brand-cream/70 mt-1 leading-none">Total Acumulado</p>
            <h3 className="text-2xl font-display font-extrabold text-brand-cream mt-1.5">
              R$ {totalSpent.toFixed(2).replace(".", ",")}
            </h3>
          </div>
          
          <button
            onClick={() => setShowReceiptScan(true)}
            className="px-4 py-3 bg-brand-coral hover:bg-brand-coral-light hover:scale-[1.02] active:scale-[0.98] transition-all text-brand-cream text-xs font-bold rounded-2xl flex items-center gap-1.5 shadow-md animate-pulse"
          >
            <Sparkles className="w-4 h-4 fill-brand-cream/10" />
            Escanear Nota
          </button>
        </div>

        {/* List of scanned receipts */}
        <div className="space-y-4">
          <h3 className="text-xs font-bold text-brand-teal uppercase tracking-wider">
            Comprovantes Salvos ({cupons.length})
          </h3>

          {cupons.length === 0 ? (
            <div className="bg-white border border-brand-cream-darker rounded-3xl p-8 text-center text-xs text-gray-400 font-sans">
              <Receipt className="w-8 h-8 mx-auto mb-2 text-brand-teal-pale" />
              Nenhuma nota fiscal escaneada.<br />
              <button
                onClick={() => setShowReceiptScan(true)}
                className="mt-3 text-xs font-bold text-brand-teal underline hover:text-brand-coral"
              >
                Escanear nota agora
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {cupons.map((cupom) => {
              const isExpanded = expandedCupomId === cupom.cupomId;
              return (
                <div
                  key={cupom.cupomId}
                  className="bg-white border border-brand-cream-darker rounded-3xl p-5 shadow-xs transition-all hover:shadow-xs relative"
                >
                  {/* Header info */}
                  <div className="flex justify-between items-start">
                    <div className="space-y-1 pr-8">
                      <h4 className="text-sm font-bold text-brand-teal font-display">{cupom.establishment}</h4>
                      <p className="text-[10px] text-gray-400 font-sans flex items-center gap-1">
                        <Calendar className="w-3.5 h-3.5 text-brand-teal/40" />
                        <span>{cupom.date}</span>
                      </p>
                    </div>

                    <button
                      onClick={() => setConfirmCupomId({ id: cupom.cupomId, establishment: cupom.establishment })}
                      className="p-1.5 rounded-lg text-gray-300 hover:text-red-500 hover:bg-red-50 transition-all absolute top-4 right-4"
                      title="Remover comprovante"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>

                  <div className="border-t border-brand-cream-darker mt-4 pt-3 flex items-center justify-between">
                    <div>
                      <span className="text-[9px] text-gray-400 uppercase tracking-wide block">Valor Total</span>
                      <span className="text-base font-display font-extrabold text-brand-coral">
                        R$ {cupom.totalPrice.toFixed(2).replace(".", ",")}
                      </span>
                    </div>

                    <button
                      onClick={() => setExpandedCupomId(isExpanded ? null : cupom.cupomId)}
                      className="flex items-center gap-1 text-[11px] font-bold text-brand-teal hover:text-brand-coral transition-colors"
                    >
                      {isExpanded ? (
                        <>
                          Ocultar Itens <ChevronUp className="w-4 h-4" />
                        </>
                      ) : (
                        <>
                          Ver {cupom.items.length} Itens <ChevronDown className="w-4 h-4" />
                        </>
                      )}
                    </button>
                  </div>

                  {/* Expandable items accordion breakdown */}
                  {isExpanded && (
                    <div className="mt-4 pt-3 border-t border-dashed border-brand-cream-darker space-y-2 bg-brand-cream-dark/20 p-3 rounded-2xl animate-fade-in">
                      <p className="text-[9px] font-bold text-brand-teal/60 uppercase tracking-wider mb-1">
                        Detalhamento do Comprovante
                      </p>
                      {cupom.items.map((item, idx) => (
                        <div key={idx} className="flex justify-between items-center text-xs text-brand-teal">
                          <span className="truncate max-w-[70%] text-[11px] font-sans">
                            • {item.name}
                          </span>
                          <span className="font-semibold text-[11px] shrink-0 font-mono">
                            R$ {item.price.toFixed(2).replace(".", ",")}
                          </span>
                        </div>
                      ))}
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
        open={!!confirmCupomId}
        title="Remover comprovante"
        message={`Remover o comprovante fiscal da "${confirmCupomId?.establishment}"?`}
        danger
        confirmLabel="Remover"
        onConfirm={() => {
          if (confirmCupomId) onDeleteCupom(confirmCupomId.id);
          setConfirmCupomId(null);
        }}
        onCancel={() => setConfirmCupomId(null)}
      />
    </div>
  );
}
