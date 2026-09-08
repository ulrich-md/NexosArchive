// Recupera autores que la API de WordPress no expone pero la página pública sí.
//
// Hallazgo (2026-09-07): /wp/v2/posts deja `coauthors` vacío en más de la mitad
// del archivo, y en otra parte lo llena con firmas que no son personas
// (`nexos`, `Nexos`, `4dm1n`, este último un usuario del CMS). Pero la página
// del artículo sí trae la firma real en:
//
//   <div class="entry-meta2">
//     <div class="el-autor">Ulises Beltrán  (  )</div>
//
// Ejemplo verificado: nexos.com.mx/fox-y-otras-percepciones/ está sin autor en
// la API y firmado por Ulises Beltrán en la página.
//
// El dato se RECUPERA de la página, no se deduce: los que salen vacíos o "N/A"
// se quedan sin autor (sección 7). Los recuperados se marcan
// `autor_confianza='extraido'` para distinguirlos de los que vinieron de WP.
//
// Uso:
//   npm run recuperar-autores -- --limite=30   # muestra, para medir la tasa
//   npm run recuperar-autores                  # todo lo pendiente
import './lib/red.js';
import 'dotenv/config';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { clienteSupabase } from './lib/supabase.js';
import { sleep } from './lib/wp.js';
import { FIRMAS_NO_PERSONA, autorDesdePagina } from './lib/firma.js';

/**
 * Cuentas del propio blog que el tema de algunos subdominios cuelga junto al
 * autor real ("Cultura Nexos", "Juego de La Nueva Suprema Corte"). Las deduce
 * `npm run firmas-sitio`; si el archivo no está, la recuperación corre igual
 * pero esas cuentas entrarían al índice de autores como si fueran personas.
 */
const RUTA_FIRMAS = 'datos/firmas-institucionales.json';

function leerInstitucionales(): Map<string, Set<string>> {
  const mapa = new Map<string, Set<string>>();
  if (!existsSync(RUTA_FIRMAS)) {
    console.warn(`⚠ No existe ${RUTA_FIRMAS}: corre \`npm run firmas-sitio\` antes, o las cuentas de los blogs entrarán como autores.\n`);
    return mapa;
  }
  const bruto = JSON.parse(readFileSync(RUTA_FIRMAS, 'utf8')) as Record<string, { slug: string; nombre: string }[]>;
  for (const [sitio, cuentas] of Object.entries(bruto)) {
    mapa.set(sitio, new Set(cuentas.map((c) => c.slug)));
  }
  return mapa;
}

/**
 * Reintenta una escritura a Supabase. Una corrida dura ~1 h y un `fetch failed`
 * transitorio no puede tirarla entera: la primera vez murió a los 400 artículos
 * por eso, perdiendo el resto del trabajo pendiente de esa pasada.
 */
async function conReintento(qué: string, fn: () => PromiseLike<{ error: unknown }>): Promise<void> {
  for (let intento = 0; ; intento++) {
    let err: unknown = null;
    try {
      ({ error: err } = await fn());
    } catch (e) {
      err = e;
    }
    if (!err) return;
    if (intento >= 4) throw new Error(`${qué}: ${(err as Error).message ?? String(err)}`);
    const espera = Math.min(15_000, 500 * 2 ** intento) + Math.random() * 250;
    console.warn(`  [reintento] ${qué} (${intento + 1}/4), esperando ${Math.round(espera)}ms...`);
    await sleep(espera);
  }
}

/** El subdominio de la URL del artículo: es la clave del sitio. */
function sitioDeUrl(url: string): string {
  try {
    const host = new URL(url).hostname;
    return host.replace(/\.nexos\.com\.mx$/, '');
  } catch {
    return 'www';
  }
}

const DELAY_MS = 300;
const PAGINA_DB = 500;
const LOG = 'logs/autores-recuperados.jsonl';
const LOG_SIN_FIRMA = 'logs/autores-sin-firma.txt';

const concArg = process.argv.find((a) => a.startsWith('--concurrencia='));
/** Autorizado por el dueño del proyecto para bajar la corrida de ~6 h a ~1 h. */
const CONCURRENCIA = concArg ? Number(concArg.split('=')[1]) : 6;

const limiteArg = process.argv.find((a) => a.startsWith('--limite='));
const LIMITE = limiteArg ? Number(limiteArg.split('=')[1]) : 0;
const SECO = process.argv.includes('--seco');

interface Fila {
  id: number;
  url: string;
  autores: string[];
  autor_confianza: string;
}

/** Los nombres de persona que ya traía WordPress, sin las firmas del CMS. */
function realesDeWp(autores: string[]): string[] {
  return (autores ?? []).filter((a) => !FIRMAS_NO_PERSONA.has(a.trim()));
}

