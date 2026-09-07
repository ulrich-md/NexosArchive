/**
 * Verifica que el frontend no lea tablas de Supabase directamente.
 *
 * CLAUDE.md sección 6: la anon key vive en el navegador. Si el cliente puede
 * consultar las tablas, cualquiera con las DevTools se descarga 56 años del
 * archivo de pago. Toda lectura pasa por una Edge Function con service role.
 *
 * Esto es la parte VERIFICABLE de esa regla: un comentario no impide que
 * alguien escriba `.from('articulos')` dentro de seis meses; esta prueba sí.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = fileURLToPath(new URL('../src', import.meta.url));

/** Patrones prohibidos: acceso a datos que salta la Edge Function. */
const PROHIBIDO = [
  { re: /\.from\s*\(\s*['"`]/, motivo: "acceso directo a una tabla (.from('tabla'))" },
  { re: /\.rpc\s*\(\s*['"`]/, motivo: 'llamada directa a una función de Postgres (.rpc)' },
  { re: /\/rest\/v1\//, motivo: 'llamada directa a PostgREST (/rest/v1/)' },
  { re: /SUPABASE_SERVICE_ROLE/i, motivo: 'la service role key no puede tocar el frontend' },
];

/** Solo `sesion.ts` puede crear el cliente de Supabase, y solo para auth. */
const CREA_CLIENTE = /createClient\s*\(/;
const PERMITIDO_CREAR_CLIENTE = 'lib/sesion.ts';

function archivos(dir) {
  return readdirSync(dir).flatMap((n) => {
    const ruta = join(dir, n);
    if (statSync(ruta).isDirectory()) return archivos(ruta);
    return /\.(ts|tsx)$/.test(ruta) ? [ruta] : [];
  });
}

const fallas = [];

for (const ruta of archivos(raiz)) {
  const rel = relative(raiz, ruta).replaceAll('\\', '/');
  const lineas = readFileSync(ruta, 'utf8').split('\n');

  lineas.forEach((linea, i) => {
    // Los comentarios que citan la regla no son violaciones de la regla.
    const codigo = linea.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
    if (/^\s*\*/.test(linea)) return;

    for (const { re, motivo } of PROHIBIDO) {
      if (re.test(codigo)) fallas.push(`${rel}:${i + 1} — ${motivo}\n    ${linea.trim()}`);
    }

    if (CREA_CLIENTE.test(codigo) && rel !== PERMITIDO_CREAR_CLIENTE) {
      fallas.push(
        `${rel}:${i + 1} — solo ${PERMITIDO_CREAR_CLIENTE} puede crear el cliente de Supabase\n    ${linea.trim()}`,
      );
    }
  });
}

if (fallas.length > 0) {
  console.error('\nEl frontend está tocando la base directamente:\n');
  for (const f of fallas) console.error('  ' + f + '\n');
  console.error('Toda lectura del archivo pasa por una Edge Function (CLAUDE.md sección 6).\n');
  process.exit(1);
}

console.log('Seguridad: el frontend no lee tablas directamente. OK.');
