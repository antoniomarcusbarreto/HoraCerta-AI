// Single source of truth about "is this app installed / can it be installed".
//
// Before this hook, App.tsx captured `beforeinstallprompt` inline and computed
// standalone mode exactly once on mount, which meant: installing the app from
// the browser's own menu never updated the UI, and the "Instalar" button stayed
// visible in an already-installed app until a reload. Everything install-related
// now lives here so there is only ever one listener and one answer.

import { useCallback, useEffect, useState } from "react";
import { isIOSDevice } from "../push";

// Not part of lib.dom — Chromium-only event, so we type the bits we use.
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export type InstallPlatform =
  | "android"      // Chromium: real beforeinstallprompt available
  | "ios-safari"   // manual "Compartilhar > Adicionar à Tela de Início"
  | "ios-other"    // Chrome/Firefox/Edge on iOS: must be opened in Safari first
  | "desktop"      // Chromium desktop: installable, but we only surface it in Perfil
  | "unsupported";

export type InstallOutcome = "accepted" | "dismissed" | "manual";

// Device-level flags, deliberately NOT cleared by dbLocal.clearLocalData() on
// logout: they describe this browser, not the signed-in person, and they carry
// no health data.
const DISMISSED_KEY = "horacerta_install_dismissed_at";
const INSTALLED_KEY = "horacerta_install_done";

const DEFAULT_SNOOZE_DAYS = 7;
const STANDALONE_QUERY = "(display-mode: standalone)";

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia(STANDALONE_QUERY).matches ||
    (window.navigator as any).standalone === true
  );
}

function readTimestamp(key: string): number | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const ms = new Date(raw).getTime();
    return Number.isNaN(ms) ? null : ms;
  } catch {
    return null;
  }
}

function writeTimestamp(key: string) {
  try {
    localStorage.setItem(key, new Date().toISOString());
  } catch {
    /* private mode / storage disabled — the prompt just reappears next session */
  }
}

function detectPlatform(): InstallPlatform {
  if (typeof navigator === "undefined") return "unsupported";

  if (isIOSDevice()) {
    // Every iOS browser is WebKit, but only Safari exposes "Adicionar à Tela de
    // Início" in its share sheet — the others have to hand the user back to it.
    return /CriOS|FxiOS|EdgiOS|OPiOS/.test(navigator.userAgent) ? "ios-other" : "ios-safari";
  }

  if (/Android/.test(navigator.userAgent)) return "android";
  return "desktop";
}

export interface UseInstallPrompt {
  /** App is running from the home screen, or the user already confirmed installing. */
  isInstalled: boolean;
  /** Not installed and this browser can install it — drives the quiet Home card. */
  isInstallable: boolean;
  /** Same, but also respects the 7-day snooze — drives the interrupting sheet. */
  canInstall: boolean;
  platform: InstallPlatform;
  /** True when the browser handed us a real prompt we can fire. */
  hasNativePrompt: boolean;
  /** Fires the native prompt, or returns "manual" when the UI must explain the steps. */
  promptInstall: () => Promise<InstallOutcome>;
  /** Hide the invitation for N days (default 7). */
  snooze: (days?: number) => void;
  /** Stop inviting for good on this browser (iOS "Já instalei", or `appinstalled`). */
  markInstalled: () => void;
}

export function useInstallPrompt(): UseInstallPrompt {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState<boolean>(
    () => isStandalone() || readTimestamp(INSTALLED_KEY) !== null,
  );
  const [snoozedUntil, setSnoozedUntil] = useState<number>(() => {
    const at = readTimestamp(DISMISSED_KEY);
    return at === null ? 0 : at + DEFAULT_SNOOZE_DAYS * 24 * 60 * 60 * 1000;
  });
  const [platform] = useState<InstallPlatform>(detectPlatform);

  const markInstalled = useCallback(() => {
    writeTimestamp(INSTALLED_KEY);
    setInstalled(true);
    setDeferredPrompt(null);
  }, []);

  const snooze = useCallback((days: number = DEFAULT_SNOOZE_DAYS) => {
    writeTimestamp(DISMISSED_KEY);
    setSnoozedUntil(Date.now() + days * 24 * 60 * 60 * 1000);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleBeforeInstallPrompt = (e: Event) => {
      // Suppress Chrome's own mini-infobar so our sheet is the single ask.
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };

    // Fires even when the user installs from the browser menu instead of our
    // button — this is what makes the invitation disappear at the right moment.
    const handleAppInstalled = () => markInstalled();

    const mql = window.matchMedia(STANDALONE_QUERY);
    const handleDisplayModeChange = (e: MediaQueryListEvent) => {
      if (e.matches) markInstalled();
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleAppInstalled);
    mql.addEventListener("change", handleDisplayModeChange);

    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("appinstalled", handleAppInstalled);
      mql.removeEventListener("change", handleDisplayModeChange);
    };
  }, [markInstalled]);

  const promptInstall = useCallback(async (): Promise<InstallOutcome> => {
    if (!deferredPrompt) return "manual";

    try {
      await deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      // A deferred prompt is single-use: once fired, the browser will not give
      // us the same event again until the page reloads.
      setDeferredPrompt(null);
      if (outcome === "dismissed") snooze();
      // On "accepted" we intentionally do NOT flip `installed` here — the
      // `appinstalled` event is the authority, and it fires moments later.
      return outcome;
    } catch (err) {
      console.error("PWA install error:", err);
      setDeferredPrompt(null);
      return "manual";
    }
  }, [deferredPrompt, snooze]);

  const isSnoozed = snoozedUntil > Date.now();
  // iOS has no beforeinstallprompt at all, so there we go by platform alone.
  const installable =
    !installed && platform !== "unsupported" && (deferredPrompt !== null || isIOSDevice());

  return {
    isInstalled: installed,
    isInstallable: installable,
    // "Agora não" only silences the sheet — the Home card stays as a quiet
    // reminder, so someone who deferred can still install without hunting.
    canInstall: installable && !isSnoozed,
    platform,
    hasNativePrompt: deferredPrompt !== null,
    promptInstall,
    snooze,
    markInstalled,
  };
}
