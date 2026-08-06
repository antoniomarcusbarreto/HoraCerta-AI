import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import {defineConfig, type Plugin} from 'vite';

// Identidade do build. Na Vercel usamos o SHA do commit (estável entre os vários
// arquivos de um mesmo deploy); fora dela, o horário do build. É essa string que
// o cliente compara com /version.json para saber que existe versão nova.
const APP_VERSION =
  process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 8) ||
  process.env.APP_VERSION ||
  Date.now().toString(36);

// Escreve dist/version.json e carimba a versão dentro de dist/sw.js. O sw.js
// vem de public/ (copiado verbatim, sem passar pelo `define`), por isso a troca
// do placeholder é feita aqui, no disco, depois que o bundle foi escrito.
function appVersionPlugin(): Plugin {
  return {
    name: 'horacerta-app-version',
    apply: 'build',
    closeBundle() {
      const distDir = path.resolve(__dirname, 'dist');
      fs.writeFileSync(
        path.join(distDir, 'version.json'),
        JSON.stringify({version: APP_VERSION, builtAt: new Date().toISOString()}),
      );

      const swDist = path.join(distDir, 'sw.js');
      const swSource = fs.existsSync(swDist)
        ? swDist
        : path.resolve(__dirname, 'public', 'sw.js');
      const stamped = fs
        .readFileSync(swSource, 'utf-8')
        .replace(/__APP_VERSION__/g, APP_VERSION);
      fs.writeFileSync(swDist, stamped);
    },
  };
}

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss(), appVersionPlugin()],
    define: {
      // Disponível também em `vite serve`, senão o app quebraria em dev.
      __APP_VERSION__: JSON.stringify(APP_VERSION),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    build: {
      rollupOptions: {
        // Two entry points: the static marketing landing page at "/", and
        // the React app (login, dashboard, admin, etc.) at "/app".
        input: {
          main: path.resolve(__dirname, 'index.html'),
          app: path.resolve(__dirname, 'app/index.html'),
        },
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
