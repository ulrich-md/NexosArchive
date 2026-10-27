// npm run embeber — un vector por artículo para la búsqueda por significado
// (migración 0006, carril `hibrida` y pase 0 de `panorama`).
//
// Por qué: "¿Qué ha escrito Ángeles Mastretta sobre comida?" no encontraba
// sus textos sobre cocina o el mole, porque la búsqueda de texto exige la
// palabra literal. El vector sale del título, autores, sección, temas y
// `resumen_linea` que ya dejó el enriquecimiento.
//
// Reanudable sin bitácora: un artículo sin fila en `articulos_vectores` es
// exactamente lo pendiente (a diferencia de `resumen_linea`, ver CLAUDE.md
// §2). Si el texto de un artículo cambia —un re-enriquecimiento, un título
// corregido—, un trigger borra su vector y la siguiente corrida lo rehace.
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
// Textos por petición. Sin método de pago, Voyage limita mucho los tokens por
// minuto: `--lote=50` evita que cada petición rebase el límite.
const lote = Math.min(argNumero('lote') ?? MAX_POR_PETICION, MAX_POR_PETICION);
const seco = process.argv.includes('--seco');
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

const bd = clienteSupabase();

// Los vectores viven en su propia tabla (migración 0007): "pendiente" es
// "sin fila en articulos_vectores", y lo cuentan y listan dos RPC.
const { data: pendientesCrudo, error: errConteo } = await bd.rpc('contar_sin_vector');
const pendientes = Number(pendientesCrudo ?? 0);
if (errConteo) {
  console.error(
    /contar_sin_vector|could not find|does not exist/i.test(errConteo.message)
      ? 'Falta aplicar supabase/migrations/0007_vectores_en_tabla_aparte.sql.'
      : `No se pudo contar lo pendiente: ${errConteo.message || errConteo.code || '(sin detalle)'}`,
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
  const tope = limite === null ? lote : Math.min(lote, limite - hechos);
  if (tope <= 0) break;

  // Por id ascendente y con cursor: un artículo que fallara siempre no puede
  // atorar la corrida en un bucle.
  const { data, error } = await bd.rpc('articulos_sin_vector', { p_despues: ultimoId, p_limite: tope });
  if (error) {
    console.error(`Error leyendo artículos: ${error.message}`);
    process.exit(1);
  }
  const articulos = (data ?? []) as ArticuloParaVector[];
  if (articulos.length === 0) break;

  let vectores: number[][] | null = null;
  for (let intento = 1; vectores === null; intento++) {
    try {
      peticiones++;
      vectores = await embeberLote(articulos.map((a) => ({ texto: textoParaVector(a), titulo: a.titulo })));
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

  const filas = articulos.map((a, i) => ({ id: a.id, v: `[${vectores![i].join(',')}]` }));
  const { error: errGuardar } = await bd.rpc('guardar_embeddings', { p_filas: filas });
  if (errGuardar) {
    console.error(
      /dimensions|halfvec/i.test(errGuardar.message)
        ? `\nLos vectores de ${MODELO_EMBEDDINGS} (${DIM_EMBEDDINGS}) no caben en la tabla: ` +
          'con VOYAGE_API_KEY hay que aplicar antes supabase/migrations/0012_vectores_voyage.sql.'
        : `\nError guardando vectores: ${errGuardar.message}`,
    );
    process.exit(1);
  }

  hechos += articulos.length;
  ultimoId = articulos[articulos.length - 1].id;
  const seg = (Date.now() - t0) / 1000;
  process.stdout.write(
    `\r${hechos.toLocaleString('es-MX')} / ${(limite ?? pendientes ?? 0).toLocaleString('es-MX')} ` +
      `· ${peticiones} peticiones · ${Math.round(hechos / Math.max(seg, 1))} art/s   `,
  );
  await dormir(PAUSA_MS);
}

const { data: restantesCrudo } = await bd.rpc('contar_sin_vector');
const restantes = Number(restantesCrudo ?? 0);
console.log(
  `\nListo: ${hechos.toLocaleString('es-MX')} vectores nuevos. ` +
    `Quedan ${(restantes ?? 0).toLocaleString('es-MX')} sin vector.`,
);
