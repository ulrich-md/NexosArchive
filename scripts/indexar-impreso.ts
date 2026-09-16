// npm run indexar-impreso — mete al índice de búsqueda el texto de los
// artículos cuyo cuerpo tenemos en las exportaciones WXR.
//
// Por qué hace falta: la ingesta de subdominios manda el cuerpo a
// `indexar_articulos` y lo descarta, así que esos artículos se encuentran por
// lo que dicen adentro. El enriquecimiento no hacía eso: leía el cuerpo, sacaba
// el resumen y lo tiraba sin indexar. Resultado medido — el artículo de 1994
// cuyo resumen dice "trayectoria literaria de Sergio Pitol" devolvía 0
// resultados al buscar "Sergio Pitol".
//
// Pega justo donde más importa: los artículos que el paywall tapa no tienen
// cuerpo en el índice, y sin sesión el carril `catalogo` —el que usa ese
// índice— es el único disponible.
//
// Al índice va el cuerpo MÁS el resumen y los temas, porque el resumen nombra
// cosas que el texto puede no decir con esas palabras. El cuerpo sigue sin
// almacenarse: entra a la función, se convierte en lexemas y muere ahí
// (CLAUDE.md §6).
import './lib/red.js';
import 'dotenv/config';
import { clienteSupabase } from './lib/supabase.js';
import { cargarCuerposXml } from './lib/cuerpos-xml.js';

// Cada artículo puede pesar hasta 200,000 caracteres (sin el recorte de 3,000
// que usa el enriquecimiento, porque aquí no hay límite de contexto de un LLM
// que respetar). Un lote de 50 puede sumar varios MB y el UPDATE de
// indexar_articulos —que recalcula to_tsvector sobre texto tan largo, 50 veces
// en la misma transacción— topa con el statement_timeout de Postgres.
// Medido: dos corridas reales murieron así. Con 10 el lote pesa una fracción
// y la transacción cierra bien dentro del tiempo permitido.
const LOTE = 10;
const SECO = process.argv.includes('--seco');

const sb = clienteSupabase();
// Sin recorte: al índice va el artículo entero, no los 3,000 caracteres que
// alcanzan para un resumen.
const cuerpos = cargarCuerposXml('datos/exports', 200_000);
console.log(`Cuerpos disponibles en los XML: ${cuerpos.size}\n`);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Un lote fallido no puede tirar la corrida entera: con 19,060 cuerpos y
 * lotes de 10 son ~1,900 llamadas, y a la primera que tope con un timeout
 * transitorio se perdería todo lo que faltaba. Reintenta con backoff y, si
 * de plano no pasa, se salta ESE lote (no el resto) y lo cuenta.
 */
async function indexarLote(filas: { id: number; cuerpo: string }[]): Promise<boolean> {
  for (let intento = 0; ; intento++) {
    const { error } = await sb.rpc('indexar_articulos', { p_filas: filas });
    if (!error) return true;
    if (intento >= 4) {
      console.warn(`
  ⚠ lote de ${filas.length} (ids ${filas[0].id}..${filas[filas.length - 1].id}) no se pudo indexar: ${error.message}`);
      return false;
    }
    await sleep(500 * 2 ** intento);
  }
}

let indexados = 0;
let sinCuerpo = 0;
let lotesFallidos = 0;
for (let desde = 0; ; desde += 1000) {
  // La misma lectura simple murió dos veces por timeout, casi seguro por la
  // carga de la base con varios `enriquecer.ts` escribiendo al mismo tiempo:
  // una lectura no debería tronar el script entero por contención pasajera.
  let data: { id: number; id_wp: number; resumen_linea: string | null; temas: string[] }[] | null = null;
  for (let intento = 0; ; intento++) {
    const r = await sb
      .from('articulos').select('id,id_wp,resumen_linea,temas')
      .eq('sitio', 'www').order('id').range(desde, desde + 999);
    if (!r.error) { data = r.data; break; }
    if (intento >= 5) throw new Error(`leyendo desde=${desde}: ${r.error.message}`);
    console.warn(`
  [reintento] leyendo desde=${desde} (${intento + 1}/5): ${r.error.message}`);
    await sleep(1000 * 2 ** intento);
  }
  if (!data?.length) break;

  const filas: { id: number; cuerpo: string }[] = [];
  for (const a of data as { id: number; id_wp: number; resumen_linea: string | null; temas: string[] }[]) {
    const cuerpo = cuerpos.get(a.id_wp);
    if (!cuerpo) { sinCuerpo++; continue; }
    filas.push({
      id: a.id,
      cuerpo: `${cuerpo} ${a.resumen_linea ?? ''} ${(a.temas ?? []).join(' ')}`,
    });
  }

  if (!SECO) {
    for (let i = 0; i < filas.length; i += LOTE) {
      const ok = await indexarLote(filas.slice(i, i + LOTE));
      if (!ok) lotesFallidos++;
    }
  }
  indexados += filas.length;
  if (data.length < 1000) break;
  process.stdout.write(`\r  indexados ${indexados}...`);
}

console.log(`\n\nIndexados con su texto completo: ${indexados}`);
if (lotesFallidos > 0) {
  console.log(`Lotes que no se pudieron indexar: ${lotesFallidos} (vuelve a correr el script: es idempotente)`);
}
console.log(`Sin cuerpo en los XML (siguen solo con título): ${sinCuerpo}`);