async function main() {
  mkdirSync('logs', { recursive: true });
  const supabase = clienteSupabase();
  const institucionales = leerInstitucionales();

  console.log('Archivo Nexos — recuperación de autores desde la página pública\n');

  // Candidatos: los que no tienen autor, y los firmados por algo que no es
  // una persona. Los que ya traen un autor real de WP no se tocan.
  const candidatos: Fila[] = [];
  for (let desde = 0; ; desde += PAGINA_DB) {
    const { data, error } = await supabase
      .from('articulos')
      .select('id,url,autores,autor_confianza')
      .or('autor_confianza.eq.ausente,autores.cs.{"4dm1n"},autores.cs.{"nexos"},autores.cs.{"Nexos"}')
      .order('id', { ascending: true })
      .range(desde, desde + PAGINA_DB - 1);
    if (error) throw new Error(`Error listando candidatos: ${error.message}`);
    if (!data?.length) break;
    candidatos.push(...(data as Fila[]));
    if (data.length < PAGINA_DB) break;
    if (LIMITE && candidatos.length >= LIMITE) break;
  }

  // Paso 1, sin red: donde WordPress ya trae un nombre de persona junto a una
  // firma del CMS, basta quitar la firma. No hace falta pedir la página.
  let limpiados = 0;
  const yaRevisados = new Set<number>(
    existsSync(LOG_SIN_FIRMA)
      ? readFileSync(LOG_SIN_FIRMA, 'utf8').split('\n').map(Number).filter(Boolean)
      : [],
  );
  const pendientes: Fila[] = [];
  for (const fila of candidatos) {
    const reales = realesDeWp(fila.autores);
    if (reales.length > 0) {
      if (reales.length !== (fila.autores ?? []).length) {
        limpiados++;
        if (!SECO) {
          await conReintento(`limpiando firmas de ${fila.id}`, () =>
            supabase.from('articulos').update({ autores: reales }).eq('id', fila.id),
          );
        }
      }
      // Tiene autor real de WP: no se toca. La página no manda sobre WordPress
      // porque las dos fuentes se contradicen (ej. "Yarsa" vs "Yasna") y no hay
      // forma de saber cuál es la buena sin que alguien lo revise.
      continue;
    }
    if (yaRevisados.has(fila.id)) continue; // ya se pidió su página y no traía firma
    pendientes.push(fila);
  }

  console.log(`Candidatos: ${candidatos.length}`);
  console.log(`  con nombre real en WP (solo se les quita la firma del CMS): ${limpiados}`);
  console.log(`  sin ningún nombre real, hay que ir a la página: ${pendientes.length}`);

  const lote = LIMITE ? pendientes.slice(0, LIMITE) : pendientes;
  if (yaRevisados.size) console.log(`  ya revisados sin firma en corridas previas (se saltan): ${yaRevisados.size}`);
  console.log(`Se procesan ${lote.length} con ${CONCURRENCIA} en paralelo · estimado ${Math.round((lote.length * 1.6) / 60 / CONCURRENCIA)} min\n`);
  if (SECO) return;

  let recuperados = 0;
  let sinFirma = 0;
  let fallos = 0;
  let procesados = 0;
  let siguiente = 0;

  // El dueño del proyecto autorizó explícitamente relajar la regla de "nunca en
  // paralelo" para bajar la corrida de ~6 h a ~1 h. A cambio, freno automático:
  // si el servidor de Nexos empieza a devolver 429 o 5xx, los trabajadores se
  // detienen solos. La velocidad no puede volverse un problema para producción.
  let frenoHasta = 0;
  let seguidos429 = 0;

  async function traerPagina(url: string): Promise<string | null> {
    for (let intento = 0; intento < 4; intento++) {
      const espera = frenoHasta - Date.now();
      if (espera > 0) await sleep(espera);

      const res = await fetch(url).catch(() => null);
      if (!res) { await sleep(1000 * 2 ** intento); continue; }

      if (res.ok) { seguidos429 = 0; return res.text(); }
      if (res.status === 404) return null;

      if (res.status === 429 || res.status >= 500) {
        seguidos429++;
        // El freno es global: lo respetan todos los trabajadores, no solo este.
        const pausa = Math.min(60_000, 2000 * 2 ** Math.min(seguidos429, 5));
        frenoHasta = Date.now() + pausa;
        console.warn(`  [freno] HTTP ${res.status}; pausando ${Math.round(pausa / 1000)}s a todos los trabajadores`);
        continue;
      }
      return null;
    }
    return null;
  }

  async function trabajador() {
    for (;;) {
      const i = siguiente++;
      if (i >= lote.length) return;
      const fila = lote[i];

      const html = await traerPagina(fila.url);
      if (!html) {
        fallos++;
      } else {
        const autores = autorDesdePagina(html, institucionales.get(sitioDeUrl(fila.url)));
        if (autores.length > 0) {
          recuperados++;
          appendFileSync(LOG, JSON.stringify({ id: fila.id, antes: fila.autores, ahora: autores, url: fila.url }) + '\n');
          await conReintento(`guardando el autor de ${fila.id}`, () =>
            supabase
              .from('articulos')
              .update({ autores, autor_confianza: 'extraido' })
              .eq('id', fila.id),
          );
        } else {
          // La página existe y no trae firma: no hay autor que recuperar. Se
          // anota para que una corrida futura no vuelva a pedir esta página.
          sinFirma++;
          appendFileSync(LOG_SIN_FIRMA, `${fila.id}\n`);
        }
      }

      procesados++;
      if (procesados % 200 === 0 || procesados === lote.length) {
        const pct = Math.round((recuperados / procesados) * 100);
        console.log(`  ${procesados}/${lote.length} · recuperados ${recuperados} (${pct}%) · sin firma ${sinFirma} · fallos ${fallos}`);
      }
      await sleep(DELAY_MS);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCIA }, () => trabajador()));

  console.log('\n=== RECUPERACIÓN ===');
  console.log(`Procesados:            ${lote.length}`);
  console.log(`Con autor recuperado:  ${recuperados} (${Math.round((recuperados / lote.length) * 100)}%)`);
  console.log(`Sin firma en la página:${sinFirma}  (se quedan como 'autor no consignado')`);
  console.log(`Páginas no accesibles: ${fallos}`);
  console.log(`Detalle: ${LOG}`);

  if (recuperados > 0 && !LIMITE) {
    const { error } = await supabase.rpc('refrescar_autores_conteo');
    if (error) console.error(`No se pudo refrescar autores_conteo: ${error.message}`);
    else console.log('Vista autores_conteo refrescada.');
  }
}

main().catch((err) => {
  console.error('\nFalló la recuperación de autores:', err);
  process.exit(1);
});
