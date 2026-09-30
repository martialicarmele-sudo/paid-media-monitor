'use strict';
// Sincronización: guarda la foto diaria de las cuentas cargadas en el panel.
const meta   = require('./meta');
const google = require('./google');
const { db, q, upsertChunks } = require('./db');
const { todayStr, addDays, monthStart } = require('./dates');

const connector = p => (p === 'meta' ? meta : google);

async function monitoredAccounts() {
  return q(db().from('ad_accounts').select('*').eq('monitored', true));
}

// Lotes con concurrencia limitada (no saturar las APIs)
async function pool(items, n, fn) {
  const results = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const idx = i++; results[idx] = await fn(items[idx]).catch(e => ({ error: e.message })); }
  });
  await Promise.all(workers);
  return results;
}

async function saveMetrics(account, rows) {
  const now = new Date().toISOString();
  const payload = rows.map(r => ({
    account_id: account.id, date: r.date, level: r.level, entity_id: r.entity_id, entity_name: r.entity_name,
    spend: r.spend, impressions: r.impressions, clicks: r.clicks, reach: r.reach, frequency: r.frequency,
    conversions: r.conversions, conv_value: r.conv_value, leads: r.leads || 0, purchases: r.purchases || 0,
    extra: r.extra || {}, synced_at: now,
  }));
  await upsertChunks('metrics_daily', payload, 'account_id,date,level,entity_id');
}

// Sincroniza una cuenta: métricas + campañas + estado.
// full=true → sync diario completo; full=false → chequeo rápido (hoy y ayer).
async function syncAccount(account, { full = true, today = todayStr() } = {}) {
  const c = connector(account.platform);
  const patch = { last_synced_at: new Date().toISOString(), last_error: null };
  try {
    const until = today;
    let since;
    if (full) {
      const has = await q(db().from('metrics_daily').select('date').eq('account_id', account.id).eq('level', 'account').limit(1));
      // Primera vez: 35 días para tener mes en curso + comparación semanal.
      // Después: últimos 3 días (las plataformas ajustan atribución).
      since = has.length ? addDays(today, -3) : [addDays(today, -35), monthStart(addDays(today, -1))].sort()[0];
    } else {
      since = addDays(today, -1);
    }
    const rows = await c.fetchDaily(account.external_id, since, until);
    await saveMetrics(account, rows);

    const st = await c.fetchAccountStatus(account.external_id);
    patch.status = st.status;
    const detail = { ...(account.status_detail || {}), ...st.status_detail };
    detail.disapproved_ads = await c.countDisapprovedAds(account.external_id).catch(() => detail.disapproved_ads ?? null);

    if (full) {
      const camps = await c.fetchCampaigns(account.external_id);
      const now = new Date().toISOString();
      await upsertChunks('campaigns', camps.map(x => ({ account_id: account.id, extra: {}, ...x, updated_at: now })), 'account_id,external_id');
      if (account.platform === 'meta') detail.week = await meta.fetchWeekCompare(account.external_id, today).catch(() => detail.week);
    }
    patch.status_detail = detail;
    await q(db().from('ad_accounts').update(patch).eq('id', account.id));
    return { id: account.id, ok: true, rows: rows.length };
  } catch (e) {
    await q(db().from('ad_accounts').update({ last_error: e.message.slice(0, 500), last_synced_at: patch.last_synced_at }).eq('id', account.id)).catch(() => {});
    return { id: account.id, ok: false, error: e.message };
  }
}

async function syncAll({ full = true } = {}) {
  const accounts = await monitoredAccounts();
  const results = await pool(accounts, 3, a => syncAccount(a, { full }));
  return {
    accounts: accounts.length,
    ok: results.filter(r => r?.ok).length,
    failed: results.map((r, i) => ({ r, a: accounts[i] })).filter(x => !x.r?.ok)
      .map(x => ({ account: x.a?.name, error: x.r?.error })),
  };
}

module.exports = { syncAccount, syncAll };
