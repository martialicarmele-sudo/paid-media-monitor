'use strict';
// Insight IA: se genera UNA vez por día y por cliente (después del sync)
// y queda guardado. El panel solo lo lee — antes se llamaba a Claude por
// cada cliente cada vez que se abría el dashboard.
const { db, q } = require('./db');
const { PLATFORM_LABEL } = require('./engine');

const MODEL = () => process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

function contextFor(c) {
  const plat = {};
  for (const [p, v] of Object.entries(c.platforms)) {
    plat[PLATFORM_LABEL[p]] = { pacing: v.pacing, ultimos7: v.perf.last7, semanaAnterior: v.perf.prev7 };
  }
  return {
    cliente: c.name, tipo: c.client_type, moneda: c.currency,
    objetivos: c.targets, total: c.total.pacing, plataformas: plat,
  };
}

async function generateOne(c) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL(),
      max_tokens: 400,
      system: `Sos analista senior de paid media (Meta Ads y Google Ads) en la agencia Docta Nexus.
Con el estado de un cliente, devolvé SOLO un JSON (sin markdown) con:
- "cierre": string corto con el gasto proyectado a fin de mes vs presupuesto
- "insight": string (máx 140 caracteres) con lo más importante que está pasando
- "accion": string (máx 140 caracteres) con el ajuste concreto recomendado (qué plataforma, cuánto)
- "riesgo": "bajo" | "medio" | "alto"
Español rioplatense, concreto, sin emojis, sin jerga innecesaria. Usá solo los datos recibidos.`,
      messages: [{ role: 'user', content: JSON.stringify(contextFor(c)) }],
    }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error?.message || `Anthropic HTTP ${r.status}`);
  const text = (d.content?.[0]?.text || '').replace(/```json|```/g, '').trim();
  return JSON.parse(text);
}

async function generateForecasts(state) {
  if (!process.env.ANTHROPIC_API_KEY) return { skipped: 'sin ANTHROPIC_API_KEY' };
  let ok = 0, failed = 0;
  for (const c of state.clients) {
    const hasData = c.total.pacing.spend_mtd > 0 || c.total.pacing.budget;
    if (!hasData) continue;
    try {
      const forecast = await generateOne(c);
      await q(db().from('ai_insights').upsert({ client_id: c.id, date: state.today, forecast, model: MODEL() }, { onConflict: 'client_id,date' }));
      ok++;
    } catch (e) {
      console.error('[forecast]', c.name, e.message);
      failed++;
    }
  }
  return { ok, failed };
}

async function latestInsights(clientIds) {
  if (!clientIds.length) return {};
  const rows = await q(db().from('ai_insights').select('client_id,date,forecast').in('client_id', clientIds).order('date', { ascending: false }).limit(clientIds.length * 3));
  const out = {};
  for (const r of rows) if (!out[r.client_id]) out[r.client_id] = { date: r.date, ...r.forecast };
  return out;
}

module.exports = { generateForecasts, latestInsights };
