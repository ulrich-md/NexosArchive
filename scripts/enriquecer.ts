// Enriquecimiento del archivo con Claude Haiku — paso 3 del orden de trabajo
// (CLAUDE.md §9). Llena los cuatro campos que la ingesta deja vacíos:
// `resumen_linea`, `temas`, `anios_referidos` y `tipo_texto`.
//
// Sin `resumen_linea` el modo panorama (§4) es imposible: es el 5% del
// presupuesto que habilita el 50% del valor.
//
// Tres cosas mandan sobre el diseño de este script:
//
// 1. Cuesta dinero real. Es reanudable de verdad: la bitácora `datos/enriquecidos.jsonl`
//    se escribe después de CADA lote, así que una corrida interrumpida no vuelve a
//    pagar lo ya hecho. El costo (tokens y usd) se reporta mientras corre.
// 2. En esta fase el modelo solo ve título, autor, fecha y número — el cuerpo es
//    fase 2. Con tan poco contexto es fácil que invente, así que los prompts le
//    dan permiso explícito de dejar el campo vacío y toda respuesta se valida
//    antes de tocar la base (§7). Lo que no valida se descarta y se registra.
// 3. Un fallo no puede matar la corrida: reintento con backoff, y un lote que
//    falla se anota y se sigue.
//
// Uso:
//   npm run enriquecer                    # todo lo pendiente
//   npm run enriquecer -- --limite=200    # prueba barata sobre 200 artículos
//   npm run enriquecer -- --seco          # sin llamar a la API: estima costo
import './lib/red.js';
import 'dotenv/config';
import { appendFileSync, mkdirSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { clienteSupabase } from './lib/supabase.js';
import { RUTA_AVANCE, anotarAvance, leerAvance, type EstadoEnriquecimiento } from './lib/avance-enriquecimiento.js';
import {
  type ArticuloParaEnriquecer, type Descarte, type Enriquecimiento, type Uso,
  HERRAMIENTA, MODELO_POR_DEFECTO, SYSTEM_PROMPT,
  armarMensaje, costoUsd, enriquecimientoVacio, estaVacio, estimarTokens,
  hayTarifa, sinMaterial, sumarUso, usoVacio, validarRespuesta,
} from './lib/enriquecimiento.js';

const PAGINA_DB = 500;          // filas que se traen de Supabase por vuelta
const REINTENTOS_API = 6;
const REINTENTOS_DB = 3;

mkdirSync('logs', { recursive: true });
const LOG_DESCARTES = 'logs/enriquecimiento-descartes.jsonl';
const LOG_LOTES_FALLIDOS = 'logs/enriquecimiento-lotes-fallidos.jsonl';

// --- Argumentos -------------------------------------------------------------

function argNumero(nombre: string, porDefecto: number): number {
  const crudo = process.argv.find((a) => a.startsWith(`--${nombre}=`))?.split('=')[1];
  if (crudo === undefined) return porDefecto;
  const n = Number(crudo);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`--${nombre} debe ser un número positivo, se recibió "${crudo}".`);
    process.exit(1);
  }
  return Math.floor(n);
}

const TAM_LOTE = argNumero('lote', 20);
const CONCURRENCIA = argNumero('concurrencia', 3);
const LIMITE = argNumero('limite', 0);
const SECO = process.argv.includes('--seco');
const MODELO = process.argv.find((a) => a.startsWith('--modelo='))?.split('=')[1]
  ?? process.env.ANTHROPIC_MODELO_ENRIQUECIMIENTO
  ?? MODELO_POR_DEFECTO;

// --- Estado global de la corrida --------------------------------------------

const uso: Uso = usoVacio();
let totalEscritos = 0;
let totalVacios = 0;
let totalSinMaterial = 0;
let totalDescartes = 0;
let totalLotesFallidos = 0;
let totalArticulosPerdidos = 0;
let llamadas = 0;
const inicio = Date.now();

interface ErrorFatal extends Error { fatal?: true }

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function usd(n: number): string {
  return `$${n.toFixed(4)}`;
}

// --- Llamada al modelo ------------------------------------------------------

const cliente = SECO ? null : new Anthropic({ maxRetries: 0 }); // el reintento es nuestro

interface RespuestaLote {
  bruto: unknown;
  uso: Uso;
  truncada: boolean;
}

