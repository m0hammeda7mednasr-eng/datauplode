import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  return {
    // React JSX is compiled by Vite/esbuild using tsconfig's react-jsx setting.
    // Keeping the config dependency-free avoids production/CI failures when
    // optional Fast Refresh tooling is not installed.
    plugins: [tailwindcss()],
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      hmr: process.env.DISABLE_HMR !== 'true',
      allowedHosts: ['.ngrok-free.dev', '.ngrok-free.app', '.ngrok.io'],
    },
  };
});
