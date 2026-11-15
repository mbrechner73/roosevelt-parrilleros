// Parrilleros Roosevelt Center — servidor
// Node 22.5+ (usa SQLite incorporado). Única dependencia: express.
'use strict';
const express = require('express');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

// ---------- configuración ----------
loadEnv(path.join(__dirname, '.env'));
const CFG = {
  port: +(process.env.PORT || 3000),
  baseUrl: (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, ''),
  dbFile: process.env.DB_FILE || path.join(__dirname, 'data', 'parrilleros.db'),
  mpToken: process.env.MP_ACCESS_TOKEN || '',            // vacío = modo demostración (sin cobro real)
  sena: +(process.env.SENA || 500),
  horasCancelacion: +(process.env.HORAS_CANCELACION || 24),
  minutosRetencion: +(process.env.MINUTOS_RETENCION || 15), // cuánto se guarda el lugar mientras se paga
  maxActivasPorApto: +(process.env.MAX_RESERVAS_ACTIVAS_POR_APTO || 2),
  diasAdelante: +(process.env.DIAS_ADELANTE || 45),
  adminEmail: (process.env.ADMIN_EMAIL || '').toLowerCase().trim(),
  adminPassword: process.env.ADMIN_PASSWORD || '',
  // envío de mails (opcional): Resend o Brevo. Sin ninguno, los pedidos de recuperación van al panel de administración.
  resendKey: process.env.RESEND_API_KEY || '',
  brevoKey: process.env.BREVO_API_KEY || '',
  mailFrom: process.env.MAIL_FROM || '',            // ej.: Parrilleros Roosevelt <parrilleros@tudominio.uy>
};
const DEMO = !CFG.mpToken;
const TORRES = ['A', 'B'], PISOS = 22, APTOS = 4, PARRILLEROS = [1, 2, 3, 4];
const TURNOS = { mediodia: { n: 'Mediodía', h: '12:00 a 17:00', start: 12 }, noche: { n: 'Noche', h: '20:00 a 01:00', start: 20 } };