function usoDesde(u: Anthropic.Usage): Uso {
  return {
    entrada: u.input_tokens ?? 0,
    salida: u.output_tokens ?? 0,
    escritura_cache: u.cache_creation_input_tokens ?? 0,
    lectura_cache: u.cache_read_input_tokens ?? 0,
  };
}

function esperaDeRateLimit(err: unknown): number | null {
  const cabeceras = (err as { headers?: Headers }).headers;
  const valor = cabeceras?.get?.('retry-after');
  const segundos = valor ? Number(valor) : NaN;
  return Number.isFinite(segundos) ? Math.min(60_000, segundos * 1000) : null;
}

/**
 * Una llamada por lote, con reintento y backoff exponencial en 429/5xx/red.
 * 401 y 403 abortan la corrida (reintentar una credencial mala solo quema tiempo);
 * cualquier otro error se propaga para que el lote se registre y la corrida siga.
 */
async function llamarModelo(lote: ArticuloParaEnriquecer[]): Promise<RespuestaLote> {
  if (!cliente) throw new Error('llamarModelo en modo --seco');

  const maxTokens = Math.min(16_000, 350 * lote.length + 1_000);
  let intento = 0;

  for (;;) {
    try {
      const respuesta = await cliente.messages.create({
        model: MODELO,
        max_tokens: maxTokens,
        temperature: 0,
        // El system prompt y la herramienta son idénticos en toda la corrida:
        // con cache el prefijo se cobra a 0.1x a partir de la segunda llamada.
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        tools: [HERRAMIENTA as Anthropic.Tool],
        tool_choice: { type: 'tool', name: HERRAMIENTA.name },
        messages: [{ role: 'user', content: armarMensaje(lote) }],
      });

      llamadas++;
      const bloque = respuesta.content.find((b) => b.type === 'tool_use');
      return {
        bruto: bloque ? bloque.input : null,
        uso: usoDesde(respuesta.usage),
        truncada: respuesta.stop_reason === 'max_tokens',
      };
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
        const fatal: ErrorFatal = new Error(`La API rechazó la credencial (HTTP ${err.status}). Revisa ANTHROPIC_API_KEY.`);
        fatal.fatal = true;
        throw fatal;
      }

      const status = err instanceof Anthropic.APIError ? err.status : undefined;
      const reintentable =
        err instanceof Anthropic.APIConnectionError ||
        err instanceof Anthropic.RateLimitError ||
        (typeof status === 'number' && status >= 500);

      if (!reintentable || intento >= REINTENTOS_API) throw err;

      const espera = esperaDeRateLimit(err) ?? Math.min(60_000, 1_000 * 2 ** intento) + Math.random() * 500;
      console.warn(`  [reintento] ${status ?? 'red'} (intento ${intento + 1}/${REINTENTOS_API}), esperando ${Math.round(espera)}ms...`);
      await sleep(espera);
      intento++;
    }
  }
}

// --- Proceso de un lote -----------------------------------------------------

interface ResultadoLote {
  enriquecimientos: { valor: Enriquecimiento; estado: EstadoEnriquecimiento }[];
  descartes: Descarte[];
  perdidos: number;   // artículos del lote que nadie catalogó (fallo del lote)
  fallo?: string;
}

function anotarDescartes(descartes: Descarte[]): void {
  if (descartes.length === 0) return;
  totalDescartes += descartes.length;
  const ts = new Date().toISOString();
  appendFileSync(LOG_DESCARTES, descartes.map((d) => JSON.stringify({ ...d, ts })).join('\n') + '\n');
}

/**
 * Cataloga un lote. Si la respuesta se truncó por `max_tokens`, lo parte en dos
 * y reintenta: es preferible pagar dos llamadas chicas a perder el lote entero.
 */
