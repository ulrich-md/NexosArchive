// Cache en disco del mapa de autores (id de coautor -> nombre real).
// Vive aparte del script que lo construye para que la ingesta pueda leerlo
// sin ejecutar nada.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

export const RUTA_CACHE = 'datos/autores.json';

export interface CacheAutores {
  actualizado_en: string;
  /** id de coautor -> nombre real con acentos. */
  nombres: Record<string, string>;
  /** slugs que no se pudieron resolver; sin nombre no hay autor. */
  sin_resolver: string[];
}

export function leerCache(): CacheAutores | null {
  if (!existsSync(RUTA_CACHE)) return null;
  return JSON.parse(readFileSync(RUTA_CACHE, 'utf8')) as CacheAutores;
}

export function guardarCache(cache: CacheAutores): void {
  mkdirSync('datos', { recursive: true });
  cache.actualizado_en = new Date().toISOString();
  writeFileSync(RUTA_CACHE, JSON.stringify(cache, null, 2));
}

/** El mapa listo para usar en la ingesta. */
export function mapaDesdeCache(cache: CacheAutores): Map<number, string> {
  return new Map(Object.entries(cache.nombres).map(([id, nombre]) => [Number(id), nombre]));
}
