import { defineConfig } from 'tsdown'

/** Browser vendor bundle for the ball window page (shiki + grammars). */
export default defineConfig({
  entry: { shiki: 'src/vendor-shiki.ts' },
  outDir: 'assets/vendor',
  format: ['esm'],
  platform: 'browser',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: true,
  minify: true,
})
