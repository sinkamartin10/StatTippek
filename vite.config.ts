import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

// A frontend soha nem kap API kulcsot: minden külső hívás a szerveren keresztül megy (/api).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@client': path.resolve(__dirname, 'src/client'),
    },
  },
  server: {
    port: 5173,
    // Megosztáshoz: hálózaton belülről (--host) és alagúton (Cloudflare/ngrok/localtunnel) érkező kérések engedélyezése
    allowedHosts: ['.trycloudflare.com', '.ngrok-free.app', '.ngrok.app', '.loca.lt'],
    proxy: {
      '/api': { target: 'http://localhost:3001', changeOrigin: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
