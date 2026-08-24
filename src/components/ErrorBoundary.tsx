import React from "react";
import { AlertTriangle } from "lucide-react";
import { dbLocal } from "../dbLocalFallback";

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

// Last-resort net for a boot/render crash (e.g. a corrupted localStorage
// value slipping past dbLocalFallback's own guards). Without this, React
// unmounts the whole tree to a blank page with no recourse — which is what
// forced a user to manually clear their browser history to recover. This
// gives them a button instead.
export default class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  // This project has no @types/react installed (React's own untyped JS is
  // structurally inferred instead), and that inference doesn't surface
  // `props` as an inherited member on class components — declare it
  // explicitly so `this.props` below type-checks. No other component in the
  // codebase is a class component, so this gap was never hit until now.
  declare props: ErrorBoundaryProps;
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    console.error("ErrorBoundary caught a render crash:", error, info.componentStack);
  }

  handleReset = () => {
    try {
      localStorage.removeItem("horacerta_active_user_id");
      localStorage.removeItem("horacerta_active_admin_id");
      dbLocal.clearLocalData();
    } catch {
      // The crash may have been caused by a broken localStorage/JSON state
      // that the targeted cleanup above can't parse — fall back to wiping
      // everything so there is always a way out.
      try {
        localStorage.clear();
      } catch {
        /* nothing more we can do client-side */
      }
    }
    window.location.reload();
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="min-h-screen bg-brand-cream text-brand-teal flex flex-col justify-center items-center px-4 py-8 font-sans">
        <div className="w-full max-w-sm bg-white border border-brand-cream-darker rounded-[2.5rem] p-8 shadow-xl text-center">
          <div className="w-14 h-14 bg-error-50 text-error-500 rounded-3xl flex items-center justify-center mx-auto mb-4">
            <AlertTriangle className="w-7 h-7" />
          </div>
          <h1 className="text-lg font-display font-bold text-brand-teal mb-2">Algo deu errado</h1>
          <p className="text-xs text-ink-soft leading-relaxed mb-6">
            Encontramos um problema inesperado ao carregar o aplicativo. Toque no botão abaixo para
            reiniciar — seus dados na nuvem não são afetados.
          </p>
          <button
            onClick={this.handleReset}
            className="w-full py-3 rounded-xl bg-brand-teal hover:bg-brand-teal-dark text-white text-xs font-bold transition-all shadow-xs"
          >
            Tentar novamente
          </button>
        </div>
      </div>
    );
  }
}
