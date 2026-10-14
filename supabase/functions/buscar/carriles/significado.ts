// Búsqueda por significado + palabras, en UNA consulta indexada (migración
// 0006, `buscar_articulos_hibrido`). La usan `hibrida` y `panorama`.
//
// Por qué: la búsqueda de texto exige la palabra literal. "¿Qué ha escrito
// Ángeles Mastretta sobre comida?" no encontraba "La cocina de mi abuela" ni
// un texto sobre el mole, y `aproximar()` acababa enseñando sus artículos más
// recientes, sin relación con nada. El vector del artículo (título, temas y
// resumen del enriquecimiento) sí sabe que cocina y mole son comida.
//
// Nada de recorrer la base en bucles: los filtros duros (autor, años) van en
// el WHERE y el ranking lo hace Postgres; aquí solo hay un viaje por el vector
// de la pregunta, uno a la RPC y uno por las fichas.

import { HIBRIDA_DISTANCIA_MAX } from '../config.ts';
import { bd } from '../bd.ts';
import { embeberConsulta } from '../embeddings.ts';
import { ErrorBuscar, errorBd } from '../errores.ts';
import { COLUMNAS_ARTICULO, type Aviso, type FilaArticulo, type PasoTraza } from '../tipos.ts';
import { describirFiltros, type FiltrosConsulta } from './comun.ts';

// --- ¿Ya se cargaron los vectores? ------------------------------------------

let cacheVectores: { cargado_en: number; hay: boolean } | null = null;
const TTL_VECTORES_MS = 5 * 60 * 1000;

/**
 * Sin un solo vector guardado (`npm run embeber` no ha corrido), pedir el de
 * la pregunta solo gastaría cuota: se busca por palabras y se avisa.
 */
async function hayVectores(): Promise<boolean> {
  const ahora = Date.now();
  if (cacheVectores && ahora - cacheVectores.cargado_en < TTL_VECTORES_MS) return cacheVectores.hay;
  const { data, error } = await bd().from('articulos_vectores').select('id').limit(1);
  // Sin la tabla (migración 0007 sin aplicar) no hay búsqueda híbrida: el
  // llamador degrada.
  if (error) throw noDisponible(error);
  const hay = (data ?? []).length > 0;
  cacheVectores = { cargado_en: ahora, hay };
  return hay;
}

function noDisponible(e: unknown): ErrorBuscar {
  const detalle = typeof e === 'object' && e !== null && 'message' in e
    ? String((e as { message: unknown }).message)
    : String(e);
  return new ErrorBuscar(
    'BUSQUEDA_HIBRIDA_NO_DISPONIBLE',
    'La búsqueda por significado todavía no está instalada en la base.',
    {
      detalle: `Falta aplicar la migración 0007_vectores_en_tabla_aparte.sql (${detalle}).`,
      sugerencia: 'Mientras tanto se busca por palabras exactas.',
      causa: e,
    },
  );
}

/** PostgREST: la función o la columna no existen ⇒ migración sin aplicar. */
function esFaltaDeMigracion(e: { code?: string; message?: string } | null): boolean {
  if (!e) return false;
  return e.code === 'PGRST202' || e.code === '42883' || e.code === '42703' ||
    /does not exist|could not find the function/i.test(e.message ?? '');
}

// --- Qué se busca -----------------------------------------------------------

/**
 * Palabras del tema: `texto` y `temas` juntas y sin repetir. En estos carriles
 * `temas` nunca es un filtro duro (el router no conoce el vocabulario del
 * enriquecimiento, ver `sinTemasFantasma` en catalogo.ts): aquí son más
 * palabras para el ranking.
 */
export function textoDeBusqueda(f: FiltrosConsulta): string | null {
  const palabras = [f.texto ?? '', ...f.temas]
    .flatMap((p) => p.trim().split(/\s+/))
    .filter((p) => p !== '');
  const unicas = [...new Set(palabras.map((p) => p.toLowerCase()))];
  return unicas.length > 0 ? unicas.join(' ') : null;
}

/** Hay tema de verdad, no solo años sueltos ("¿qué se escribió sobre el 2006?"). */
export function hayTema(f: FiltrosConsulta): boolean {
  const t = textoDeBusqueda(f);
  return t !== null && t.replace(/\b\d{4}\b/g, '').trim() !== '';
}

// --- La búsqueda ------------------------------------------------------------

interface FilaRpc {
  id: number;
  puntaje: number;
  rango_vector: number | null;
  rango_texto: number | null;
  distancia: number | null;
}