async function procesarLote(lote: ArticuloParaEnriquecer[], profundidad = 0): Promise<ResultadoLote> {
  const enriquecimientos: ResultadoLote['enriquecimientos'] = [];

  // Sin título utilizable el modelo no tiene de dónde agarrarse: se resuelve
  // aquí, vacío y gratis, en vez de gastar una llamada en adivinar.
  const conMaterial: ArticuloParaEnriquecer[] = [];
  for (const articulo of lote) {
    if (sinMaterial(articulo)) {
      enriquecimientos.push({ valor: enriquecimientoVacio(articulo.id), estado: 'sin_material' });
    } else {
      conMaterial.push(articulo);
    }
  }
  if (conMaterial.length === 0) return { enriquecimientos, descartes: [], perdidos: 0 };

  let respuesta: RespuestaLote;
  try {
    respuesta = await llamarModelo(conMaterial);
  } catch (err) {
    if ((err as ErrorFatal).fatal) throw err;
    return {
      enriquecimientos,
      descartes: [],
      perdidos: conMaterial.length,
      fallo: err instanceof Error ? err.message : String(err),
    };
  }

  sumarUso(uso, respuesta.uso);

  if (respuesta.truncada && conMaterial.length > 1 && profundidad < 2) {
    const mitad = Math.ceil(conMaterial.length / 2);
    console.warn(`  [truncado] respuesta cortada por max_tokens; partiendo el lote de ${conMaterial.length} en dos.`);
    const a = await procesarLote(conMaterial.slice(0, mitad), profundidad + 1);
    const b = await procesarLote(conMaterial.slice(mitad), profundidad + 1);
    return {
      enriquecimientos: [...enriquecimientos, ...a.enriquecimientos, ...b.enriquecimientos],
      descartes: [...a.descartes, ...b.descartes],
      perdidos: a.perdidos + b.perdidos,
      fallo: a.fallo ?? b.fallo,
    };
  }

  // Nada se escribe sin validar contra el esquema y contra el lote enviado (§7.5).
  const { validos, descartes, faltantes } = validarRespuesta(respuesta.bruto, conMaterial);
  for (const valor of validos) {
    enriquecimientos.push({ valor, estado: estaVacio(valor) ? 'vacio' : 'ok' });
  }

  return { enriquecimientos, descartes, perdidos: faltantes.length };
}

// --- Escritura --------------------------------------------------------------

type Supabase = ReturnType<typeof clienteSupabase>;

async function guardar(supabase: Supabase, e: Enriquecimiento): Promise<boolean> {
  for (let intento = 0; ; intento++) {
    const { error } = await supabase
      .from('articulos')
      .update({
        resumen_linea: e.resumen_linea,
        temas: e.temas,
        anios_referidos: e.anios_referidos,
        tipo_texto: e.tipo_texto,
      })
      .eq('id', e.id);

    if (!error) return true;
    if (intento >= REINTENTOS_DB) {
      console.warn(`  [db] no se pudo guardar el artículo ${e.id}: ${error.message}`);
      return false;
    }
    await sleep(500 * 2 ** intento);
  }
}

// --- Lectura de pendientes --------------------------------------------------

interface FilaArticulo {
  id: number;
  titulo: string;
  autores: string[] | null;
  fecha_pub: string;
  numero: string | null;
  seccion: string | null;
}

/**
 * Pendientes por paginación de llave (`id > cursor`), no por offset: la corrida
 * va modificando justo las filas que filtra, y un offset se desalinearía.
 */
async function traerPendientes(supabase: Supabase, cursor: number): Promise<ArticuloParaEnriquecer[]> {
  const { data, error } = await supabase
    .from('articulos')
    .select('id,titulo,autores,fecha_pub,numero,seccion')
    .is('resumen_linea', null)
    .gt('id', cursor)
    .order('id', { ascending: true })
    .limit(PAGINA_DB);

  if (error) throw new Error(`Error leyendo articulos pendientes: ${error.message}`);

  return (data ?? []).map((f: FilaArticulo) => ({
    id: f.id,
    titulo: f.titulo ?? '',
    autores: f.autores ?? [],
    fecha_pub: f.fecha_pub,
    numero: f.numero,
    seccion: f.seccion,
  }));
}

function partirEnLotes<T>(items: T[], tam: number): T[][] {
  const lotes: T[][] = [];
  for (let i = 0; i < items.length; i += tam) lotes.push(items.slice(i, i + tam));
  return lotes;
}

// --- Progreso ---------------------------------------------------------------

