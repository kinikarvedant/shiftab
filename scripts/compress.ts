// After `vite build`: write .br and .gz copies of the text assets so the server can send them pre-compressed
// (@fastify/static `preCompressed`). Roughly a quarter of the bytes on a phone's first load, at no CPU cost per request.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
let raw = 0, small = 0;
for (const file of walk('dist')) {
  if (!/\.(js|css|html|svg|webmanifest|json|txt)$/.test(file)) continue;
  const data = readFileSync(file);
  if (data.length < 1024) continue;
  const br = brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } });
  writeFileSync(`${file}.br`, br);
  writeFileSync(`${file}.gz`, gzipSync(data, { level: 9 }));
  raw += data.length; small += br.length;
}
console.log(`pre-compressed assets: ${Math.round(raw / 1024)} KB -> ${Math.round(small / 1024)} KB (brotli)`);
