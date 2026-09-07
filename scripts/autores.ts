// Construye el mapa de autores: id de coautor -> nombre real con acentos.
//
// La API expone /wp/v2/coauthors, pero su campo `name` viene en forma slug
// ("carlos-monsivais"). El nombre real solo está en la página pública del
// autor. Este script los recupera uno por uno y los cachea en disco, porque
// son ~3,450 peticiones a 300ms: no queremos repetirlas en cada ingesta.
//
// Es reanudable: guarda cada 25 autores, así que si se corta, la siguiente
// corrida sigue donde se quedó.
import './lib/red.js';
import 'dotenv/config';
import { type CacheAutores, RUTA_CACHE, leerCache, guardarCache } from './lib/cache-autores.js';
import { listarCoautores, nombreRealDeCoautor, sleep } from './lib/wp.js';

const DELAY_MS = 300;
const GUARDAR_CADA = 25;

async function main() {
  console.log('Archivo Nexos — mapa de autores (id -> nombre real)\n');

  const cache: CacheAutores = leerCache() ?? { actualizado_en: '', nombres: {}, sin_resolver: [] };
  const yaResueltos = Object.keys(cache.nombres).length;
  if (yaResueltos > 0) console.log(`Cache existente: ${yaResueltos} autores ya resueltos.\n`);

  console.log('Listando coautores desde /wp/v2/coauthors...');
  const coautores = await listarCoautores(DELAY_MS);
  console.log(`${coautores.length} coautores en la taxonomía.\n`);

  const fallidos = new Set(cache.sin_resolver);
  let procesados = 0;

  for (const [i, coautor] of coautores.entries()) {
    if (cache.nombres[coautor.id]) continue; // ya en cache
    procesados++;

    const nombre = await nombreRealDeCoautor(coautor.slug);
    if (nombre) {
      cache.nombres[coautor.id] = nombre;
      fallidos.delete(coautor.slug);
    } else {
      fallidos.add(coautor.slug);
    }

    if (procesados % GUARDAR_CADA === 0) {
      cache.sin_resolver = [...fallidos];
      guardarCache(cache);
      console.log(`  ${i + 1}/${coautores.length} · resueltos ${Object.keys(cache.nombres).length} · sin resolver ${fallidos.size}`);
    }

    await sleep(DELAY_MS);
  }

  cache.sin_resolver = [...fallidos];
  guardarCache(cache);

  console.log('\n=== MAPA DE AUTORES ===');
  console.log(`Coautores en la taxonomía: ${coautores.length}`);
  console.log(`Resueltos con nombre real: ${Object.keys(cache.nombres).length}`);
  console.log(`Sin resolver:              ${fallidos.size}`);
  console.log(`Cache:                     ${RUTA_CACHE}`);
  if (fallidos.size > 0) {
    console.log('\nLos que no se resolvieron quedan sin autor (`autor no consignado`), nunca con el slug.');
  }
}

main().catch((err) => {
  console.error('\nFalló la construcción del mapa de autores:', err);
  process.exit(1);
});
