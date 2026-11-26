#!/usr/bin/env node
// Bundles the WYSIWYG editor (src/editor) into a single browser ES module: public/vendor/editor.js.
// The bundle is committed, so the Docker image needs no build step. Run after changing src/editor:
//   npm run build:editor
import { build } from 'esbuild';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');

await build({
  entryPoints: [path.join(ROOT, 'src', 'editor', 'index.js')],
  outfile: path.join(ROOT, 'public', 'vendor', 'editor.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2020'],
  minify: true,
  legalComments: 'eof',
  logLevel: 'info',
});