function reportarProgreso(pendientesInicio: number): void {
  const hechos = totalEscritos + totalSinMaterial;
  const gastado = costoUsd(uso, MODELO);
  const proyeccion = hechos > 0 ? (gastado / hechos) * pendientesInicio : 0;
  const minutos = (Date.now() - inicio) / 60_000;
  const ritmo = minutos > 0 ? Math.round(hechos / minutos) : 0;

  console.log(
    `${hechos}/${pendientesInicio} · ${llamadas} llamadas · ` +
    `in ${uso.entrada + uso.escritura_cache + uso.lectura_cache} / out ${uso.salida} tok · ` +
    `${usd(gastado)} gastado · proyección ${usd(proyeccion)} · ` +
    `${ritmo}/min · vacíos ${totalVacios} · descartes ${totalDescartes}`,
  );
}

// --- Corrida en seco --------------------------------------------------------

function corridaEnSeco(lotes: ArticuloParaEnriquecer[][], pendientes: number): void {
  const sistema = estimarTokens(SYSTEM_PROMPT) + estimarTokens(JSON.stringify(HERRAMIENTA));
  let entrada = 0;
  for (const lote of lotes) entrada += estimarTokens(armarMensaje(lote));

  // A partir de la segunda llamada el prefijo se sirve de cache (0.1x).
  const estimado: Uso = {
    entrada,
    escritura_cache: sistema,
    lectura_cache: sistema * Math.max(0, lotes.length - 1),
    salida: pendientes * 90, // ~90 tokens por ficha catalogada
  };

  console.log('\n=== PRUEBA EN SECO (no se llamó a la API, no se escribió nada) ===');
  console.log(`Modelo:                  ${MODELO}`);
  console.log(`Artículos pendientes:    ${pendientes}`);
  console.log(`Lotes de ${TAM_LOTE}:${' '.repeat(Math.max(1, 14 - String(TAM_LOTE).length))}${lotes.length}`);
  console.log(`Tokens de entrada (est): ${estimado.entrada + estimado.escritura_cache + estimado.lectura_cache}`);
  console.log(`Tokens de salida (est):  ${estimado.salida}`);
  console.log(`Costo estimado:          ${usd(costoUsd(estimado, MODELO))}`);
  if (lotes[0]) {
    console.log('\n--- Primer mensaje que se mandaría ---');
    console.log(armarMensaje(lotes[0]).slice(0, 1_200));
  }
  console.log('\nLa estimación usa ~3.5 caracteres por token: sirve para decidir, no para facturar.');
}

// --- Main -------------------------------------------------------------------

