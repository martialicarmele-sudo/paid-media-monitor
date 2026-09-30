'use strict';
// Orquestación de las tareas programadas. Un candado evita que dos
// corridas se pisen (ej. el chequeo de las 10:30 mientras sigue el sync).
const { startRun, finishRun, getSetting } = require('./db');
const { syncAll } = require('./sync');
const { runAlerts, computeState, publicState } = require('./engine');
const { generateForecasts, latestInsights } = require('./forecast');
const { dispatchInstant, sendDigest } = require('./notify');

let running = null;

async function withRun(job, fn) {
  if (running) return { skipped: `ya hay una corrida en curso (${running})` };
  running = job;
  const id = await startRun(job).catch(() => null);
  try {
    const summary = await fn();
    const status = summary?.sync?.failed?.length ? 'partial' : 'ok';
    if (id) await finishRun(id, status, summary).catch(() => {});
    console.log(`[job] ${job} ${status}`, JSON.stringify(summary).slice(0, 400));
    return { status, ...summary };
  } catch (e) {
    console.error(`[job] ${job} error:`, e.message);
    if (id) await finishRun(id, 'error', { error: e.message }).catch(() => {});
    return { status: 'error', error: e.message };
  } finally {
    running = null;
  }
}

// Diario (madrugada): importa cuentas, guarda métricas, evalúa todo,
// genera insights IA y avisa lo nuevo.
const dailyJob = () => withRun('daily_sync', async () => {
  const sync = await syncAll({ full: true });
  const alerts = await runAlerts('full');
  const forecasts = await generateForecasts(alerts.state);
  const notify = await dispatchInstant();
  delete alerts.state;
  return { sync, alerts, forecasts, notify };
});

// Cada pocas horas: solo lo urgente (cuenta caída, sin gasto hoy,
// presupuesto agotado) con datos de hoy.
const criticalJob = () => withRun('critical_check', async () => {
  const sync = await syncAll({ full: false });
  const alerts = await runAlerts('critical');
  const notify = await dispatchInstant();
  delete alerts.state;
  return { sync, alerts, notify };
});

const digestJob = ({ force = false } = {}) => withRun('digest', async () => {
  const state = await computeState();
  const insights = await latestInsights(state.clients.map(c => c.id));
  return { digest: await sendDigest(publicState(state), insights, { force }) };
});

const isRunning = () => running;

async function scheduleConfig() {
  const s = await getSetting('schedule', {});
  return {
    sync:   s.sync   || { hour: 8, minute: 5 },
    digest: s.daily  || { enabled: true, hour: 9, minute: 0 },
    checks: s.checks || { enabled: true, hours: [10, 13, 16, 19] },
  };
}

module.exports = { dailyJob, criticalJob, digestJob, isRunning, scheduleConfig };
