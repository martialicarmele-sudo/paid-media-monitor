'use strict';
// Avisos: Slack (al instante) y mail (resumen diario vía Resend).
// Cada alerta se avisa una sola vez mientras siga abierta; si sube de
// gravedad (warning → critical) se vuelve a avisar.
const { db, q, getSetting } = require('./db');
const { SEV_RANK } = require('./engine');
const { hourNow } = require('./dates');
const { renderDigest } = require('../templates/email');

const FROM = () => `${process.env.FROM_NAME || 'Paid Media Monitor · Docta Nexus'} <${process.env.FROM_EMAIL || 'reportes@doctanexus.com'}>`;
const APP_URL = () => (process.env.APP_URL || '').replace(/\/$/, '');
const SEV_LABEL = { critical: 'Crítico', warning: 'Atención', info: 'Info' };
const SEV_ICON = { critical: '🔴', warning: '🟠', info: '🔵' };

// Canales de la tabla + los de variables de entorno (atajo para arrancar)
async function getChannels() {
  const rows = await q(db().from('notification_channels').select('*').eq('active', true));
  const env = [];
  if (process.env.SLACK_WEBHOOK_URL && !rows.some(r => r.type === 'slack' && r.target === process.env.SLACK_WEBHOOK_URL)) {
    env.push({ id: null, type: 'slack', label: 'Slack (variable de entorno)', target: process.env.SLACK_WEBHOOK_URL, client_id: null, min_severity: 'warning', mode: 'instant', quiet_hours: true });
  }
  for (const email of (process.env.ALERT_EMAILS || '').split(',').map(s => s.trim()).filter(Boolean)) {
    if (!rows.some(r => r.type === 'email' && r.target.toLowerCase() === email.toLowerCase())) {
      env.push({ id: null, type: 'email', label: email, target: email, client_id: null, min_severity: 'info', mode: 'digest', quiet_hours: false });
    }
  }
  return [...rows, ...env];
}

const matches = (ch, alert) => SEV_RANK[alert.severity] >= SEV_RANK[ch.min_severity] && (!ch.client_id || ch.client_id === alert.client_id);

async function sendSlack(webhook, text, blocks) {
  const r = await fetch(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, blocks }) });
  if (!r.ok) throw new Error(`Slack HTTP ${r.status}: ${(await r.text()).slice(0, 120)}`);
}

async function sendEmail(to, subject, html) {
  if (!process.env.RESEND_API_KEY) throw new Error('Falta RESEND_API_KEY');
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM(), to: Array.isArray(to) ? to : [to], subject, html }),
  });
  if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.message || `Resend HTTP ${r.status}`); }
}

function slackPayload(alerts) {
  const crit = alerts.filter(a => a.severity === 'critical').length;
  const title = crit ? `🚨 ${alerts.length} alerta${alerts.length > 1 ? 's' : ''} nueva${alerts.length > 1 ? 's' : ''} (${crit} crítica${crit > 1 ? 's' : ''})`
    : `${alerts.length} alerta${alerts.length > 1 ? 's' : ''} nueva${alerts.length > 1 ? 's' : ''}`;
  const sorted = [...alerts].sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity]);
  const lines = sorted.slice(0, 25).map(a => `${SEV_ICON[a.severity]} *${SEV_LABEL[a.severity]}* — ${a.message}`);
  if (sorted.length > 25) lines.push(`…y ${sorted.length - 25} más`);
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: title.slice(0, 150) } },
    { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n').slice(0, 2900) } },
  ];
  if (APP_URL()) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `<${APP_URL()}/#alertas|Ver en Paid Media Monitor>` }] });
  return { text: title, blocks };
}

async function log(channel, alertIds, kind, ok, error) {
  await q(db().from('notification_log').insert({ channel_id: channel.id, alert_ids: alertIds, kind, ok, error: error || null })).catch(() => {});
}

function inQuietHours(settings) {
  const h = hourNow();
  const s = settings.quiet_start ?? 22, e = settings.quiet_end ?? 8;
  return s > e ? (h >= s || h < e) : (h >= s && h < e);
}

