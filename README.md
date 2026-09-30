# Paid Media Ads Monitor · Docta Nexus

Control de presupuestos y alertas de **todas** las cuentas de Meta Ads y Google Ads de la agencia.
Evolución de Meta Budget Monitor (v2 → v3). Etapa 1: lectura, análisis y alertas.

## Qué hace

- **Cuentas cargadas a mano**: elegís plataforma, pegás el ID y la asignás a un cliente. No importa nada automáticamente; solo se leen las cuentas que cargás. Al agregarla, la app verifica el acceso y trae el nombre y el estado.
- **Presupuesto por cliente**: por plataforma (Meta / Google), total combinado, o ambos.
- **Pacing con fechas en hora argentina**: gasto hasta ayer vs días transcurridos, proyección a fin de mes, fecha en que se agota y cuánto invertir por día para llegar.
- **Alertas** deduplicadas (una abierta por problema; se resuelven solas cuando el problema desaparece):

| Alerta | Nivel |
|---|---|
| Cuenta deshabilitada / problema de pago | Crítico |
| Presupuesto agotado | Crítico |
| Sin gasto ayer con campañas activas | Crítico |
| Desvío de ritmo > 20 pp (sobre o bajo) | Crítico |
| Desvío de ritmo > 10 pp | Atención |
| Sin gasto hoy (desde las 14 hs) | Atención |
| Anuncios rechazados | Atención |
| No se pudo leer la cuenta | Atención |
| CPA/CPL 30% sobre objetivo · ROAS 30% bajo objetivo | Atención |
| Sin conversiones en 7 días · caída de conversiones > 40% | Atención |
| Frecuencia > 4 · CPM +60% semana contra semana (Meta) | Atención |
| Campañas que pierden impresiones por presupuesto (Google) | Info |

- **Avisos**: Slack al instante (atención y crítico) y mail con resumen diario (todo). Cada alerta se avisa una sola vez; si sube de gravedad, se vuelve a avisar. Horario de silencio configurable.
- **Insight IA** por cliente, generado una vez por día (no en cada carga del panel).

## Horarios (hora argentina, configurables desde Avisos)

| Hora | Tarea |
|---|---|
| 08:05 | Sincronización completa + alertas + IA + avisos de Slack |
| 09:00 | Resumen diario por mail |
| 10:30, 13:30, 16:30, 19:30 | Chequeo de urgencias (cuenta caída, sin gasto hoy, presupuesto agotado) |

## Puesta en marcha

1. **Supabase**: correr `schema.sql` completo en el SQL Editor de un proyecto nuevo.
2. **Render**: Build `npm install` · Start `node server.js` · Health check `/health`. Cargar las variables de `.env.example`.
3. **Clientes y presupuestos** → crear el cliente y cargar el presupuesto del mes.
4. **Cuentas** → "+ Agregar cuenta": plataforma, ID y cliente. Se empieza a monitorear y carga 35 días de historia.
   - Meta: `act_123456789` o solo el número.
   - Google Ads: `123-456-7890` (con o sin guiones).
5. **Avisos** → agregar el webhook de Slack y los mails del resumen. Usar "Probar" en cada canal.
6. **Actividad** → "Sincronizar todo" para no esperar al día siguiente.

### Requisitos de acceso

- **Meta**: el System User tiene que tener asignada cada cuenta que cargues (Configuración del negocio → Usuarios del sistema → Asignar activos), con permiso `ads_read`.
- **Google**: el usuario del refresh token tiene que tener acceso a cada cuenta (directo o vía MCC; si es vía MCC, cargá `GOOGLE_ADS_MCC_ID`).
- Si cargás una cuenta sin acceso, queda guardada con el error visible y se reintenta en cada sincronización.

## Estructura

```
server.js            API + panel + tareas programadas
lib/meta.js          Conector Meta Ads (datos de cuenta, métricas, campañas, estado)
lib/google.js        Conector Google Ads (ídem, vía GAQL)
lib/sync.js          Sincronización a Supabase
lib/engine.js        Pacing, rendimiento y reglas de alertas
lib/notify.js        Slack + mail (Resend)
lib/forecast.js      Insight IA diario (Claude)
lib/jobs.js          Orquestación de tareas
templates/email.js   Mails
public/index.html    Panel
schema.sql           Esquema de Supabase
test/run.js          Prueba de punta a punta con APIs simuladas
```

## Etapa 2 (pendiente)

Ya está preparado en la base (`recommendations`, `change_log`, `clients.automation_level`): motor de recomendaciones, bandeja de aprobación, ajustes automáticos con límites y deshacer. Requiere permiso `ads_management` en Meta y developer token con acceso de escritura en Google.