async function main() {
  console.log('Archivo Nexos — enriquecimiento con Claude (fase 3)\n');
  console.log(`Modelo: ${MODELO} · lote ${TAM_LOTE} · concurrencia ${CONCURRENCIA}${SECO ? ' · MODO SECO' : ''}`);
  if (!hayTarifa(MODELO)) {
    console.warn(`Aviso: no hay tarifa publicada en el script para "${MODELO}"; el costo se estima con la de ${MODELO_POR_DEFECTO}.`);
  }
  if (!SECO && !process.env.ANTHROPIC_API_KEY) {
    console.error('Falta ANTHROPIC_API_KEY en el entorno. Copia .env.example a .env y complétalo.');
    console.error('Para estimar el costo sin llamar a la API: npm run enriquecer -- --seco');
    process.exit(1);
  }

  const supabase = clienteSupabase();

  const { count: totalArticulos, error: errorCount } = await supabase
    .from('articulos')
    .select('*', { count: 'exact', head: true });
  if (errorCount) throw new Error(`Error contando articulos: ${errorCount.message}`);

  if (!totalArticulos) {
    console.error('\nLa tabla `articulos` está vacía. Corre primero `npm run ingesta` y `npm run verificar`.');
    console.error('CLAUDE.md §9: no se pasa al paso 3 hasta que los conteos por año cuadren.');
    process.exit(1);
  }

  const yaHechos = leerAvance();
  console.log(`Artículos en la base:    ${totalArticulos}`);
  console.log(`Ya enriquecidos (bitácora ${RUTA_AVANCE}): ${yaHechos.size}`);

  // 1. Se juntan los pendientes de esta corrida (respetando --limite).
  const pendientes: ArticuloParaEnriquecer[] = [];
  let cursor = -1;
  for (;;) {
    const pagina = await traerPendientes(supabase, cursor);
    if (pagina.length === 0) break;
    cursor = pagina[pagina.length - 1].id;
    for (const articulo of pagina) {
      if (yaHechos.has(articulo.id)) continue;
      pendientes.push(articulo);
      if (LIMITE && pendientes.length >= LIMITE) break;
    }
    if (LIMITE && pendientes.length >= LIMITE) break;
  }

  console.log(`Pendientes en esta corrida: ${pendientes.length}${LIMITE ? ` (--limite=${LIMITE})` : ''}\n`);
  if (pendientes.length === 0) {
    console.log('Nada que hacer: todo lo pendiente ya está enriquecido.');
    return;
  }

  const lotes = partirEnLotes(pendientes, TAM_LOTE);

  if (SECO) {
    corridaEnSeco(lotes, pendientes.length);
    return;
  }

  // 2. Los lotes se reparten entre N trabajadores. Cada uno cierra su lote
  //    —escribe en la base y anota la bitácora— antes de tomar el siguiente:
  //    así, si esto se corta, lo pagado ya quedó registrado.
  let siguiente = 0;

  async function trabajador(): Promise<void> {
    for (;;) {
      const indice = siguiente++;
      const lote = lotes[indice];
      if (!lote) return;

      const resultado = await procesarLote(lote);
      anotarDescartes(resultado.descartes);

      if (resultado.fallo) {
        totalLotesFallidos++;
        appendFileSync(LOG_LOTES_FALLIDOS, JSON.stringify({
          ts: new Date().toISOString(),
          ids: lote.map((a) => a.id),
          error: resultado.fallo,
        }) + '\n');
        console.warn(`  [lote ${indice + 1}] falló y se salta: ${resultado.fallo}`);
      }
      totalArticulosPerdidos += resultado.perdidos;

      const anotados: { id: number; estado: EstadoEnriquecimiento }[] = [];
      for (const { valor, estado } of resultado.enriquecimientos) {
        const ok = await guardar(supabase, valor);
        if (!ok) continue; // sin escribir en la base no se anota: se reintenta en la próxima corrida
        anotados.push({ id: valor.id, estado });
        if (estado === 'sin_material') totalSinMaterial++;
        else {
          totalEscritos++;
          if (estado === 'vacio') totalVacios++;
        }
      }

      // La bitácora se escribe al cerrar cada lote, nunca al final.
      anotarAvance(anotados);
      reportarProgreso(pendientes.length);
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCIA, lotes.length) }, () => trabajador()));

  // 3. Cierre con el costo real de la corrida.
  const gastado = costoUsd(uso, MODELO);
  const minutos = (Date.now() - inicio) / 60_000;

  console.log('\n=== ENRIQUECIMIENTO ===');
  console.log(`Artículos catalogados:        ${totalEscritos}`);
  console.log(`  de ellos vacíos (el título no sostenía nada): ${totalVacios}`);
  console.log(`Sin título utilizable:        ${totalSinMaterial}`);
  console.log(`Artículos no catalogados:     ${totalArticulosPerdidos}  (se reintentan en la próxima corrida)`);
  console.log(`Lotes fallidos:               ${totalLotesFallidos}  (ver ${LOG_LOTES_FALLIDOS})`);
  console.log(`Campos descartados por validación: ${totalDescartes}  (ver ${LOG_DESCARTES})`);
  console.log(`Llamadas al modelo:           ${llamadas}`);
  console.log(`Tokens entrada/salida:        ${uso.entrada + uso.escritura_cache + uso.lectura_cache} / ${uso.salida}`);
  console.log(`  cache escrito/leído:        ${uso.escritura_cache} / ${uso.lectura_cache}`);
  console.log(`Costo de esta corrida:        ${usd(gastado)}`);
  console.log(`Duración:                     ${minutos.toFixed(1)} min`);
  console.log(`Bitácora reanudable:          ${RUTA_AVANCE}`);

  if (totalArticulosPerdidos > 0 || totalLotesFallidos > 0) {
    console.log('\nQuedaron artículos sin catalogar. Vuelve a correr `npm run enriquecer`: retoma solo lo que falta.');
  }
}

main().catch((err) => {
  console.error('\nFalló el enriquecimiento:', err);
  console.error(`Lo ya procesado quedó anotado en ${RUTA_AVANCE}; la próxima corrida sigue desde ahí.`);
  process.exit(1);
});
