// npm run cobertura — backlog REAL de enriquecimiento, por sitio y por año.
//
// `resumen_linea IS NULL` no equivale a "pendiente": un artículo puede haber
// pasado por el modelo y quedar con resumen_linea vacío a propósito (poemas,
// aforismos, notas sin materia para un resumen de una línea — CLAUDE.md
// sección 7). La única fuente de verdad sobre qué se procesó de verdad es la
// bitácora `datos/enriquecidos.jsonl`. Ver CLAUDE.md sección 2, hallazgo del
// 2026-09-16.
import 'dotenv/config';
import { clienteSupabase } from './lib/supabase.js';
import { leerAvance } from './lib/avance-enriquecimiento.js';
import { SITIOS } from './lib/sitios.js';

const supabase = clienteSupabase();

interface Fila {
  id: number;
  sitio: string;
  anio_pub: number | null;
}

async function traerConResumenVacio(): Promise<Fila[]> {
  const filas: Fila[] = [];
  let desde = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('articulos')
      .select('id,sitio,anio_pub')
      .is('resumen_linea', null)
      .gt('id', desde)
      .order('id', { ascending: true })
      .limit(1000);
    if (error) throw new Error(`Error leyendo articulos: ${error.message}`);
    if (!data || data.length === 0) break;
    filas.push(...(data as Fila[]));
    desde = (data[data.length - 1] as Fila).id;
    if (data.length < 1000) break;
  }
  return filas;
}

async function main() {
  console.log('Archivo Nexos — cobertura real de enriquecimiento\n');

  const hechos = leerAvance();
  console.log(`Bitácora (${leerRuta()}): ${hechos.size} artículos ya procesados (ok o vacío a propósito)\n`);

  const conResumenVacio = await traerConResumenVacio();
  const pendientes = conResumenVacio.filter((f) => !hechos.has(f.id));
  const vaciosAProposito = conResumenVacio.length - pendientes.length;

  console.log(
    `Con resumen_linea NULL: ${conResumenVacio.length} total ` +
      `(${vaciosAProposito} ya procesados y vacíos a propósito, ${pendientes.length} de verdad pendientes)\n`,
  );

  // Por sitio.
  console.log('--- Por sitio ---');
  for (const sitio of SITIOS) {
    const delSitio = pendientes.filter((f) => f.sitio === sitio.clave);
    if (delSitio.length === 0) continue;
    console.log(`  ${sitio.clave}: ${delSitio.length} pendientes de verdad`);
  }
  if (pendientes.length === 0) console.log('  (ninguno)');

  // Por año, solo del sitio con más volumen de pendientes reales.
  const porAnio = new Map<number, number>();
  for (const f of pendientes) {
    if (f.anio_pub == null) continue;
    porAnio.set(f.anio_pub, (porAnio.get(f.anio_pub) ?? 0) + 1);
  }
  if (porAnio.size > 0) {
    console.log('\n--- Por año (todos los sitios) ---');
    for (const anio of [...porAnio.keys()].sort()) {
      console.log(`  ${anio}: ${porAnio.get(anio)}`);
    }
  }

  console.log(`\nTotal pendiente real: ${pendientes.length}`);
}

function leerRuta(): string {
  // Mismo valor que RUTA_AVANCE en avance-enriquecimiento.ts; se repite aquí
  // solo para el mensaje, no como fuente de verdad.
  return 'datos/enriquecidos.jsonl';
}

main().catch((err) => {
  console.error('Error calculando cobertura:', err);
  process.exit(1);
});
