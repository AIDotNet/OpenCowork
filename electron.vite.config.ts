import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        external: ['better-sqlite3', '@jitsi/robotjs']
      }
    },
    assetsInclude: ['**/*.ico']
  },
  preload: {},
  renderer: {
    server: {
      port: 3003,
      strictPort: true
    },
    optimizeDeps: {
      include: [
        'react',
        'react-dom',
        'react-dom/client',
        'i18next',
        'react-i18next',
        'zustand',
        'immer',
        'clsx',
        'lucide-react',
        'sonner',
        'cmdk',
        'gpt-tokenizer',
        'nanoid',
        'class-variance-authority',
        '@xterm/xterm',
        '@xterm/addon-fit',
        '@xterm/addon-search',
        'mermaid',
        'partial-json',
        'motion',
        'framer-motion'
      ],
      exclude: ['@monaco-editor/react', '@monaco-editor/loader', 'monaco-editor']
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
