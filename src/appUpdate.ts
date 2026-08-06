// Mantém o app rodando sempre a versão publicada, inclusive quando ele está
// "instalado" (PWA) no celular.
//
// Por que não bastava o que existia antes:
//  1. O único gatilho de atualização era o `controllerchange` do service
//     worker, e o navegador só troca de SW quando o /sw.js muda byte a byte.
//     Como o sw.js era estático, um deploy que mexia só no bundle React nunca
//     produzia um SW novo — logo, nunca reload, nunca atualização.
//  2. O navegador só procura por SW novo em navegação de página. Um PWA
//     instalado (Android ou iOS) quase nunca navega: o usuário alterna de app e
//     volta, e a mesma sessão fica viva por dias. Sem chamar `reg.update()`
//     explicitamente ao voltar para o primeiro plano, a checagem não acontece.
//
// A estratégia aqui: cada build carimba uma versão (vite.config.ts) em
// /version.json e dentro do sw.js. O cliente compara a versão que ele carregou
// com a que está publicada, sempre que faz sentido perguntar (boot, volta ao
// primeiro plano, reconexão, e um heartbeat lento), e recarrega limpando os
// caches quando elas divergem.

declare const __APP_VERSION__: string;

/** Versão embutida neste bundle no momento do build. */
export const BUILD_VERSION =
  typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";

const VERSION_URL = "/version.json";
/** Heartbeat para quem deixa o app aberto na frente por horas. */
const CHECK_INTERVAL_MS = 15 * 60 * 1000;
/** Não repetir a checagem em rajada (vários eventos disparam quase juntos). */
const MIN_CHECK_GAP_MS = 60 * 1000;
const RELOAD_GUARD_KEY = "horacerta_update_reload";
/** Teto de reloads para a MESMA versão-alvo, contra loop de recarga. */
const MAX_RELOADS_PER_VERSION = 2;

let lastCheckAt = 0;
let reloading = false;
let pendingVersion: string | null = null;
let onUpdateReady: ((version: string) => void) | null = null;
let started = false;

/** Existe versão nova detectada e ainda não aplicada? */
export function isUpdatePending(): boolean {
  return pendingVersion !== null;
}

/**
 * Aplica a atualização: limpa os caches do service worker (para que o shell
 * velho não seja servido de novo) e recarrega.
 *
 * A trava de loop é essencial: se por qualquer motivo o HTML servido continuar
 * apontando para o bundle antigo (CDN com cache preso, por exemplo), sem ela o
 * app entraria em recarga infinita na mão do usuário.
 */
export async function applyAppUpdate(): Promise<void> {
  if (reloading) return;

  const target = pendingVersion || "unknown";
  try {
    const raw = localStorage.getItem(RELOAD_GUARD_KEY);
    const guard = raw ? JSON.parse(raw) : null;
    // Só conta como tentativa repetida se for o mesmo alvo E partindo do mesmo
    // build — ver clearReloadGuardIfUpdated().
    const sameAttempt = guard && guard.version === target && guard.from === BUILD_VERSION;
    if (sameAttempt && guard.count >= MAX_RELOADS_PER_VERSION) {
      console.warn(
        "[update] versão nova detectada, mas o reload não trouxe o bundle novo. Desistindo para não entrar em loop."
      );
      return;
    }
    localStorage.setItem(
      RELOAD_GUARD_KEY,
      JSON.stringify({
        version: target,
        from: BUILD_VERSION,
        count: sameAttempt ? guard.count + 1 : 1,
      })
    );
  } catch {
    /* localStorage indisponível (modo privado): segue sem a trava */
  }

  reloading = true;

  // Deixa o SW novo assumir imediatamente se ele estiver parado em "waiting".
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    reg?.waiting?.postMessage({ type: "SKIP_WAITING" });
  } catch {
    /* melhor esforço */
  }

  try {
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    }
  } catch {
    /* melhor esforço — o reload abaixo ainda pega rede primeiro */
  }

  window.location.reload();
}

/**
 * Se o build que está rodando agora não é o mesmo de onde partiu a última
 * tentativa de recarga, então aquela recarga funcionou: a trava anti-loop já
 * cumpriu o papel e precisa sair do caminho, senão o contador antigo bloquearia
 * a atualização seguinte.
 */
function clearReloadGuardIfUpdated() {
  try {
    const raw = localStorage.getItem(RELOAD_GUARD_KEY);
    if (!raw) return;
    const guard = JSON.parse(raw);
    if (guard?.from !== BUILD_VERSION) localStorage.removeItem(RELOAD_GUARD_KEY);
  } catch {
    /* ignorado */
  }
}

