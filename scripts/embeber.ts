// npm run embeber — un vector por artículo para la búsqueda por significado
// (migración 0006, carril `hibrida` y pase 0 de `panorama`).
//
// Por qué: "¿Qué ha escrito Ángeles Mastretta sobre comida?" no encontraba
// sus textos sobre cocina o el mole, porque la búsqueda de texto exige la
// palabra literal. El vector sale del título, autores, sección, temas y
// `resumen_linea` que ya dejó el enriquecimiento.
//
// Reanudable sin bitácora: `embedding IS NULL` es exactamente lo pendiente
// (a diferencia de `resumen_linea`, ver CLAUDE.md §2). Si el texto de un
// artículo cambia —un re-enriquecimiento, un título corregido—, un trigger
// vacía su vector y la siguiente corrida lo rehace.
//
// Uso:
//   npm run embeber                 # todo lo pendiente
//   npm run embeber -- --limite=200 # prueba sobre 200 artículos
//   npm run embeber -- --seco       # solo cuenta lo pendiente
//
// Cuota: el plan gratuito de Gemini tiene su propio cupo para embeddings,
// aparte del de generación. Si se agota el del día, el script se detiene sin
// perder nada y la siguiente corrida sigue donde quedó. Con facturación
// activa, todo el archivo (~33k artículos, unos pocos millones de tokens)
// cuesta menos de un dólar.
import './lib/red.js';
import 'dotenv/config';
import { clienteSupabase } from './lib/supabase.js';
import {
  type ArticuloParaVector, type ErrorEmbeddings,
  DIM_EMBEDDINGS, MAX_POR_PETICION, MODELO_EMBEDDINGS, embeberLote, textoParaVector,
} from './lib/embeddings.js';

const PAUSA_MS = 300;
const ESPERA_MINUTO_MS = 61_000;
const MAX_REINTENTOS = 6;

function argNumero(nombre: string): number | null {
  const crudo = process.argv.find((a) => a.startsWith(`--${nombre}=`))?.split('=')[1];
  if (crudo === undefined) return null;
  const n = Number(crudo);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`--${nombre} debe ser un número positivo, se recibió "${crudo}".`);
    process.exit(1);
  }
  return Math.floor(n);
}

const limite = argNumero('limite');
const seco = process.argv.includes('--seco');
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

const bd = clienteSupabase();

const { count: pendientes, error: errConteo } = await bd
  .from('articulos')
  .select('id', { count: 'exact', head: true })
  .is('embedding', null);
if (errConteo) {
  // Un conteo con `head: true` no trae cuerpo: si la columna no existe, el
  // error llega con `message` VACÍO (pasó en la primera corrida del workflow).
  // Se repite la consulta sin `head` para obtener el motivo real.
  const { error: detalle } = await bd.from('articulos').select('id').is('embedding', null).limit(1);
  const motivo = detalle?.message || errConteo.message || '(sin detalle)';
  console.error(
    /embedding/.test(motivo)
      ? 'La columna `embedding` no existe: falta aplicar supabase/migrations/0006_busqueda_por_significado.sql.'
      : `No se pudo contar lo pendiente: ${motivo}`,
  );
  process.exit(1);
}

console.log(`Modelo: ${MODELO_EMBEDDINGS} · ${DIM_EMBEDDINGS} dimensiones`);
console.log(`Pendientes: ${(pendientes ?? 0).toLocaleString('es-MX')} artículos sin vector.`);
if (seco || (pendientes ?? 0) === 0) process.exit(0);

let ultimoId = 0;
let hechos = 0;
let peticiones = 0;
const t0 = Date.now();

for (;;) {
  const tope = limite === null ? MAX_POR_PETICION : Math.min(MAX_POR_PETICION, limite - hechos);
  if (tope <= 0) break;

  // Por id ascendente y con cursor: un artículo que fallara siempre no puede
  // atorar la corrida en un bucle.
  const { data, error } = await bd
    .from('articulos')
    .select('id,titulo,autores,seccion,temas,resumen_linea')
    .is('embedding', null)
    .gt('id', ultimoId)
    .order('id', { ascending: true })
    .limit(tope);
  if (error) {
    console.error(`Error leyendo artículos: ${error.message}`);
    process.exit(1);
  }
  const lote = (data ?? []) as ArticuloParaVector[];
  if (lote.length === 0) break;

  let vectores: number[][] | null = null;
  for (let intento = 1; vectores === null; intento++) {
    try {
      peticiones++;
      vectores = await embeberLote(lote.map((a) => ({ texto: textoParaVector(a), titulo: a.titulo })));
    } catch (e) {
      const err = e as ErrorEmbeddings;
      if (err.fatal) {
        console.error(`\nError que no se arregla reintentando: ${err.message}`);
        process.exit(1);
      }
      if (err.cuotaDiaria) {
        console.log(
          `\nSe agotó la cuota DIARIA de ${MODELO_EMBEDDINGS} tras ${hechos.toLocaleString('es-MX')} artículos. ` +
            'Nada se pierde: vuelve a correr `npm run embeber` mañana, o activa facturación en Google Cloud.',
        );
        process.exit(0);
      }
      if (intento >= MAX_REINTENTOS) {
        console.error(`\nSe rindió tras ${MAX_REINTENTOS} intentos: ${err.message}`);
        process.exit(1);
      }
      const espera = err.status === 429 ? ESPERA_MINUTO_MS : 2 ** intento * 1000;
      console.log(`\n${err.status ?? 'red'} — reintento ${intento} en ${Math.round(espera / 1000)} s`);
      await dormir(espera);
    }
  }

  const filas = lote.map((a, i) => ({ id: a.id, v: `[${vectores![i].join(',')}]` }));
  const { error: errGuardar } = await bd.rpc('guardar_embeddings', { p_filas: filas });
  if (errGuardar) {
    console.error(`\nError guardando vectores: ${errGuardar.message}`);
    process.exit(1);
  }

  hechos += lote.length;
  ultimoId = lote[lote.length - 1].id;
  const seg = (Date.now() - t0) / 1000;
  process.stdout.write(
    `\r${hechos.toLocaleString('es-MX')} / ${(limite ?? pendientes ?? 0).toLocaleString('es-MX')} ` +
      `· ${peticiones} peticiones · ${Math.round(hechos / Math.max(seg, 1))} art/s   `,
  );
  await dormir(PAUSA_MS);
}

const { count: restantes } = await bd
  .from('articulos')
  .select('id', { count: 'exact', head: true })
  .is('embedding', null);
console.log(
  `\nListo: ${hechos.toLocaleString('es-MX')} vectores nuevos. ` +
    `Quedan ${(restantes ?? 0).toLocaleString('es-MX')} sin vector.`,
);
