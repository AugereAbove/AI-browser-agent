import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
const directory = new URL('./dist/', import.meta.url);
await mkdir(directory, { recursive: true });
await build({ entryPoints: [new URL('./src/main.tsx', import.meta.url).pathname], outfile: new URL('./app.js', directory).pathname,
  bundle: true, minify: true, sourcemap: false, legalComments: 'external', platform: 'browser', target: ['es2022'],
  define: { 'process.env.NODE_ENV': '"production"' } });
for (const file of ['index.html', 'style.css']) await copyFile(new URL(`./src/${file}`, import.meta.url), new URL(file, directory));