// Avisos instantáneos (Slack / mail en modo instant) de alertas no avisadas
async function dispatchInstant() {
  const pending = await q(db().from('alerts').select('*').eq('status', 'open').is('notified_at', null));
  if (!pending.length) return { pending: 0, sent: 0 };
  const settings = await getSetting('alerts', {});
  const quiet = inQuietHours(settings);
  const channels = (await getChannels()).filter(c => c.mode === 'instant');
  let sent = 0, heldBack = false;
  for (const ch of channels) {
    const list = pending.filter(a => matches(ch, a));
    if (!list.length) continue;
    if (quiet && ch.quiet_hours) { heldBack = true; continue; }
    try {
      if (ch.type === 'slack') { const p = slackPayload(list); await sendSlack(ch.target, p.text, p.blocks); }
      else if (ch.type === 'email') {
        const crit = list.filter(a => a.severity === 'critical').length;
        await sendEmail(ch.target, `${crit ? '🚨 ' : ''}${list.length} alerta${list.length > 1 ? 's' : ''} nueva${list.length > 1 ? 's' : ''} — Paid Media Monitor`,
          renderDigest({ mode: 'instant', alerts: list, appUrl: APP_URL() }));
      }
      await log(ch, list.map(a => a.id), 'instant', true);
      sent++;
    } catch (e) {
      console.error('[notify]', ch.label || ch.type, e.message);
      await log(ch, list.map(a => a.id), 'instant', false, e.message);
    }
  }
  // Si algún canal quedó en pausa por horario, se reintenta en el próximo chequeo
  if (!heldBack) {
    await q(db().from('alerts').update({ notified_at: new Date().toISOString() }).in('id', pending.map(a => a.id)));
  }
  return { pending: pending.length, sent, heldBack };
}

// Resumen diario por mail: estado de todos los clientes + alertas abiertas
async function sendDigest(state, insights = {}, { force = false } = {}) {
  const channels = (await getChannels()).filter(c => c.type === 'email' && c.mode === 'digest');
  if (!channels.length) return { ok: false, error: 'No hay destinatarios de mail configurados' };
  const alerts = await q(db().from('alerts').select('*').eq('status', 'open').order('severity'));
  const since = Date.now() - 26 * 3600 * 1000;
  let sent = 0;
  const errors = [];
  // Agrupa destinatarios con el mismo alcance para mandar un solo mail
  const groups = new Map();
  for (const ch of channels) {
    const key = `${ch.client_id || 'all'}|${ch.min_severity}`;
    if (!groups.has(key)) groups.set(key, { client_id: ch.client_id, min_severity: ch.min_severity, to: [], chans: [] });
    groups.get(key).to.push(ch.target); groups.get(key).chans.push(ch);
  }
  for (const g of groups.values()) {
    const clients = g.client_id ? state.clients.filter(c => c.id === g.client_id) : state.clients;
    const list = alerts.filter(a => matches(g, a)).map(a => ({ ...a, is_new: new Date(a.first_seen_at).getTime() >= since }));
    if (!force && !clients.length) continue;
    const crit = list.filter(a => a.severity === 'critical').length;
    const subject = `${crit ? '🚨 ' : ''}Paid Media — resumen ${state.today.split('-').reverse().join('/')}${list.length ? ` · ${list.length} alerta${list.length > 1 ? 's' : ''}` : ' · todo en orden'}`;
    try {
      await sendEmail(g.to, subject, renderDigest({ mode: 'digest', state: { ...state, clients }, alerts: list, insights, appUrl: APP_URL() }));
      for (const ch of g.chans) await log(ch, list.map(a => a.id), 'digest', true);
      sent += g.to.length;
    } catch (e) {
      errors.push(e.message);
      for (const ch of g.chans) await log(ch, [], 'digest', false, e.message);
    }
  }
  return { ok: !errors.length, sent, errors };
}

async function testChannel(ch) {
  const sample = [{ severity: 'warning', message: 'Mensaje de prueba de Paid Media Monitor — el canal está bien configurado.' }];
  if (ch.type === 'slack') { const p = slackPayload(sample); await sendSlack(ch.target, 'Prueba', p.blocks); }
  else if (ch.type === 'email') await sendEmail(ch.target, 'Prueba — Paid Media Monitor', renderDigest({ mode: 'instant', alerts: sample, appUrl: APP_URL() }));
  else throw new Error('Tipo de canal no soportado');
}

module.exports = { getChannels, dispatchInstant, sendDigest, testChannel, slackPayload, inQuietHours };