function loadEnv(f) {
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// ---------- base de datos ----------
fs.mkdirSync(path.dirname(CFG.dbFile), { recursive: true });
const db = new DatabaseSync(CFG.dbFile);
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS usuarios(
  id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, nombre TEXT NOT NULL, celular TEXT DEFAULT '',
  torre TEXT, piso INTEGER, apto INTEGER, rol TEXT NOT NULL DEFAULT 'vecino',
  estado TEXT NOT NULL DEFAULT 'pendiente', pass TEXT, token TEXT, token_expira INTEGER,
  creado TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS sesiones(token TEXT PRIMARY KEY, usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE, expira INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS reservas(
  id INTEGER PRIMARY KEY, fecha TEXT NOT NULL, turno TEXT NOT NULL, parrillero INTEGER NOT NULL,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id), apto TEXT NOT NULL,
  estado TEXT NOT NULL, monto INTEGER NOT NULL, expira INTEGER,
  mp_preferencia TEXT, mp_pago TEXT, reembolso TEXT DEFAULT '',
  creada TEXT NOT NULL DEFAULT (datetime('now')), cancelada TEXT, cancelada_por TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS un_lugar ON reservas(fecha, turno, parrillero) WHERE estado IN ('pendiente_pago','pagada');
`);
if (!db.prepare('PRAGMA table_info(usuarios)').all().some((c) => c.name === 'recupero_pedido')) db.exec('ALTER TABLE usuarios ADD COLUMN recupero_pedido TEXT');
const q = (sql) => db.prepare(sql);

// ---------- utilidades ----------
const now = () => Date.now();
const rnd = (n = 32) => crypto.randomBytes(n).toString('base64url');
const hashPass = (p) => { const s = crypto.randomBytes(16).toString('hex'); return s + ':' + crypto.scryptSync(p, s, 64).toString('hex'); };
const checkPass = (p, h) => { if (!h) return false; const [s, k] = h.split(':'); const a = Buffer.from(k, 'hex'), b = crypto.scryptSync(p, s, 64); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const aptLabel = (t, p, u) => `${t}-${p * 100 + u}`;
// Uruguay: UTC-3 todo el año (sin horario de verano desde 2015)
const inicioTurno = (fecha, turno) => new Date(`${fecha}T${String(TURNOS[turno].start).padStart(2, '0')}:00:00-03:00`).getTime();
const hoyUY = () => new Date(now() - 3 * 3600e3).toISOString().slice(0, 10);
const sumDias = (f, n) => { const d = new Date(f + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const gratis = (r) => inicioTurno(r.fecha, r.turno) - now() >= CFG.horasCancelacion * 3600e3;
const okEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
function okApto(t, p, u) { return TORRES.includes(t) && Number.isInteger(p) && p >= 1 && p <= PISOS && Number.isInteger(u) && u >= 1 && u <= APTOS; }
class Err extends Error { constructor(code, msg) { super(msg); this.code = code; } }

function expirarPendientes() {
  q(`UPDATE reservas SET estado='expirada' WHERE estado='pendiente_pago' AND expira < ?`).run(now());
}
function publicUser(u) {
  return u && { id: u.id, email: u.email, nombre: u.nombre, celular: u.celular, torre: u.torre, piso: u.piso, apto: u.apto,
    aptoLabel: u.torre ? aptLabel(u.torre, u.piso, u.apto) : '', rol: u.rol, estado: u.estado, creado: u.creado, invitado: !u.pass, recuperoPedido: u.recupero_pedido || null };
}

// administrador inicial
if (CFG.adminEmail && CFG.adminPassword) {
  const u = q('SELECT * FROM usuarios WHERE email=?').get(CFG.adminEmail);
  if (!u) q(`INSERT INTO usuarios(email,nombre,rol,estado,pass) VALUES(?,?, 'admin','activo',?)`).run(CFG.adminEmail, 'Administración', hashPass(CFG.adminPassword));
}

// ---------- Mercado Pago ----------
async function mp(method, url, body, idem) {
  const r = await fetch('https://api.mercadopago.com' + url, {
    method, headers: { Authorization: 'Bearer ' + CFG.mpToken, 'Content-Type': 'application/json', ...(idem ? { 'X-Idempotency-Key': idem } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Err(502, 'Mercado Pago: ' + (j.message || r.status));
  return j;
}
async function crearPreferencia(r, u) {
  const t = TURNOS[r.turno];
  return mp('POST', '/checkout/preferences', {
    items: [{ id: 'parrillero-' + r.parrillero, title: `Seña parrillero ${r.parrillero} · ${r.fecha} ${t.n}`, quantity: 1, currency_id: 'UYU', unit_price: r.monto }],
    payer: { email: u.email, name: u.nombre },
    external_reference: String(r.id),
    notification_url: CFG.baseUrl + '/api/mp/webhook',
    back_urls: { success: CFG.baseUrl + '/?pago=ok', failure: CFG.baseUrl + '/?pago=error', pending: CFG.baseUrl + '/?pago=pendiente' },
    auto_return: 'approved',
    expires: true,
    expiration_date_to: new Date(r.expira).toISOString(),
    binary_mode: true,
  });
}
async function reembolsar(r) {
  if (DEMO || !r.mp_pago) return 'reembolsado';
  try { await mp('POST', `/v1/payments/${r.mp_pago}/refunds`, {}, 'refund-' + r.id); return 'reembolsado'; }
  catch (e) { console.error('Reembolso falló', r.id, e.message); return 'error'; }
}
// Aplica un pago aprobado (llega por webhook o al volver del checkout)
async function aplicarPago(paymentId) {
  const p = await mp('GET', '/v1/payments/' + encodeURIComponent(paymentId));
  const id = +p.external_reference;
  const r = q('SELECT * FROM reservas WHERE id=?').get(id);
  if (!r) return null;
  if (p.status !== 'approved') return r;
  if (r.estado === 'pagada') return r;
  if (+p.transaction_amount < r.monto) return r;
  try {
    q(`UPDATE reservas SET estado='pagada', mp_pago=?, expira=NULL WHERE id=?`).run(String(p.id), id);
  } catch {
    // el lugar lo tomó otra persona mientras esta pagaba (retención vencida): se devuelve el dinero
    q(`UPDATE reservas SET estado='cancelada', mp_pago=?, cancelada=datetime('now'), cancelada_por='sistema' WHERE id=?`).run(String(p.id), id);
    const rr = q('SELECT * FROM reservas WHERE id=?').get(id);
    q('UPDATE reservas SET reembolso=? WHERE id=?').run(await reembolsar(rr), id);
  }
  return q('SELECT * FROM reservas WHERE id=?').get(id);
}

// ---------- app ----------
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '20kb' }));
app.use((req, res, next) => { // cabeceras básicas de seguridad
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY' });
  next();
});
const cookieOpts = () => ({ httpOnly: true, sameSite: 'lax', secure: CFG.baseUrl.startsWith('https'), path: '/', maxAge: 30 * 864e5 });
function readCookie(req, name) { const m = (req.headers.cookie || '').match(new RegExp('(?:^|; )' + name + '=([^;]+)')); return m && decodeURIComponent(m[1]); }

app.use((req, res, next) => {
  const t = readCookie(req, 'sid');
  if (t) {
    const s = q('SELECT * FROM sesiones WHERE token=? AND expira>?').get(t, now());
    if (s) req.user = q('SELECT * FROM usuarios WHERE id=?').get(s.usuario_id);
  }
  next();
});
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  if (!(e instanceof Err)) console.error(e);
  res.status(e.code || 500).json({ error: e instanceof Err ? e.message : 'Error interno' });
});
const needUser = (req) => { if (!req.user) throw new Err(401, 'Iniciá sesión'); if (req.user.estado !== 'activo') throw new Err(403, 'Tu cuenta todavía no fue aprobada por la administración'); };
const needAdmin = (req) => { needUser(req); if (req.user.rol !== 'admin') throw new Err(403, 'Solo administración'); };
function login(res, u) { const t = rnd(); q('INSERT INTO sesiones VALUES(?,?,?)').run(t, u.id, now() + 30 * 864e5); res.cookie('sid', t, cookieOpts()); }

// freno simple a intentos repetidos de contraseña
const intentos = new Map();
function frenar(key) {
  const e = intentos.get(key) || { n: 0, t: now() };
  if (now() - e.t > 15 * 60e3) { e.n = 0; e.t = now(); }
  e.n++; intentos.set(key, e);
  if (e.n > 10) throw new Err(429, 'Demasiados intentos. Esperá 15 minutos.');
}

// --- configuración pública
app.get('/api/config', (req, res) => res.json({ sena: CFG.sena, horasCancelacion: CFG.horasCancelacion, diasAdelante: CFG.diasAdelante, turnos: TURNOS, demo: DEMO, hoy: hoyUY() }));

// --- cuentas
app.post('/api/registro', wrap(async (req, res) => {
  const { email = '', nombre = '', celular = '', torre, piso, apto, password = '' } = req.body || {};
  const e = String(email).toLowerCase().trim();
  if (!okEmail(e)) throw new Err(400, 'Email inválido');
  if (String(nombre).trim().length < 2) throw new Err(400, 'Falta el nombre');
  if (!okApto(torre, +piso, +apto)) throw new Err(400, 'Apartamento inválido');
  if (String(password).length < 8) throw new Err(400, 'La contraseña debe tener al menos 8 caracteres');
  if (q('SELECT 1 FROM usuarios WHERE email=?').get(e)) throw new Err(409, 'Ya hay una cuenta con ese email');
  const r = q(`INSERT INTO usuarios(email,nombre,celular,torre,piso,apto,estado,pass) VALUES(?,?,?,?,?,?,'pendiente',?)`)
    .run(e, String(nombre).trim(), String(celular).trim(), torre, +piso, +apto, hashPass(password));
  login(res, q('SELECT * FROM usuarios WHERE id=?').get(r.lastInsertRowid));
  res.json({ ok: true });
}));
app.post('/api/login', wrap(async (req, res) => {
  const e = String(req.body?.email || '').toLowerCase().trim();
  frenar(req.ip + e);
  const u = q('SELECT * FROM usuarios WHERE email=?').get(e);
  if (!u || !checkPass(String(req.body?.password || ''), u.pass)) throw new Err(401, 'Email o contraseña incorrectos');
  if (u.estado === 'rechazado' || u.estado === 'baja') throw new Err(403, 'Esta cuenta no está habilitada. Consultá con la administración.');
  intentos.delete(req.ip + e);
  login(res, u); res.json({ ok: true });
}));
app.post('/api/logout', (req, res) => { const t = readCookie(req, 'sid'); if (t) q('DELETE FROM sesiones WHERE token=?').run(t); res.clearCookie('sid', { path: '/' }); res.json({ ok: true }); });
app.get('/api/yo', (req, res) => res.json({ usuario: publicUser(req.user) || null }));
// ---------- recuperación de contraseña ----------
const MAIL_ON = !!((CFG.resendKey || CFG.brevoKey) && CFG.mailFrom);
async function enviarMail(to, nombre, asunto, html) {
  if (CFG.resendKey) {
    const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + CFG.resendKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: CFG.mailFrom, to: [to], subject: asunto, html }) });
    if (!r.ok) throw new Error('Resend ' + r.status + ' ' + (await r.text()));
  } else {
    const m = CFG.mailFrom.match(/^(.*)<(.+)>$/), from = m ? { name: m[1].trim(), email: m[2].trim() } : { email: CFG.mailFrom };
    const r = await fetch('https://api.brevo.com/v3/smtp/email', { method: 'POST', headers: { 'api-key': CFG.brevoKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sender: from, to: [{ email: to, name: nombre }], subject: asunto, htmlContent: html }) });
    if (!r.ok) throw new Error('Brevo ' + r.status + ' ' + (await r.text()));
  }
}
const escHtml = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
app.get('/api/recuperar', (req, res) => res.json({ porMail: MAIL_ON }));
app.post('/api/recuperar', wrap(async (req, res) => {
  const e = String(req.body?.email || '').toLowerCase().trim();
  frenar('rec:' + req.ip);
  const u = okEmail(e) && q('SELECT * FROM usuarios WHERE email=?').get(e);
  // la respuesta es siempre la misma, exista o no la cuenta
  const resp = { ok: true, porMail: MAIL_ON };
  if (!u || u.estado === 'rechazado' || u.estado === 'baja') return res.json(resp);
  if (MAIL_ON) {
    const tok = rnd(24);
    q('UPDATE usuarios SET token=?, token_expira=? WHERE id=?').run(tok, now() + 3600e3, u.id);
    const link = CFG.baseUrl + '/activar.html#' + tok;
    try {
      await enviarMail(u.email, u.nombre, 'Recuperar tu contraseña · Parrilleros Roosevelt Center',
        `<p>Hola ${escHtml(u.nombre)},</p><p>Para crear una contraseña nueva entrá a este enlace (vale por 1 hora):</p><p><a href="${link}">${link}</a></p><p>Si no lo pediste, ignorá este mail.</p>`);
      return res.json(resp);
    } catch (err) { console.error('Mail falló', err.message); }
  }
  // sin mail (o si el envío falló) el pedido queda en el panel de administración
  q("UPDATE usuarios SET recupero_pedido=datetime('now','-3 hours') WHERE id=?").run(u.id);
  res.json(resp);
}));

// activar cuenta / cambiar contraseña con el enlace que genera la administración
app.get('/api/enlace/:token', wrap(async (req, res) => {
  const u = q('SELECT * FROM usuarios WHERE token=? AND token_expira>?').get(req.params.token, now());
  if (!u) throw new Err(404, 'El enlace venció o ya fue usado. Pedí uno nuevo a la administración.');
  res.json({ nombre: u.nombre, email: u.email, aptoLabel: u.torre ? aptLabel(u.torre, u.piso, u.apto) : '' });
}));
app.post('/api/enlace/:token', wrap(async (req, res) => {
  const u = q('SELECT * FROM usuarios WHERE token=? AND token_expira>?').get(req.params.token, now());
  if (!u) throw new Err(404, 'El enlace venció o ya fue usado. Pedí uno nuevo a la administración.');
  const p = String(req.body?.password || '');
  if (p.length < 8) throw new Err(400, 'La contraseña debe tener al menos 8 caracteres');
  q(`UPDATE usuarios SET pass=?, token=NULL, token_expira=NULL, recupero_pedido=NULL WHERE id=?`).run(hashPass(p), u.id);
  q('DELETE FROM sesiones WHERE usuario_id=?').run(u.id);
  login(res, q('SELECT * FROM usuarios WHERE id=?').get(u.id));
  res.json({ ok: true });
}));

// --- disponibilidad (solo se muestra el apartamento, no el nombre)
app.get('/api/disponibilidad', wrap(async (req, res) => {
  needUser(req); expirarPendientes();
  const desde = hoyUY(), hasta = sumDias(desde, CFG.diasAdelante);
  const rows = q(`SELECT fecha,turno,parrillero,apto,estado FROM reservas WHERE fecha BETWEEN ? AND ? AND estado IN ('pendiente_pago','pagada')`).all(desde, hasta);
  res.json({ ocupados: rows });
}));

// --- reservas del apartamento (todas las cuentas del mismo apto las comparten)
const aptoDe = (u) => (u.torre ? aptLabel(u.torre, u.piso, u.apto) : null);
app.get('/api/mis-reservas', wrap(async (req, res) => {
  needUser(req); expirarPendientes();
  const rows = q(`SELECT r.*, u.nombre AS reservo FROM reservas r JOIN usuarios u ON u.id=r.usuario_id
    WHERE (r.apto=? OR r.usuario_id=?) AND r.fecha>=? AND r.estado IN ('pagada','cancelada','pendiente_pago') ORDER BY r.fecha, r.turno`)
    .all(aptoDe(req.user), req.user.id, sumDias(hoyUY(), -1));
  res.json({ reservas: rows.map((r) => ({ id: r.id, fecha: r.fecha, turno: r.turno, parrillero: r.parrillero, apto: r.apto, estado: r.estado, monto: r.monto,
    reembolso: r.reembolso, propia: r.usuario_id === req.user.id, reservo: r.reservo, gratis: gratis(r), inicio: inicioTurno(r.fecha, r.turno) })) });
}));

// --- nueva reserva: retiene el lugar y devuelve el enlace de pago
app.post('/api/reservas', wrap(async (req, res) => {
  needUser(req);
  const u = req.user;
  if (!u.torre) throw new Err(400, 'Tu usuario no tiene apartamento asignado');
  const { fecha, turno } = req.body || {}, parrillero = +req.body?.parrillero;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha || '') || !TURNOS[turno] || !PARRILLEROS.includes(parrillero)) throw new Err(400, 'Datos de reserva inválidos');
  if (inicioTurno(fecha, turno) <= now()) throw new Err(400, 'Ese turno ya empezó');
  if (fecha > sumDias(hoyUY(), CFG.diasAdelante)) throw new Err(400, `Se puede reservar hasta ${CFG.diasAdelante} días adelante`);
  expirarPendientes();
  const label = aptLabel(u.torre, u.piso, u.apto);
  const activas = q(`SELECT COUNT(*) n FROM reservas WHERE apto=? AND estado IN ('pagada','pendiente_pago') AND fecha>=?`).get(label, hoyUY()).n;
  if (activas >= CFG.maxActivasPorApto) throw new Err(409, `Tu apartamento ya tiene ${activas} reservas activas (máximo ${CFG.maxActivasPorApto})`);
  let id;
  try {
    id = q(`INSERT INTO reservas(fecha,turno,parrillero,usuario_id,apto,estado,monto,expira) VALUES(?,?,?,?,?,'pendiente_pago',?,?)`)
      .run(fecha, turno, parrillero, u.id, label, CFG.sena, now() + CFG.minutosRetencion * 60e3).lastInsertRowid;
  } catch { throw new Err(409, 'Ese parrillero ya está reservado en ese turno'); }
  const r = q('SELECT * FROM reservas WHERE id=?').get(id);
  if (DEMO) return res.json({ id, pagoUrl: '/pago-demo.html?r=' + id });
  try {
    const pref = await crearPreferencia(r, u);
    q('UPDATE reservas SET mp_preferencia=? WHERE id=?').run(pref.id, id);
    res.json({ id, pagoUrl: pref.init_point });
  } catch (e) { q(`UPDATE reservas SET estado='expirada' WHERE id=?`).run(id); throw e; }
}));

// pago en modo demostración (solo existe sin MP_ACCESS_TOKEN)
app.post('/api/pago-demo/:id', wrap(async (req, res) => {
  if (!DEMO) throw new Err(404, 'No disponible');
  needUser(req);
  const r = q(`SELECT * FROM reservas WHERE id=? AND usuario_id=?`).get(+req.params.id, req.user.id);
  if (!r) throw new Err(404, 'Reserva no encontrada');
  if (req.body?.aprobar) {
    if (r.estado !== 'pendiente_pago' || r.expira < now()) throw new Err(409, 'La retención venció. Volvé a reservar.');
    q(`UPDATE reservas SET estado='pagada', mp_pago=?, expira=NULL WHERE id=?`).run('DEMO-' + rnd(6), r.id);
  } else if (r.estado === 'pendiente_pago') q(`UPDATE reservas SET estado='expirada' WHERE id=?`).run(r.id);
  res.json({ ok: true });
}));
app.get('/api/pago-demo/:id', wrap(async (req, res) => {
  if (!DEMO) throw new Err(404, 'No disponible');
  needUser(req);
  const r = q(`SELECT * FROM reservas WHERE id=? AND usuario_id=?`).get(+req.params.id, req.user.id);
  if (!r) throw new Err(404, 'Reserva no encontrada');
  res.json({ reserva: r, turno: TURNOS[r.turno] });
}));

// Mercado Pago: aviso de pago (webhook) y confirmación al volver del checkout
app.post('/api/mp/webhook', wrap(async (req, res) => {
  const id = req.body?.data?.id || req.query['data.id'] || (req.query.topic === 'payment' && req.query.id);
  const tipo = req.body?.type || req.query.type || req.query.topic;
  if (!DEMO && id && tipo === 'payment') await aplicarPago(id).catch((e) => console.error('webhook', e.message));
  res.sendStatus(200);
}));
app.post('/api/mp/confirmar', wrap(async (req, res) => {
  needUser(req);
  if (DEMO || !req.body?.payment_id) return res.json({ ok: true });
  const r = await aplicarPago(String(req.body.payment_id));
  res.json({ estado: r?.usuario_id === req.user.id ? r.estado : null });
}));

// --- cancelar (vecino)
app.post('/api/reservas/:id/cancelar', wrap(async (req, res) => {
  needUser(req);
  const r = q('SELECT * FROM reservas WHERE id=? AND (usuario_id=? OR apto=?)').get(+req.params.id, req.user.id, aptoDe(req.user));
  if (!r) throw new Err(404, 'Reserva no encontrada');
  if (r.estado === 'pendiente_pago') { q(`UPDATE reservas SET estado='expirada' WHERE id=?`).run(r.id); return res.json({ reembolso: '' }); }
  if (r.estado !== 'pagada') throw new Err(409, 'La reserva ya no está activa');
  if (inicioTurno(r.fecha, r.turno) <= now()) throw new Err(409, 'El turno ya empezó');
  const devolver = gratis(r);
  q(`UPDATE reservas SET estado='cancelada', cancelada=datetime('now'), cancelada_por='vecino', reembolso=? WHERE id=?`).run(devolver ? 'en trámite' : 'no corresponde', r.id);
  const rb = devolver ? await reembolsar(r) : 'no corresponde';
  q('UPDATE reservas SET reembolso=? WHERE id=?').run(rb, r.id);
  res.json({ reembolso: rb });
}));

// ---------- administración ----------
app.get('/api/admin/usuarios', wrap(async (req, res) => {
  needAdmin(req);
  res.json({ usuarios: q('SELECT * FROM usuarios ORDER BY estado=\'pendiente\' DESC, torre, piso, apto, nombre').all().map(publicUser) });
}));
app.post('/api/admin/usuarios', wrap(async (req, res) => {
  needAdmin(req);
  const { email = '', nombre = '', celular = '', torre, piso, apto, rol = 'vecino' } = req.body || {};
  const e = String(email).toLowerCase().trim();
  if (!okEmail(e)) throw new Err(400, 'Email inválido');
  if (String(nombre).trim().length < 2) throw new Err(400, 'Falta el nombre');
  if (rol !== 'admin' && !okApto(torre, +piso, +apto)) throw new Err(400, 'Apartamento inválido');
  if (q('SELECT 1 FROM usuarios WHERE email=?').get(e)) throw new Err(409, 'Ya hay una cuenta con ese email');
  const tok = rnd(24);
  const r = q(`INSERT INTO usuarios(email,nombre,celular,torre,piso,apto,rol,estado,token,token_expira) VALUES(?,?,?,?,?,?,?,'activo',?,?)`)
    .run(e, String(nombre).trim(), String(celular).trim(), okApto(torre, +piso, +apto) ? torre : null, +piso || null, +apto || null, rol === 'admin' ? 'admin' : 'vecino', tok, now() + 14 * 864e5);
  res.json({ id: r.lastInsertRowid, enlace: CFG.baseUrl + '/activar.html#' + tok });
}));
app.post('/api/admin/usuarios/:id', wrap(async (req, res) => {
  needAdmin(req);
  const u = q('SELECT * FROM usuarios WHERE id=?').get(+req.params.id);
  if (!u) throw new Err(404, 'Usuario no encontrado');
  const { estado, torre, piso, apto, nombre, celular, rol } = req.body || {};
  if (u.id === req.user.id && (estado && estado !== 'activo' || rol && rol !== 'admin')) throw new Err(400, 'No podés quitarte tu propio acceso');
  if (estado && !['activo', 'rechazado', 'baja', 'pendiente'].includes(estado)) throw new Err(400, 'Estado inválido');
  if (torre !== undefined && !okApto(torre, +piso, +apto)) throw new Err(400, 'Apartamento inválido');
  q(`UPDATE usuarios SET estado=COALESCE(?,estado), torre=COALESCE(?,torre), piso=COALESCE(?,piso), apto=COALESCE(?,apto),
     nombre=COALESCE(?,nombre), celular=COALESCE(?,celular), rol=COALESCE(?,rol) WHERE id=?`)
    .run(estado ?? null, torre ?? null, torre ? +piso : null, torre ? +apto : null, nombre ?? null, celular ?? null,
      rol === 'admin' || rol === 'vecino' ? rol : null, u.id);
  if (estado && estado !== 'activo') q('DELETE FROM sesiones WHERE usuario_id=?').run(u.id);
  res.json({ usuario: publicUser(q('SELECT * FROM usuarios WHERE id=?').get(u.id)) });
}));
app.post('/api/admin/usuarios/:id/enlace', wrap(async (req, res) => {
  needAdmin(req);
  const tok = rnd(24);
  const r = q('UPDATE usuarios SET token=?, token_expira=? WHERE id=?').run(tok, now() + 14 * 864e5, +req.params.id);
  if (!r.changes) throw new Err(404, 'Usuario no encontrado');
  res.json({ enlace: CFG.baseUrl + '/activar.html#' + tok });
}));
app.get('/api/admin/reservas', wrap(async (req, res) => {
  needAdmin(req); expirarPendientes();
  const desde = req.query.desde || sumDias(hoyUY(), -30);
  const rows = q(`SELECT r.*, u.nombre, u.celular, u.email FROM reservas r JOIN usuarios u ON u.id=r.usuario_id
    WHERE r.fecha>=? AND r.estado IN ('pagada','cancelada','pendiente_pago') ORDER BY r.fecha, r.turno, r.parrillero`).all(desde);
  res.json({ reservas: rows.map((r) => ({ ...r, gratis: gratis(r) })) });
}));
app.post('/api/admin/reservas/:id/cancelar', wrap(async (req, res) => {
  needAdmin(req);
  const r = q('SELECT * FROM reservas WHERE id=?').get(+req.params.id);
  if (!r) throw new Err(404, 'Reserva no encontrada');
  const devolver = !!req.body?.reembolsar;
  if (r.estado === 'pagada') {
    q(`UPDATE reservas SET estado='cancelada', cancelada=datetime('now'), cancelada_por='administración', reembolso=? WHERE id=?`).run(devolver ? 'en trámite' : 'no corresponde', r.id);
  } else if (!(r.estado === 'cancelada' && r.reembolso === 'error')) throw new Err(409, 'Solo se cancelan reservas pagadas (o se reintenta un reembolso fallido)');
  const rb = devolver ? await reembolsar(r) : 'no corresponde';
  q('UPDATE reservas SET reembolso=? WHERE id=?').run(rb, r.id);
  res.json({ reembolso: rb });
}));

// archivos públicos (solo estos; el resto de la carpeta no se sirve)
const PUBLICOS = ['index.html', 'admin.html', 'activar.html', 'pago-demo.html', 'app.css', 'edificio.js'];
const DIR_PUB = fs.existsSync(path.join(__dirname, 'public')) ? path.join(__dirname, 'public') : __dirname;
app.get(['/', '/:f'], (req, res, next) => {
  let f = req.params.f || 'index.html';
  if (!f.includes('.')) f += '.html';
  if (!PUBLICOS.includes(f)) return next();
  res.sendFile(path.join(DIR_PUB, f));
});
app.listen(CFG.port, () => console.log(`Parrilleros en ${CFG.baseUrl} (puerto ${CFG.port})${DEMO ? ' — MODO DEMOSTRACIÓN: los pagos no son reales' : ''}`));
