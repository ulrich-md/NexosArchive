// Acceso a la base. SIEMPRE con service role: las tablas tienen RLS sin
// ninguna policy de SELECT, así que este es el único camino de lectura del
// archivo (CLAUDE.md sección 6). La anon key no aparece en este archivo.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { supabaseServiceRole, supabaseUrl } from './config.ts';
import { errorBd } from './errores.ts';
import { normalizar, tokens } from './texto.ts';

let cliente: SupabaseClient | null = null;

export function bd(): SupabaseClient {
  if (!cliente) {
    cliente = createClient(supabaseUrl(), supabaseServiceRole(), {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { 'x-archivo-nexos': 'buscar' } },
    });
  }
  return cliente;
}

/**
 * ¿El archivo está cargado? Si no lo está, la respuesta honesta es decirlo y
 * mandar a `/admin` — nunca inventar datos de ejemplo (sección 7, regla 4).
 */
export async function archivoVacio(): Promise<boolean> {
  const { count, error } = await bd()
    .from('articulos')
    .select('id', { count: 'exact', head: true });
  if (error) throw errorBd('conteo de articulos', error);
  return (count ?? 0) === 0;
}

// --- Catálogo de autores ----------------------------------------------------

export interface AutorConteo {
  autor: string;
  n: number;
  clave: string; // normalizado, para emparejar sin acentos
}

interface CacheAutores {
  cargado_en: number;
  autores: AutorConteo[];
}

const TTL_CACHE_AUTORES_MS = 10 * 60 * 1000;
let cacheAutores: CacheAutores | null = null;

/**
 * Lee la vista materializada `autores_conteo`. Es la misma que alimenta el
 * sidebar: contar 19 mil filas en vivo es lo que congela la app hoy
 * (CLAUDE.md sección 3, mejora 2). Se cachea en el isolate por 10 minutos.
 */
export async function catalogoAutores(): Promise<AutorConteo[]> {
  const ahora = Date.now();
  if (cacheAutores && ahora - cacheAutores.cargado_en < TTL_CACHE_AUTORES_MS) {
    return cacheAutores.autores;
  }

  const { data, error } = await bd()
    .from('autores_conteo')
    .select('autor,n')
    .order('n', { ascending: false })
    .limit(20_000);
  if (error) throw errorBd('lectura de autores_conteo', error);

  const autores: AutorConteo[] = (data ?? [])
    .filter((f) => typeof f.autor === 'string' && f.autor.trim() !== '')
    .map((f) => ({
      autor: String(f.autor),
      n: Number(f.n ?? 0),
      clave: normalizar(String(f.autor)),
    }));

  cacheAutores = { cargado_en: ahora, autores };
  return autores;
}

export interface AutorResuelto {
  /** Nombre EXACTO como está en la base. Nunca el que escribió el usuario. */
  autor: string;
  n: number;
  /** Otros candidatos, cuando el nombre era ambiguo. */
  ambiguos: string[];
}

/**
 * Resuelve un nombre escrito por el usuario contra los autores que de verdad
 * existen. Si no resuelve devuelve null: preferimos no filtrar a filtrar por un
 * autor inventado (sección 7). Nunca se le repone un acento a mano a un nombre.
 */
export async function resolverAutor(nombre: string): Promise<AutorResuelto | null> {
  const buscado = normalizar(nombre);
  if (buscado.length < 3) return null;

  const catalogo = await catalogoAutores();

  if (catalogo.length > 0) {
    const exacto = catalogo.filter((a) => a.clave === buscado);
    if (exacto.length > 0) {
      const mejor = exacto.reduce((a, b) => (b.n > a.n ? b : a));
      return { autor: mejor.autor, n: mejor.n, ambiguos: [] };
    }

    // Emparejamiento por tokens: todos los tokens del nombre buscado tienen
    // que aparecer en el nombre real (así "Aguilar Camín" encuentra a
    // "Héctor Aguilar Camín", y "mastretta" a "Ángeles Mastretta").
    const buscados = tokens(buscado).filter((t) => t.length >= 3);
    if (buscados.length > 0) {
      const candidatos = catalogo.filter((a) => {
        const propios = new Set(tokens(a.clave));
        return buscados.every((t) => propios.has(t));
      });
      if (candidatos.length > 0) {
        const ordenados = [...candidatos].sort((a, b) => b.n - a.n);
        return {
          autor: ordenados[0].autor,
          n: ordenados[0].n,
          ambiguos: ordenados.slice(1, 4).map((a) => a.autor),
        };
      }
    }
  }

  // Respaldo: la vista materializada puede estar vacía si nadie corrió
  // `refresh materialized view autores_conteo` después de la ingesta. En ese
  // caso se prueba el nombre tal cual contra la tabla, sin adivinar acentos.
  const { count, error } = await bd()
    .from('articulos')
    .select('id', { count: 'exact', head: true })
    .overlaps('autores', [nombre.trim()]);
  if (error) throw errorBd('sondeo de autor en articulos', error);
  if ((count ?? 0) > 0) return { autor: nombre.trim(), n: count ?? 0, ambiguos: [] };

  return null;
}

/** Solo para pruebas: limpia la caché del isolate. */
export function _limpiarCacheAutores(): void {
  cacheAutores = null;
}
