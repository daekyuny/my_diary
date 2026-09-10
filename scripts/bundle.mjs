import { build } from 'esbuild';
export async function bundle(outdir = 'vendor') {
  await build({
    entryPoints: ['src/journal/app.js'],
    outfile: `${outdir}/journal-app.js`,
    bundle: true,
    format: 'esm',
    target: ['es2022'],
    minify: true,
  });
}
