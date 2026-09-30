-- ════════════════════════════════════════════════════════════════
-- Paid Media Ads Monitor · Docta Nexus
-- Esquema inicial (Etapa 1 + tablas listas para Etapa 2)
-- Correr completo en: Supabase → SQL Editor → New query → Run
-- ════════════════════════════════════════════════════════════════

-- ── Utilidad: updated_at automático ─────────────────────────────
create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

-- ── Clientes ────────────────────────────────────────────────────
create table clients (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  slug             text unique not null,
  client_type      text not null default 'general'
                   check (client_type in ('general','ecommerce','leads')),
  currency         text not null default 'ARS',
  active           boolean not null default true,
  notes            text default '',
  -- Objetivos (null = sin objetivo)
  target_cpa       numeric,
  target_cpl       numeric,
  target_roas      numeric,
  target_leads     integer,
  target_revenue   numeric,
  -- Etapa 2: nivel de autonomía de los ajustes
  automation_level text not null default 'off'
                   check (automation_level in ('off','propose','auto_low_risk')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create trigger trg_clients_updated before update on clients
  for each row execute function set_updated_at();

-- ── Cuentas publicitarias (se importan solas desde BM / MCC) ─────
-- client_id null = cuenta descubierta todavía sin asignar a un cliente
create table ad_accounts (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid references clients(id) on delete set null,
  platform        text not null check (platform in ('meta','google_ads','tiktok')),
  external_id     text not null,           -- act_123... / 1234567890
  name            text,
  currency        text,
  timezone        text,
  status          text,                    -- ACTIVE, DISABLED, UNSETTLED, etc.
  status_detail   jsonb default '{}'::jsonb, -- disable_reason, billing, etc.
  monitored       boolean not null default false,
  last_synced_at  timestamptz,
  last_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (platform, external_id)
);
create index on ad_accounts (client_id);
create trigger trg_ad_accounts_updated before update on ad_accounts
  for each row execute function set_updated_at();

-- ── Presupuestos mensuales ──────────────────────────────────────
-- platform null = presupuesto TOTAL combinado del cliente.
-- Se puede cargar total, por plataforma, o ambos.
create table budgets (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references clients(id) on delete cascade,
  platform    text check (platform in ('meta','google_ads','tiktok')),
  month       date not null,               -- siempre día 1: 2026-10-01
  amount      numeric not null check (amount >= 0),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint budgets_month_first_day check (extract(day from month) = 1),
  constraint budgets_unique unique nulls not distinct (client_id, platform, month)
);
create trigger trg_budgets_updated before update on budgets
  for each row execute function set_updated_at();

-- ── Campañas (estado actual, para alertas y ajustes) ────────────
create table campaigns (
  id                uuid primary key default gen_random_uuid(),
  account_id        uuid not null references ad_accounts(id) on delete cascade,
  external_id       text not null,
  name              text,
  status            text,
  objective         text,
  daily_budget      numeric,
  lifetime_budget   numeric,
  bidding_strategy  text,
  target_cpa        numeric,
  target_roas       numeric,
  learning_status   text,                  -- LEARNING / LEARNING_LIMITED / etc.
  extra             jsonb default '{}'::jsonb,
  updated_at        timestamptz not null default now(),
  unique (account_id, external_id)
);
create trigger trg_campaigns_updated before update on campaigns
  for each row execute function set_updated_at();

-- ── Métricas diarias (foto que guarda el cron cada madrugada) ────
-- level 'account' → entity_id = external_id de la cuenta
create table metrics_daily (
  account_id    uuid not null references ad_accounts(id) on delete cascade,
  date          date not null,
  level         text not null check (level in ('account','campaign')),
  entity_id     text not null,
  entity_name   text,
  spend         numeric not null default 0,
  impressions   bigint  not null default 0,
  clicks        bigint  not null default 0,
  reach         bigint,
  frequency     numeric,
  conversions   numeric not null default 0,
  conv_value    numeric not null default 0,
  leads         numeric not null default 0,
  purchases     numeric not null default 0,
  extra         jsonb default '{}'::jsonb,  -- impression share, etc.
  synced_at     timestamptz not null default now(),
  primary key (account_id, date, level, entity_id)
);
create index on metrics_daily (date);

-- ── Insights / forecast IA (1 por cliente por día, cacheado) ─────
create table ai_insights (
  client_id   uuid not null references clients(id) on delete cascade,
  date        date not null,
  forecast    jsonb not null,
  model       text,
  created_at  timestamptz not null default now(),
  primary key (client_id, date)
);

-- ── Alertas (deduplicadas: una abierta por fingerprint) ──────────
create table alerts (
  id             uuid primary key default gen_random_uuid(),
  client_id      uuid references clients(id) on delete cascade,
  account_id     uuid references ad_accounts(id) on delete cascade,
  rule_key       text not null,            -- 'pacing_over', 'zero_spend', ...
  severity       text not null check (severity in ('info','warning','critical')),
  message        text not null,
  data           jsonb default '{}'::jsonb,
  fingerprint    text not null,            -- rule_key + cuenta/entidad
  status         text not null default 'open'
                 check (status in ('open','resolved','snoozed')),
  snoozed_until  timestamptz,
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  resolved_at    timestamptz,
  notified_at    timestamptz
);
create unique index alerts_one_open_per_fingerprint
  on alerts (fingerprint) where status in ('open','snoozed');
create index on alerts (client_id, status);

-- ── Canales de aviso (email / slack / whatsapp) ─────────────────
-- client_id null = canal de la agencia (recibe de todos los clientes)
create table notification_channels (
  id            uuid primary key default gen_random_uuid(),
  type          text not null check (type in ('email','slack','whatsapp')),
  label         text,                      -- "Slack #alertas-paid", "WA Juan"
  target        text not null,             -- email / webhook URL / +549...
  client_id     uuid references clients(id) on delete cascade,
  min_severity  text not null default 'warning'
                check (min_severity in ('info','warning','critical')),
  mode          text not null default 'digest'
                check (mode in ('instant','digest')),
  quiet_hours   boolean not null default true,  -- sin avisos 22 a 8 hs
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

create table notification_log (
  id          uuid primary key default gen_random_uuid(),
  channel_id  uuid references notification_channels(id) on delete set null,
  alert_ids   uuid[] default '{}',
  kind        text,                        -- 'instant' | 'digest' | 'report'
  ok          boolean not null,
  error       text,
  sent_at     timestamptz not null default now()
);

-- ── Etapa 2: recomendaciones y registro de cambios ──────────────
create table recommendations (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references clients(id) on delete cascade,
  account_id   uuid not null references ad_accounts(id) on delete cascade,
  type         text not null,              -- 'budget_shift','pause_keyword','add_negative',...
  entity_type  text,                       -- campaign / adset / keyword / search_term
  entity_id    text,
  payload      jsonb not null,             -- qué cambiar exactamente
  reason       text not null,              -- por qué (visible en la bandeja)
  risk         text not null default 'medium' check (risk in ('low','medium','high')),
  status       text not null default 'proposed'
               check (status in ('proposed','approved','rejected','applied','failed','reverted','expired')),
  created_at   timestamptz not null default now(),
  decided_at   timestamptz,
  decided_by   text,
  applied_at   timestamptz,
  result       jsonb
);
create index on recommendations (status, client_id);

create table change_log (
  id                 uuid primary key default gen_random_uuid(),
  recommendation_id  uuid references recommendations(id) on delete set null,
  account_id         uuid references ad_accounts(id) on delete set null,
  entity_type        text,
  entity_id          text,
  before             jsonb,
  after              jsonb,
  applied_by         text not null default 'system',
  applied_at         timestamptz not null default now(),
  reverted_at        timestamptz
);

-- ── Corridas del cron (para saber si algo falló de madrugada) ────
create table sync_runs (
  id           uuid primary key default gen_random_uuid(),
  job          text not null,              -- 'daily_sync','alerts','report',...
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  status       text not null default 'running' check (status in ('running','ok','partial','error')),
  summary      jsonb default '{}'::jsonb
);

-- ── Configuración global ────────────────────────────────────────
create table settings (
  key    text primary key,
  value  jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
insert into settings (key, value) values
  ('schedule', '{"daily":{"enabled":true,"hour":9,"minute":0}}'),
  ('alerts',   '{"pacing_warning_pp":10,"pacing_critical_pp":20,"quiet_start":22,"quiet_end":8}');

-- ── Seguridad: RLS activado sin políticas ───────────────────────
-- Solo el backend (service_role) puede leer/escribir. Nada expuesto
-- con la anon key.
alter table clients               enable row level security;
alter table ad_accounts           enable row level security;
alter table budgets               enable row level security;
alter table campaigns             enable row level security;
alter table metrics_daily         enable row level security;
alter table ai_insights           enable row level security;
alter table alerts                enable row level security;
alter table notification_channels enable row level security;
alter table notification_log      enable row level security;
alter table recommendations       enable row level security;
alter table change_log            enable row level security;
alter table sync_runs             enable row level security;
alter table settings              enable row level security;