function markUpdateAvailable(version: string) {
  if (reloading) return;
  pendingVersion = version;

  // Com o app em segundo plano ninguém está olhando: recarrega calado, e o
  // usuário simplesmente volta para a versão nova. Só incomoda quem está
  // usando o app naquele instante (aí quem decide a hora é ele).
  if (typeof document !== "undefined" && document.visibilityState === "hidden") {
    void applyAppUpdate();
    return;
  }

  onUpdateReady?.(version);
}

/**
 * Pergunta ao servidor qual versão está publicada. `force` ignora a janela
 * mínima entre checagens (usado no boot).
 */
export async function checkForAppUpdate(force = false): Promise<void> {
  if (reloading) return;
  const now = Date.now();
  if (!force && now - lastCheckAt < MIN_CHECK_GAP_MS) return;
  lastCheckAt = now;

  // Pede ao navegador para reavaliar o /sw.js. Sem isso, um PWA instalado que
  // só é retomado do segundo plano jamais procura por um worker novo.
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    await reg?.update();
  } catch {
    /* offline / sem SW: a comparação de versão abaixo ainda pode funcionar */
  }

  // Em dev não existe /version.json (o servidor devolve HTML para qualquer
  // rota desconhecida), e recarregar durante o HMR só atrapalharia.
  // Cast como em dbLocalFallback.ts/firebase.ts (sem vite/client types aqui).
  if ((import.meta as any).env?.DEV) return;

  try {
    const res = await fetch(`${VERSION_URL}?t=${now}`, { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    const published = typeof data?.version === "string" ? data.version : null;
    if (!published || published === BUILD_VERSION) return;
    markUpdateAvailable(published);
  } catch {
    /* rede indisponível: tenta de novo no próximo gatilho */
  }
}

/**
 * Liga o verificador de versão. Deve ser chamado uma única vez, no boot do app.
 * `onUpdateReady` é chamado quando há versão nova e o usuário está com o app em
 * primeiro plano — a UI decide como avisar; a aplicação em si é `applyAppUpdate`.
 */
export function initAppUpdater(
  options: { onUpdateReady?: (version: string) => void } = {}
): void {
  if (typeof window === "undefined" || started) return;
  started = true;
  onUpdateReady = options.onUpdateReady ?? null;
  clearReloadGuardIfUpdated();

  if ("serviceWorker" in navigator) {
    // updateViaCache: "none" impede que o próprio /sw.js seja servido do cache
    // HTTP do navegador — senão a checagem de atualização compara o arquivo
    // novo com uma cópia velha e conclui que nada mudou.
    navigator.serviceWorker
      .register("/sw.js", { updateViaCache: "none" })
      .then((reg) => {
        // Um worker já instalado e esperando significa versão nova pronta.
        if (reg.waiting && navigator.serviceWorker.controller) {
          markUpdateAvailable("sw-waiting");
        }
        reg.addEventListener("updatefound", () => {
          const installing = reg.installing;
          if (!installing) return;
          installing.addEventListener("statechange", () => {
            // "installed" com controller presente = atualização (não primeira
            // instalação), então há um bundle novo esperando para assumir.
            if (installing.state === "installed" && navigator.serviceWorker.controller) {
              markUpdateAvailable("sw-installed");
            }
          });
        });
      })
      .catch((err) => {
        console.error("Falha ao registrar Service Worker:", err);
      });

    // Na primeira instalação o clients.claim() do SW também dispara
    // controllerchange; recarregar ali seria um reload gratuito no primeiro
    // acesso, por isso só reagimos quando já havia um controller antes.
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!hadController) return;
      void applyAppUpdate();
    });
  }

  void checkForAppUpdate(true);

  // Volta ao primeiro plano — o gatilho que realmente importa no PWA instalado,
  // já que trocar de app e voltar não recarrega a página.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      void checkForAppUpdate();
    } else if (pendingVersion) {
      // Ficou pendente porque o usuário estava usando o app; agora que ele
      // saiu, aplica sem atrapalhar ninguém.
      void applyAppUpdate();
    }
  });

  // pageshow com persisted=true = restauração do bfcache (comum no Safari/iOS),
  // que não dispara visibilitychange em todos os casos.
  window.addEventListener("pageshow", (event) => {
    if ((event as PageTransitionEvent).persisted) void checkForAppUpdate();
  });
  window.addEventListener("focus", () => void checkForAppUpdate());
  window.addEventListener("online", () => void checkForAppUpdate(true));

  window.setInterval(() => void checkForAppUpdate(), CHECK_INTERVAL_MS);
}