export interface Candidato extends FilaArticulo {
  por_significado: boolean;
  por_palabras: boolean;
  distancia: number | null;
}

export interface ResultadoSignificado {
  candidatos: Candidato[];
  /** false cuando se buscó solo por palabras (sin vectores o falló el de la pregunta). */
  conSignificado: boolean;
  avisos: Aviso[];
  paso: PasoTraza;
}

export async function buscarPorSignificado(
  f: FiltrosConsulta,
  limite: number,
): Promise<ResultadoSignificado> {
  const t0 = performance.now();
  const avisos: Aviso[] = [];
  const texto = textoDeBusqueda(f);

  // 1. Vector de la pregunta, solo si hay contra qué compararlo.
  let vector: number[] | null = null;
  if (texto && await hayVectores()) {
    try {
      vector = await embeberConsulta(texto);
    } catch (e) {
      const err = e instanceof ErrorBuscar ? e : null;
      avisos.push({
        codigo: 'BUSQUEDA_SOLO_PALABRAS',
        mensaje: 'La búsqueda por significado no respondió: se buscó solo por palabras exactas.',
        detalle: err?.detalle ?? (e instanceof Error ? e.message : String(e)),
      });
    }
  } else if (texto) {
    avisos.push({
      codigo: 'VECTORES_PENDIENTES',
      mensaje: 'La búsqueda por significado todavía no está cargada: se buscó solo por palabras exactas.',
      detalle: 'No hay vectores en `articulos_vectores`. Se cargan con `npm run embeber` (también a diario por GitHub Actions).',
    });
  }

  // 2. Un viaje a la RPC: filtros duros + RRF de vector y texto.
  const { data, error } = await bd().rpc('buscar_articulos_hibrido', {
    p_texto: texto,
    p_embedding: vector ? `[${vector.join(',')}]` : null,
    p_autores: f.autores.length > 0 ? f.autores : null,
    p_anio_desde: f.rango_pub?.desde ?? null,
    p_anio_hasta: f.rango_pub?.hasta ?? null,
    p_anios_referidos: f.anios_referidos.length > 0 ? f.anios_referidos : null,
    p_limite: limite,
    p_distancia_max: HIBRIDA_DISTANCIA_MAX,
  });
  if (error) {
    if (esFaltaDeMigracion(error)) throw noDisponible(error);
    throw errorBd('búsqueda por significado', error);
  }
  const ranking = (data ?? []) as FilaRpc[];

  // 3. Las fichas, en el orden del ranking. Por tandas de 100 ids para no
  //    armar una URL gigante.
  const ids = ranking.map((r) => Number(r.id));
  const filas = new Map<number, FilaArticulo>();
  const tandas: number[][] = [];
  for (let i = 0; i < ids.length; i += 100) tandas.push(ids.slice(i, i + 100));
  await Promise.all(tandas.map(async (tanda) => {
    const { data: d, error: e } = await bd().from('articulos').select(COLUMNAS_ARTICULO).in('id', tanda);
    if (e) throw errorBd('fichas de la búsqueda por significado', e);
    for (const fila of (d ?? []) as unknown as FilaArticulo[]) filas.set(Number(fila.id), fila);
  }));

  const candidatos: Candidato[] = [];
  for (const r of ranking) {
    const fila = filas.get(Number(r.id));
    if (!fila) continue;
    candidatos.push({
      ...fila,
      por_significado: r.rango_vector !== null,
      por_palabras: r.rango_texto !== null,
      distancia: r.distancia,
    });
  }

  const nSignificado = candidatos.filter((c) => c.por_significado).length;
  const nPalabras = candidatos.filter((c) => c.por_palabras).length;
  const distancias = candidatos.map((c) => c.distancia).filter((d): d is number => d !== null);
  const rangoDist = distancias.length > 0
    ? ` · distancia ${Math.min(...distancias).toFixed(3)}–${Math.max(...distancias).toFixed(3)}`
    : '';

  return {
    candidatos,
    conSignificado: vector !== null,
    avisos,
    paso: {
      paso: 'sql',
      titulo: vector ? 'Buscó por significado y por palabras' : 'Buscó por palabras',
      detalle: `${describirFiltros({ ...f, temas: [], texto })} · ${candidatos.length} candidatos ` +
        `(${nSignificado} por significado, ${nPalabras} por palabras)${rangoDist}`,
      ms: Math.round(performance.now() - t0),
    },
  };
}
