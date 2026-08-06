import React from "react";
import { RefreshCw } from "lucide-react";

interface UpdateBannerProps {
  open: boolean;
  onUpdate: () => void;
}

/**
 * Avisa que existe uma versão nova publicada. Só aparece quando a atualização
 * é detectada com o app em primeiro plano — se o usuário estiver com o app em
 * segundo plano, appUpdate.ts recarrega sozinho e ninguém vê este aviso.
 *
 * Não tem botão de dispensar de propósito: o app se atualiza sozinho assim que
 * o usuário sair da tela, e um "agora não" permanente é justamente o que deixa
 * gente rodando versão antiga.
 */
const UpdateBanner: React.FC<UpdateBannerProps> = ({ open, onUpdate }) => {
  if (!open) return null;

  return (
    <div className="fixed bottom-24 lg:bottom-6 left-1/2 -translate-x-1/2 z-[60] max-w-sm w-[90%] bg-brand-teal text-brand-cream border-2 border-brand-coral-light/30 rounded-2xl px-4 py-3 shadow-xl flex items-center gap-3 animate-slide-down">
      <RefreshCw className="w-5 h-5 text-brand-coral shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-xs font-bold font-display">Nova versão disponível</p>
        <p className="text-[11px] text-brand-cream/80 font-sans mt-0.5">
          Atualize para receber as melhorias mais recentes.
        </p>
      </div>
      <button
        onClick={onUpdate}
        className="shrink-0 bg-brand-coral text-white text-[11px] font-bold font-display rounded-xl px-3 py-2 active:scale-95 transition-transform"
      >
        Atualizar
      </button>
    </div>
  );
};

export default UpdateBanner;
