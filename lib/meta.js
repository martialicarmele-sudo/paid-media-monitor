'use strict';
// Conector Meta Ads — un único token de System User (no vence).
// Las cuentas se dan de alta a mano desde el panel (no hay importación).
const VER  = process.env.META_API_VERSION || 'v23.0';
const BASE = `https://graph.facebook.com/${VER}`;

const token      = () => process.env.META_SYSTEM_USER_TOKEN;
const isConfigured = () => !!token();

// Acepta "123", "act_123" o con espacios → "act_123"
function normalizeId(raw) {
  const digits = String(raw || '').replace(/^act_/i, '').replace(/\D/g, '');
  return digits ? 'act_' + digits : null;
}

// account_status de Meta → estado normalizado
const ACCOUNT_STATUS = {
  1: 'ACTIVE', 2: 'DISABLED', 3: 'UNSETTLED', 7: 'PENDING_RISK_REVIEW',
  8: 'PENDING_SETTLEMENT', 9: 'IN_GRACE_PERIOD', 100: 'PENDING_CLOSURE',
  101: 'CLOSED', 201: 'ANY_ACTIVE', 202: 'ANY_CLOSED',
};
const DISABLE_REASON = {
  0: null, 1: 'Incumplimiento de políticas publicitarias', 2: 'Revisión de integridad',
  3: 'Pago pendiente / riesgo de pago', 4: 'Cuenta gris cerrada', 5: 'Revisión de AFC',
  6: 'Integridad del Business Manager', 7: 'Cierre permanente', 8: 'Cuenta de revendedor inactiva',
  9: 'Cuenta sin usar', 10: 'Cuenta de revendedor inactiva',
};

async function metaGet(path, params = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  url.searchParams.set('access_token', token());
  const r = await fetch(url);
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) throw new Error('Meta: ' + (d.error?.message || `HTTP ${r.status}`));
  return d;
}

// Sigue la paginación de Meta (paging.next) hasta traer todo
async function metaGetAll(path, params = {}, maxPages = 50) {
  let d = await metaGet(path, { limit: '200', ...params });
  const out = [...(d.data || [])];
  let pages = 1;
  while (d.paging?.next && pages < maxPages) {
    const r = await fetch(d.paging.next);
    d = await r.json().catch(() => ({}));
    if (d.error) throw new Error('Meta: ' + d.error.message);
    out.push(...(d.data || []));
    pages++;
  }
  return out;
}

// Datos básicos de una cuenta (para validar el alta manual)
async function fetchAccountInfo(actId) {
  const a = await metaGet(`/${actId}`, { fields: 'name,account_status,disable_reason,currency,timezone_name' });
  return {
    name: a.name, currency: a.currency, timezone: a.timezone_name,
    status: ACCOUNT_STATUS[a.account_status] || String(a.account_status),
    status_detail: { account_status: a.account_status, disable_reason: DISABLE_REASON[a.disable_reason] ?? a.disable_reason ?? null },
  };
}

// Estado puntual de una cuenta (para el chequeo crítico cada pocas horas)
async function fetchAccountStatus(actId) {
  const a = await metaGet(`/${actId}`, { fields: 'account_status,disable_reason,name' });
  return {
    status: ACCOUNT_STATUS[a.account_status] || String(a.account_status),
    status_detail: { account_status: a.account_status, disable_reason: DISABLE_REASON[a.disable_reason] ?? a.disable_reason ?? null },
  };
}

function pickAction(list, types) {
  if (!Array.isArray(list)) return 0;
  for (const t of types) {
    const f = list.find(x => x.action_type === t);
    if (f) return parseFloat(f.value) || 0;
  }
  return 0;
}
const PURCHASE_TYPES = ['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase'];
const LEAD_TYPES     = ['lead', 'onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead'];

function parseInsightRow(r) {
  const purchases = pickAction(r.actions, PURCHASE_TYPES);
  const leads     = pickAction(r.actions, LEAD_TYPES);
  return {
    date: r.date_start,
    spend: parseFloat(r.spend || 0),
    impressions: parseInt(r.impressions || 0, 10),
    clicks: parseInt(r.clicks || 0, 10),
    reach: r.reach != null ? parseInt(r.reach, 10) : null,
    frequency: r.frequency != null ? parseFloat(r.frequency) : null,
    purchases, leads,
    conversions: purchases + leads,
    conv_value: pickAction(r.action_values, PURCHASE_TYPES),
  };
}

// Métricas diarias: nivel cuenta + nivel campaña
async function fetchDaily(actId, since, until) {
  const time_range = { since, until };
  const base = 'spend,impressions,clicks,actions,action_values,date_start';
  const [acc, camp] = await Promise.all([
    metaGetAll(`/${actId}/insights`, { level: 'account', time_increment: '1', time_range, fields: base + ',reach,frequency' }),
    metaGetAll(`/${actId}/insights`, { level: 'campaign', time_increment: '1', time_range, fields: base + ',campaign_id,campaign_name' }),
  ]);
  const rows = [];
  for (const r of acc) rows.push({ level: 'account', entity_id: actId, entity_name: null, ...parseInsightRow(r) });
  for (const r of camp) rows.push({ level: 'campaign', entity_id: r.campaign_id, entity_name: r.campaign_name, ...parseInsightRow(r), reach: null, frequency: null });
  return rows;
}

// Frecuencia y CPM de los últimos 7 días vs los 7 anteriores (no son
// sumables día a día, así que se piden agregados)
async function fetchWeekCompare(actId, today) {
  const { addDays } = require('./dates');
  const y = addDays(today, -1);
  const ranges = { last: { since: addDays(y, -6), until: y }, prev: { since: addDays(y, -13), until: addDays(y, -7) } };
  const out = {};
  for (const [k, time_range] of Object.entries(ranges)) {
    const d = await metaGet(`/${actId}/insights`, { level: 'account', time_range, fields: 'frequency,cpm,ctr' });
    const r = d.data?.[0] || {};
    out[k] = { frequency: parseFloat(r.frequency || 0), cpm: parseFloat(r.cpm || 0), ctr: parseFloat(r.ctr || 0) };
  }
  return out;
}

async function fetchCampaigns(actId) {
  const list = await metaGetAll(`/${actId}/campaigns`, {
    fields: 'id,name,effective_status,objective,daily_budget,lifetime_budget,bid_strategy',
    effective_status: ['ACTIVE', 'PAUSED', 'WITH_ISSUES', 'IN_PROCESS'],
  });
  return list.map(c => ({
    external_id: c.id, name: c.name, status: c.effective_status, objective: c.objective,
    daily_budget: c.daily_budget ? parseInt(c.daily_budget, 10) / 100 : null,
    lifetime_budget: c.lifetime_budget ? parseInt(c.lifetime_budget, 10) / 100 : null,
    bidding_strategy: c.bid_strategy || null,
  }));
}

async function countDisapprovedAds(actId) {
  const d = await metaGet(`/${actId}/ads`, { effective_status: ['DISAPPROVED'], summary: 'total_count', limit: '1', fields: 'id' });
  return d.summary?.total_count ?? (d.data || []).length;
}

module.exports = { isConfigured, normalizeId, fetchAccountInfo, fetchAccountStatus, fetchDaily, fetchWeekCompare, fetchCampaigns, countDisapprovedAds, parseInsightRow };
