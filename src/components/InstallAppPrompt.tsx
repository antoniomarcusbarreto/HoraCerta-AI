// Install-the-PWA invitations. The app is not a native store app, so getting it
// onto the home screen is what unlocks the full-screen window and — the part
// users actually care about — dose reminders while the app is closed.
//
// Until now that only existed as a small button at the very bottom of the
// Perfil tab. These three pieces put the same action in front of the user:
//   <InstallAppSheet />   bottom sheet, once per session, snoozable
//   <InstallAppCard />    quiet reminder on the Home tab
//   <InstallGuideModal /> illustrated step-by-step for browsers with no prompt
//
// None of them render when the app is already installed — that check lives in
// useInstallPrompt, not here.

import { Check, ChevronRight, MoreVertical, PlusSquare, Share, Smartphone, X } from "lucide-react";
import type { InstallPlatform } from "../hooks/useInstallPrompt";

// ============================================================
// Bottom sheet
// ============================================================

interface InstallAppSheetProps {
  open: boolean;
  platform: InstallPlatform;
  onInstall: () => void;
  onDismiss: () => void;
}

const BENEFITS = [
  "Ícone próprio na tela inicial do celular",
  "Abre em tela cheia, sem a barra do navegador",
  "Lembretes de dose mesmo com o app fechado",
];

export function InstallAppSheet({ open, platform, onInstall, onDismiss }: InstallAppSheetProps) {
  if (!open) return null;

  const isIOS = platform === "ios-safari" || platform === "ios-other";

  return (
    // z-[55] sits above BottomNavBar (z-40) but below the guide modal (z-[65]).
    // The success toast is z-50 and anchored to the top, so they never overlap.
    <div className="fixed inset-x-0 bottom-0 z-[55] flex justify-center animate-slide-up">
      <div className="w-full max-w-md bg-brand-cream rounded-t-3xl border-t border-x border-brand-cream-darker shadow-2xl px-5 pt-5 pb-safe">
        <div className="flex items-start gap-3 mb-4">
          <div className="w-11 h-11 shrink-0 rounded-2xl bg-brand-peach text-brand-coral flex items-center justify-center">
            <Smartphone className="w-5 h-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-display font-bold text-brand-teal leading-tight">
              Instale o HoraCerta no seu celular
            </h3>
            <p className="text-[11px] text-gray-500 font-sans mt-0.5 leading-snug">
              É grátis e leva 10 segundos — não ocupa espaço como um app comum.
            </p>
          </div>
          <button
            onClick={onDismiss}
            aria-label="Fechar"
            className="w-8 h-8 shrink-0 rounded-full flex items-center justify-center text-gray-400 hover:bg-brand-cream-darker transition-all"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <ul className="space-y-2 mb-5">
          {BENEFITS.map((benefit) => (
            <li key={benefit} className="flex items-center gap-2">
              <div className="w-4 h-4 shrink-0 rounded-full bg-brand-teal-pale text-brand-teal flex items-center justify-center">
                <Check className="w-2.5 h-2.5" strokeWidth={3} />
              </div>
              <span className="text-[11px] text-brand-teal font-sans">{benefit}</span>
            </li>
          ))}
        </ul>

        <button
          onClick={onInstall}
          className="w-full py-3.5 rounded-2xl bg-brand-coral text-white text-xs font-bold uppercase tracking-wider shadow-xs hover:bg-brand-coral-light transition-all flex items-center justify-center gap-2"
        >
          {isIOS ? "Ver como instalar" : "Instalar agora"}
          <ChevronRight className="w-4 h-4" />
        </button>
        <button
          onClick={onDismiss}
          className="w-full py-2.5 mt-1 text-[11px] font-bold text-gray-400 hover:text-brand-teal transition-all"
        >
          Agora não
        </button>
      </div>
    </div>
  );
}

// ============================================================
// Home tab card
// ============================================================

interface InstallAppCardProps {
  onInstall: () => void;
}

export function InstallAppCard({ onInstall }: InstallAppCardProps) {
  return (
    <button
      onClick={onInstall}
      className="w-full mb-6 bg-brand-peach border border-brand-coral-light/50 rounded-3xl p-4 flex items-center gap-3 text-left hover:bg-brand-peach/70 transition-all animate-fade-in"
    >
      <div className="w-10 h-10 shrink-0 rounded-2xl bg-white text-brand-coral flex items-center justify-center shadow-xs">
        <Smartphone className="w-5 h-5" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-bold text-brand-teal font-display leading-tight">
          Instale o app no seu celular
        </p>
        <p className="text-[10px] text-gray-500 font-sans mt-0.5 leading-snug">
          Receba os lembretes de dose mesmo com o app fechado.
        </p>
      </div>
      <ChevronRight className="w-4 h-4 shrink-0 text-brand-coral" />
    </button>
  );
}

