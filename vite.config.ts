import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  root: 'web',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      // The server only answers its own host and origin, so present the request as coming from it.
      '/api': {
        target: 'http://127.0.0.1:4545',
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (req) => {
            if (req.getHeader('origin')) req.setHeader('origin', 'http://127.0.0.1:4545');
          });
        },
      },
    },
  },
});
