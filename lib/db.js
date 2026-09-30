'use strict';
const { createClient } = require('@supabase/supabase-js');

let client = null;
function db() {
  if (!client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('Faltan SUPABASE_URL y SUPABASE_SERVICE_KEY');
    client = createClient(url, key, { auth: { persistSession: false } });
  }
  return client;
}

// Lanza el error de Supabase en vez de devolverlo silenciosamente
async function q(promise) {
  const { data, error } = await promise;
  if (error) throw new Error('DB: ' + error.message);
  return data;
}

async function getSetting(key, fallback = {}) {
  const rows = await q(db().from('settings').select('value').eq('key', key));
  return rows?.[0]?.value ?? fallback;
}
async function setSetting(key, value) {
  await q(db().from('settings').upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' }));
}

// Registro de corridas del cron
async function startRun(job) {
  const rows = await q(db().from('sync_runs').insert({ job }).select('id'));
  return rows[0].id;
}
async function finishRun(id, status, summary) {
  await q(db().from('sync_runs').update({ status, summary, finished_at: new Date().toISOString() }).eq('id', id));
}

// Inserción en lotes (PostgREST tiene límite de tamaño por request)
async function upsertChunks(table, rows, onConflict, size = 500) {
  for (let i = 0; i < rows.length; i += size) {
    await q(db().from(table).upsert(rows.slice(i, i + size), { onConflict }));
  }
}

module.exports = { db, q, getSetting, setSetting, startRun, finishRun, upsertChunks };
