/**
 * Two artifacts: `lib/index.js` (Node half, ESM, dependencies external) and
 * `lib/client.js` (browser half). The browser half is a closure factory
 * handed to `window.__ModuleLoader__.load`, the format dsh's client-modules
 * loader expects; modules shared with the dsh Web shell stay `require`d from
 * its module table and everything else is inlined.
 */
import { defineConfig } from 'tsdown'

const ID = 'dsh-user-shell'

/** Modules the dsh Web shell provides to every client bundle. */
const SHELL_MODULES = new Set([
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
])

export default defineConfig([
  {
    name: `${ID}/host`,
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'node22',
    fixedExtension: false,
    dts: false,
    sourcemap: true,
    clean: false,
  },
  {
    name: `${ID}/client`,
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    dts: false,
    sourcemap: true,
    clean: false,
    deps: {
      neverBundle: (specifier: string) => SHELL_MODULES.has(specifier),
      alwaysBundle: (specifier: string) => !SHELL_MODULES.has(specifier),
    },
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  },
])
