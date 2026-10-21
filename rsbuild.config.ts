import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { pluginTailwindcss } from '@rsbuild/plugin-tailwindcss';

export default defineConfig({
  plugins: [pluginReact(), pluginTailwindcss()],
  html: { title: 'Terminal — графики', lang: 'ru' },
  server: {
    host: '127.0.0.1',
    port: Number(process.env.TERMINAL_DEV_PORT ?? 3001),
    strictPort: true,
    printUrls: false,
  },
  dev: {
    client: {
      host: '127.0.0.1',
      port: Number(process.env.TERMINAL_DEV_PORT ?? 3001),
    },
  },
});
