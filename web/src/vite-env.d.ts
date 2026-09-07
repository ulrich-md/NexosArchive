/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  /**
   * Llave PÚBLICA (anon). Es pública por diseño: no da acceso a las tablas,
   * porque RLS deniega todo y no hay ninguna policy de SELECT
   * (CLAUDE.md sección 6). Nunca poner aquí la service role.
   */
  readonly VITE_SUPABASE_ANON_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
