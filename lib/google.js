'use strict';
// Conector Google Ads — autenticación a nivel agencia. Las cuentas se dan
// de alta a mano desde el panel. GOOGLE_ADS_MCC_ID es opcional: se usa
// solo si las cuentas se acceden a través de un MCC.
const VER  = process.env.GOOGLE_ADS_API_VERSION || 'v24';
const BASE = `https://googleads.googleapis.com/${VER}`;

const mccId = () => (process.env.GOOGLE_ADS_MCC_ID || process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || '').replace(/-/g, '');
const isConfigured = () => !!(process.env.GOOGLE_ADS_DEVELOPER_TOKEN && process.env.GOOGLE_ADS_REFRESH_TOKEN
  && process.env.GOOGLE_ADS_CLIENT_ID && process.env.GOOGLE_ADS_CLIENT_SECRET);

let cached = { token: null, exp: 0 };
async function accessToken() {
  if (cached.token && Date.now() < cached.exp - 60000) return cached.token;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_ADS_CLIENT_ID,
      client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error('Google Ads OAuth: ' + (d.error_description || d.error || r.status));
  cached = { token: d.access_token, exp: Date.now() + (d.expires_in || 3600) * 1000 };
  return cached.token;
}

async function gaql(customerId, query) {
  const cid = String(customerId).replace(/-/g, '');
  const tok = await accessToken();
  const out = [];
  let pageToken;
  do {
    const r = await fetch(`${BASE}/customers/${cid}/googleAds:search`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tok}`,
        'developer-token': process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
        ...(mccId() ? { 'login-customer-id': mccId() } : {}),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(pageToken ? { query, pageToken } : { query }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      const detail = d.error?.details?.[0]?.errors?.[0]?.message;
      throw new Error('Google Ads: ' + (detail || d.error?.message || `HTTP ${r.status}`));
    }
    out.push(...(d.results || []));
    pageToken = d.nextPageToken;
  } while (pageToken);
  return out;
}

const micros = v => (parseInt(v || 0, 10) || 0) / 1e6;

// Acepta "123-456-7890" o "1234567890"
const normalizeId = raw => { const d = String(raw || '').replace(/\D/g, ''); return d.length === 10 ? d : null; };

async function fetchAccountInfo(customerId) {
  const rows = await gaql(customerId, `SELECT customer.descriptive_name, customer.currency_code, customer.time_zone, customer.status FROM customer LIMIT 1`);
  const c = rows[0]?.customer || {};
  return { name: c.descriptiveName, currency: c.currencyCode, timezone: c.timeZone, status: c.status || 'UNKNOWN', status_detail: {} };
}

async function fetchAccountStatus(customerId) {
  const rows = await gaql(customerId, `SELECT customer.status FROM customer LIMIT 1`);
  return { status: rows[0]?.customer?.status || 'UNKNOWN', status_detail: {} };
}

function campaignQuery(since, until, withIS) {
  return `
    SELECT campaign.id, campaign.name, segments.date,
           metrics.cost_micros, metrics.impressions, metrics.clicks,
           metrics.conversions, metrics.conversions_value${withIS ? ', metrics.search_budget_lost_impression_share' : ''}
    FROM campaign
    WHERE segments.date BETWEEN '${since}' AND '${until}'`;
}

// Métricas diarias por campaña; el nivel cuenta se arma sumando (en
// Google todas estas métricas son sumables)
async function fetchDaily(customerId, since, until) {
  let rows;
  try { rows = await gaql(customerId, campaignQuery(since, until, true)); }
  catch (e) { rows = await gaql(customerId, campaignQuery(since, until, false)); }

  const out = [];
  const byDate = new Map();
  for (const r of rows) {
    const m = r.metrics || {};
    const row = {
      level: 'campaign',
      entity_id: String(r.campaign.id),
      entity_name: r.campaign.name,
      date: r.segments.date,
      spend: micros(m.costMicros),
      impressions: parseInt(m.impressions || 0, 10),
      clicks: parseInt(m.clicks || 0, 10),
      reach: null, frequency: null,
      conversions: parseFloat(m.conversions || 0),
      conv_value: parseFloat(m.conversionsValue || 0),
      purchases: 0, leads: 0,
      extra: m.searchBudgetLostImpressionShare != null ? { budget_lost_is: parseFloat(m.searchBudgetLostImpressionShare) } : {},
    };
    out.push(row);
    const a = byDate.get(row.date) || { level: 'account', entity_id: String(customerId), entity_name: null, date: row.date,
      spend: 0, impressions: 0, clicks: 0, reach: null, frequency: null, conversions: 0, conv_value: 0, purchases: 0, leads: 0, extra: {} };
    a.spend += row.spend; a.impressions += row.impressions; a.clicks += row.clicks;
    a.conversions += row.conversions; a.conv_value += row.conv_value;
    byDate.set(row.date, a);
  }
  // Días sin ninguna fila (cuenta sin gasto) igual quedan registrados en 0
  for (let d = since; d <= until; d = require('./dates').addDays(d, 1)) {
    if (!byDate.has(d)) byDate.set(d, { level: 'account', entity_id: String(customerId), entity_name: null, date: d,
      spend: 0, impressions: 0, clicks: 0, reach: null, frequency: null, conversions: 0, conv_value: 0, purchases: 0, leads: 0, extra: {} });
  }
  return [...out, ...byDate.values()];
}

async function fetchCampaigns(customerId) {
  const rows = await gaql(customerId, `
    SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
           campaign.bidding_strategy_type, campaign.primary_status, campaign.primary_status_reasons,
           campaign_budget.amount_micros
    FROM campaign
    WHERE campaign.status != 'REMOVED'`);
  return rows.map(r => ({
    external_id: String(r.campaign.id),
    name: r.campaign.name,
    status: r.campaign.status,
    objective: r.campaign.advertisingChannelType,
    daily_budget: r.campaignBudget?.amountMicros ? micros(r.campaignBudget.amountMicros) : null,
    lifetime_budget: null,
    bidding_strategy: r.campaign.biddingStrategyType,
    extra: { primary_status: r.campaign.primaryStatus, reasons: r.campaign.primaryStatusReasons || [] },
  }));
}

async function countDisapprovedAds(customerId) {
  const rows = await gaql(customerId, `
    SELECT ad_group_ad.ad.id FROM ad_group_ad
    WHERE ad_group_ad.policy_summary.approval_status = 'DISAPPROVED'
      AND ad_group_ad.status = 'ENABLED' AND campaign.status = 'ENABLED' AND ad_group.status = 'ENABLED'`);
  return rows.length;
}

module.exports = { isConfigured, normalizeId, fetchAccountInfo, fetchAccountStatus, fetchDaily, fetchCampaigns, countDisapprovedAds, mccId };
