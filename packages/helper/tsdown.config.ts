import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { main: 'src/main.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: true,
  deps: { neverBundle: ['electron'] },
})
