import React from "react";
import { AlertTriangle } from "lucide-react";
import { useDialogA11y } from "../hooks/useDialogA11y";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirmar",
  cancelLabel = "Cancelar",
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const panelRef = useDialogA11y<HTMLDivElement>(open, onCancel);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4 backdrop-blur-xs animate-fade-in"
      onClick={onCancel}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        tabIndex={-1}
        className="bg-brand-cream rounded-3xl max-w-sm w-full p-6 shadow-xl border border-brand-cream-darker animate-scale-up"
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className={`w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-4 ${
            danger ? "bg-error-50 text-error-500" : "bg-brand-peach text-brand-coral"
          }`}
        >
          <AlertTriangle className="w-6 h-6" />
        </div>
        <h3 id="confirm-dialog-title" className="text-lg font-display font-bold text-brand-teal text-center mb-1">{title}</h3>
        <p className="text-xs text-ink-soft text-center mb-6 leading-relaxed">{message}</p>
        <div className="flex gap-2">
          <button
            onClick={onCancel}
            className="flex-1 py-3 rounded-xl border border-brand-cream-darker text-brand-teal text-xs font-bold hover:bg-white transition-all"
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            className={`flex-1 py-3 rounded-xl text-xs font-bold text-white transition-all shadow-xs ${
              danger ? "bg-error-500 hover:bg-error-600" : "bg-brand-teal hover:bg-brand-teal-dark"
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