// ============================================================
// Step-by-step guide
// ============================================================

interface Step {
  text: string;
  strong?: string;
  icon?: any;
}

// iOS never fires beforeinstallprompt, and Chromium withholds it in some
// states, so every platform needs a manual path we can show.
function stepsFor(platform: InstallPlatform): Step[] {
  switch (platform) {
    case "ios-safari":
      return [
        { text: "Toque no botão", strong: "Compartilhar", icon: Share },
        { text: "Role a lista e toque em", strong: "Adicionar à Tela de Início", icon: PlusSquare },
        { text: "Confirme tocando em", strong: "Adicionar", icon: Check },
      ];
    case "ios-other":
      return [
        { text: "Abra horacerta-ai.com no", strong: "Safari", icon: Share },
        { text: "Toque em Compartilhar e depois em", strong: "Adicionar à Tela de Início", icon: PlusSquare },
        { text: "Confirme tocando em", strong: "Adicionar", icon: Check },
      ];
    case "desktop":
      return [
        { text: "Clique no ícone de instalar na", strong: "barra de endereço", icon: PlusSquare },
        { text: "Ou abra o menu do navegador e escolha", strong: "Instalar HoraCerta AI", icon: MoreVertical },
        { text: "Confirme em", strong: "Instalar", icon: Check },
      ];
    default:
      return [
        { text: "Abra o menu do navegador no canto superior direito", strong: "⋮", icon: MoreVertical },
        { text: "Toque em", strong: "Instalar app", icon: PlusSquare },
        { text: "Confirme em", strong: "Instalar", icon: Check },
      ];
  }
}

interface InstallGuideModalProps {
  open: boolean;
  platform: InstallPlatform;
  onClose: () => void;
  onConfirmInstalled: () => void;
}

export function InstallGuideModal({ open, platform, onClose, onConfirmInstalled }: InstallGuideModalProps) {
  if (!open) return null;

  const steps = stepsFor(platform);
  const isIOS = platform === "ios-safari" || platform === "ios-other";

  return (
    <div
      className="fixed inset-0 bg-black/50 z-[65] flex items-center justify-center p-4 backdrop-blur-xs animate-fade-in"
      onClick={onClose}
    >
      <div
        className="bg-brand-cream rounded-3xl max-w-sm w-full p-6 shadow-xl border border-brand-cream-darker animate-scale-up max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="w-12 h-12 rounded-full bg-brand-peach text-brand-coral flex items-center justify-center mx-auto mb-4">
          <Smartphone className="w-6 h-6" />
        </div>
        <h3 className="text-lg font-display font-bold text-brand-teal text-center mb-1">
          {isIOS ? "Instalar no iPhone" : "Instalar no seu aparelho"}
        </h3>
        <p className="text-xs text-gray-500 text-center mb-6 leading-relaxed">
          {isIOS
            ? "O iPhone não instala sozinho — são três toques e pronto."
            : "Siga os passos abaixo no seu navegador."}
        </p>

        <ol className="space-y-3 mb-6">
          {steps.map((step, index) => {
            const Icon = step.icon;
            return (
              <li key={index} className="flex items-start gap-3 bg-white rounded-2xl p-3 border border-brand-cream-darker">
                <div className="w-6 h-6 shrink-0 rounded-full bg-brand-teal text-brand-cream flex items-center justify-center text-[10px] font-bold font-mono">
                  {index + 1}
                </div>
                <p className="text-[11px] text-brand-teal font-sans leading-snug flex-1 pt-0.5">
                  {step.text}{" "}
                  <strong className="font-bold">{step.strong}</strong>
                </p>
                {Icon && <Icon className="w-4 h-4 shrink-0 text-brand-coral mt-0.5" />}
              </li>
            );
          })}
        </ol>

        <div className="flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 py-3 rounded-xl border border-brand-cream-darker text-brand-teal text-xs font-bold hover:bg-white transition-all"
          >
            Fechar
          </button>
          {/* On iOS the app's storage is sandboxed away from Safari's, so the
              browser can never tell us the install happened. This button is the
              only way to stop asking someone who already installed it. */}
          <button
            onClick={onConfirmInstalled}
            className="flex-1 py-3 rounded-xl bg-brand-teal text-white text-xs font-bold hover:bg-brand-teal-light transition-all shadow-xs"
          >
            Já instalei
          </button>
        </div>
      </div>
    </div>
  );
}
