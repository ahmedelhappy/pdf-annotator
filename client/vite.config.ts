import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:5174' },
    // the parity test imports the server copy of the ink geometry
    fs: { allow: ['..'] },
  },
  test: {
    environment: 'node',
    include: ['src/test/**/*.test.ts'],
  },
});
