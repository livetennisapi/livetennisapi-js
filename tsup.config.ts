import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  // No runtime dependencies — `ws` is an optional peer resolved dynamically
  // only on Node versions without a global WebSocket.
  external: ['ws'],
});
