import { createClient } from '@supabase/supabase-js';

export function clienteSupabase() {
  const url = process.env.SUPABASE_URL;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRole) {
    console.error('Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en el entorno. Copia .env.example a .env y complétalo.');
    process.exit(1);
  }

  return createClient(url, serviceRole, { auth: { persistSession: false } });
}
