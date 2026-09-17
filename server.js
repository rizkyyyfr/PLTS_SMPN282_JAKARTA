require('dotenv').config();

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const mysql = require('mysql2/promise');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const TARIFFS_FILE = path.join(DATA_DIR, 'tariffs.json');
const DEFAULT_TARIFF = { effectiveDate: '2026-01-01', rate: 1699.53, category: 'P-1/TR', source: 'Tarif aktif aplikasi' };
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const APP_USERNAME = process.env.APP_USERNAME || 'admin';
const APP_PASSWORD = process.env.APP_PASSWORD || 'admin123';
const POWER_UNIT = (process.env.POWER_UNIT || 'kw').toLowerCase();
const sessions = new Map();
const loginAttempts = new Map();
let databaseTotalCache = null;

// --- Koneksi MySQL (database sensor asli, terisi oleh script Python di Raspi) ---
// Atur lewat environment variable saat menjalankan server, contoh:
//   DB_USER=rms_reader DB_PASSWORD=rahasia node server.js
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'db_rms',
  waitForConnections: true,
  connectionLimit: 5,
  dateStrings: true,
});

function readJson(file, fallback) { try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback; } catch { return fallback; } }
function writeJson(file, value) { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2)); }
function dateKey(date = new Date()) {
  // Semua timestamp sensor disimpan sebagai WIB, jadi jangan memakai UTC date
  // langsung (00:00–06:59 WIB masih berada di tanggal UTC sebelumnya).
  const wib = new Date(date.getTime() + 7 * 60 * 60 * 1000);
  return wib.toISOString().slice(0, 10);
}
function tariffs() { return readJson(TARIFFS_FILE, [DEFAULT_TARIFF]).sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate)); }
function tariffFor(date) { return tariffs().filter((item) => item.effectiveDate <= date).at(-1) || tariffs()[0]; }

function toIso(mysqlTimestamp) {
  // mysqlTimestamp berformat "2026-08-27 12:15:04" (WIB, UTC+7)
  return mysqlTimestamp.replace(' ', 'T') + '+07:00';
}

// Cari pembacaan suhu terdekat untuk sebuah waktu power meter (toleransi 6 menit,
// karena kwh_log & temp_log dicatat oleh proses terpisah tiap ~5 menit)
function nearestTemperature(tempRows, targetMs, toleranceMs = 6 * 60 * 1000) {
  let closest = null;
  let closestDiff = Infinity;
  for (const row of tempRows) {
    const diff = Math.abs(row.ms - targetMs);
    if (diff < closestDiff) { closestDiff = diff; closest = row; }
  }
  return closest && closestDiff <= toleranceMs ? closest.temperature : null;
}

async function readingsFor(date) {
  const [kwhRows] = await pool.query(
    `SELECT timestamp, kwh_v AS voltage, kwh_i AS current, kwh_p AS power, kwh_eexp AS cumExport
     FROM kwh_log WHERE DATE(timestamp) = ? ORDER BY timestamp ASC`,
    [date],
  );
  const [tempRowsRaw] = await pool.query(
    `SELECT timestamp, module_temp AS temperature FROM temp_log WHERE DATE(timestamp) = ? ORDER BY timestamp ASC`,
    [date],
  );
  const [previousRows] = await pool.query(
    `SELECT kwh_eexp AS cumExport FROM kwh_log WHERE timestamp < ? ORDER BY timestamp DESC LIMIT 1`,
    [`${date} 00:00:00`],
  );
  const tempRows = tempRowsRaw.map((row) => ({ ms: new Date(toIso(row.timestamp)).getTime(), temperature: Number(row.temperature) }));

  let prevCumExport = previousRows.length ? Number(previousRows[0].cumExport) : null;
  return kwhRows.map((row) => {
    const isoTimestamp = toIso(row.timestamp);
    const ms = new Date(isoTimestamp).getTime();
    const cumExport = Number(row.cumExport);
    // Energi per interval dihitung dari selisih meteran ekspor kumulatif (paling akurat),
    // bukan dari daya sesaat dikali waktu.
    const delta = prevCumExport === null ? 0 : cumExport - prevCumExport;
    const energyKwh = Number.isFinite(delta) && delta >= 0 ? Number(delta.toFixed(3)) : 0;
    prevCumExport = cumExport;
    return {
      id: `kwh-${date}-${row.timestamp}`,
      timestamp: isoTimestamp,
      // kwh_p dikonfigurasi lewat POWER_UNIT (kw secara default). Nilai absolut
      // dipakai agar pembacaan ekspor bertanda negatif tetap tampil sebagai daya produksi.
      powerKw: Number((Math.abs(Number(row.power)) / (POWER_UNIT === 'w' || POWER_UNIT === 'watt' || POWER_UNIT === 'watts' ? 1000 : 1)).toFixed(2)),
      energyKwh,
      voltage: Number(row.voltage),
      current: Number(row.current),
      temperature: nearestTemperature(tempRows, ms),
      source: 'sensor',
    };
  });
}

async function databaseTotal() {
  if (databaseTotalCache && databaseTotalCache.expiresAt > Date.now()) return databaseTotalCache.value;
  const [rows] = await pool.query('SELECT timestamp, kwh_eexp AS cumExport FROM kwh_log ORDER BY timestamp ASC');
  let previous = null;
  let energyKwh = 0;
  let revenue = 0;
  for (const row of rows) {
    const current = Number(row.cumExport);
    const delta = previous === null ? 0 : current - previous;
    if (Number.isFinite(delta) && delta >= 0) {
      energyKwh += delta;
      revenue += delta * tariffFor(String(row.timestamp).slice(0, 10)).rate;
    }
    previous = current;
  }
  const value = { energyKwh: Number(energyKwh.toFixed(2)), revenue: Math.round(revenue), readings: rows.length };
  databaseTotalCache = { value, expiresAt: Date.now() + 30 * 1000 };
  return value;
}

function isDate(value) { return /^\d{4}-\d{2}-\d{2}$/.test(value || ''); }

function shiftDate(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

async function chartFor(period, date) {
  if (period === 'daily') {
    const readings = await readingsFor(date);
    const hourly = Array.from({ length: 24 }, (_, hour) => ({
      label: `${String(hour).padStart(2, '0')}:00`,
      value: 0,
    }));
    for (const reading of readings) {
      const hour = Number(reading.timestamp.slice(11, 13));
      if (hour >= 0 && hour < 24) hourly[hour].value += Number(reading.energyKwh) || 0;
    }
    return {
      period,
      label: `Produksi energi per jam · ${date}`,
      points: hourly.map((point) => ({ ...point, value: Number(point.value.toFixed(3)) })),
    };
  }

  const start = period === 'weekly'
    ? shiftDate(date, -6)
    : `${date.slice(0, 8)}01`;
  // Ambil seluruh meter kumulatif dalam satu rentang lalu hitung delta seperti
  // readingsFor(). Ini tetap ringan (satu kueri) dan tidak salah saat meter
  // mengalami reset di tengah hari seperti pendekatan MAX - MIN.
  const [rows] = await pool.query(
    `SELECT timestamp, kwh_eexp AS cumExport FROM kwh_log
     WHERE DATE(timestamp) BETWEEN ? AND ? ORDER BY timestamp ASC`,
    [start, date],
  );
  const [beforeRows] = await pool.query(
    `SELECT kwh_eexp AS cumExport FROM kwh_log WHERE timestamp < ? ORDER BY timestamp DESC LIMIT 1`,
    [`${start} 00:00:00`],
  );
  let previous = beforeRows.length ? Number(beforeRows[0].cumExport) : null;
  const energyByDate = new Map();
  for (const row of rows) {
    const current = Number(row.cumExport);
    const delta = previous === null ? 0 : current - previous;
    const energy = Number.isFinite(delta) && delta >= 0 ? delta : 0;
    const day = String(row.timestamp).slice(0, 10);
    energyByDate.set(day, (energyByDate.get(day) || 0) + energy);
    previous = current;
  }
  const points = datesInRange(start, date).map((itemDate) => ({
    label: itemDate,
    value: Number((energyByDate.get(itemDate) || 0).toFixed(3)),
  }));
  return {
    period,
    label: period === 'weekly' ? `Produksi energi 7 hari terakhir` : `Produksi energi bulan ini`,
    points,
  };
}

function summary(readings, tariff) {
  const withTemp = readings.filter((r) => r.temperature !== null && r.temperature !== undefined);
  const totalEnergyKwh = readings.reduce((sum, r) => sum + (Number.isFinite(Number(r.energyKwh)) ? Number(r.energyKwh) : 0), 0);
  const avg = (key, list) => (list.length ? list.reduce((sum, r) => sum + Number(r[key] || 0), 0) / list.length : 0);
  return {
    totalEnergyKwh: Number(totalEnergyKwh.toFixed(2)),
    averageTemperature: Number(avg('temperature', withTemp).toFixed(1)),
    averagePowerKw: Number(avg('powerKw', readings).toFixed(1)),
    totalRevenue: Math.round(totalEnergyKwh * tariff.rate),
    tariff,
  };
}

function datesInRange(start, end) {
  const result = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (cursor <= last && result.length < 366) {
    result.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return result;
}

function xml(value) { return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char])); }
function cell(value, type = 'String') { return `<Cell><Data ss:Type="${type}">${xml(value)}</Data></Cell>`; }

async function exportSheet(start, end) {
  const days = [];
  for (const date of datesInRange(start, end)) {
    const readings = await readingsFor(date);
    days.push({ date, readings, tariff: tariffFor(date) });
  }
  const data = days.flatMap(({ date, readings, tariff }) => readings.map((r) => `<Row>${cell(date)}${cell(r.timestamp.slice(11, 16))}${cell(r.temperature ?? '')}${cell(r.powerKw, 'Number')}${cell(r.energyKwh, 'Number')}${cell(r.voltage, 'Number')}${cell(r.current, 'Number')}${cell(tariff.rate, 'Number')}${cell(Math.round(r.energyKwh * tariff.rate), 'Number')}</Row>`)).join('');
  const allReadings = days.flatMap(({ readings }) => readings);
  const dailySummaries = days.map(({ readings, tariff }) => summary(readings, tariff));
  const totalEnergy = dailySummaries.reduce((sum, dailySummary) => sum + dailySummary.totalEnergyKwh, 0);
  const totalRevenue = dailySummaries.reduce((sum, dailySummary) => sum + dailySummary.totalRevenue, 0);
  const average = (key) => {
    const values = allReadings
      .filter((row) => row[key] !== null && row[key] !== undefined && row[key] !== '')
      .map((row) => Number(row[key]))
      .filter(Number.isFinite);
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  };
  const summaryRows = [
    ['Rata-rata suhu panel', Number(average('temperature').toFixed(1)), '°C'],
    ['Rata-rata daya', Number(average('powerKw').toFixed(1)), 'kW'],
    ['Total energi', Number(totalEnergy.toFixed(2)), 'kWh'],
    ['Rata-rata tegangan', Number(average('voltage').toFixed(1)), 'V'],
    ['Rata-rata arus', Number(average('current').toFixed(1)), 'A'],
    ['Total revenue', Math.round(totalRevenue), 'Rp'],
  ].map(([label, value, unit]) => `<Row>${cell(label)}${cell(value, 'Number')}${cell(unit)}</Row>`).join('');
  const summaryHeader = `<Row>${cell('Kategori')}${cell('Nilai')}${cell('Satuan')}</Row>`;
  return `<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="Riwayat PLTS"><Table><Row>${cell(`Riwayat PLTS SMPN 282 Jakarta (${start} s.d. ${end})`)}</Row><Row>${cell('Tanggal')}${cell('Waktu')}${cell('Suhu Panel (°C)')}${cell('Daya (kW)')}${cell('Energi Interval (kWh)')}${cell('Tegangan (V)')}${cell('Arus (A)')}${cell('Tarif (Rp/kWh)')}${cell('Revenue (Rp)')}</Row>${data}<Row/><Row>${cell(`RINGKASAN RENTANG (${start} s.d. ${end})`)}</Row>${summaryHeader}${summaryRows}</Table></Worksheet></Workbook>`;
}

function json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); }

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map((item) => {
    const separator = item.indexOf('=');
    return separator < 0 ? [] : [item.slice(0, separator).trim(), decodeURIComponent(item.slice(separator + 1).trim())];
  }).filter((item) => item.length));
}

function isAuthenticated(req) {
  const session = sessions.get(cookies(req).ecowatt_session);
  return session && session.expiresAt > Date.now();
}

function isSecureRequest(req) {
  return process.env.NODE_ENV === 'production' || req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted;
}

function setSession(req, res) {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, { expiresAt: Date.now() + 8 * 60 * 60 * 1000 });
  const secure = isSecureRequest(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `ecowatt_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800${secure}`);
}

function clearSession(req, res) {
  sessions.delete(cookies(req).ecowatt_session);
  res.setHeader('Set-Cookie', 'ecowatt_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
}

function secureEqual(input, expected) {
  const actual = Buffer.from(String(input || ''));
  const target = Buffer.from(expected);
  return actual.length === target.length && crypto.timingSafeEqual(actual, target);
}

function databaseError(error) {
  console.error('Database error:', error.code || error.message);
  return {
    error: 'Gagal mengambil data dari database.',
    code: error.code || 'DATABASE_ERROR',
  };
}

http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (isSecureRequest(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

  if (url.pathname === '/api/auth/login' && req.method === 'POST') {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    return req.on('end', () => {
      try {
        const address = req.socket.remoteAddress || 'unknown';
        const attempt = loginAttempts.get(address) || { count: 0, since: Date.now() };
        if (Date.now() - attempt.since > 15 * 60 * 1000) { attempt.count = 0; attempt.since = Date.now(); }
        if (attempt.count >= 5) return json(res, 429, { error: 'Terlalu banyak percobaan login. Coba lagi dalam 15 menit.' });
        const { username, password } = JSON.parse(raw);
        const usernameMatches = secureEqual(username, APP_USERNAME);
        const passwordMatches = secureEqual(password, APP_PASSWORD);
        if (!usernameMatches || !passwordMatches) {
          attempt.count += 1;
          loginAttempts.set(address, attempt);
          return json(res, 401, { error: 'Username atau kata sandi salah.' });
        }
        loginAttempts.delete(address);
        setSession(req, res);
        return json(res, 200, { username: APP_USERNAME });
      } catch { return json(res, 400, { error: 'Data login tidak valid.' }); }
    });
  }

  if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
    clearSession(req, res);
    return json(res, 200, { ok: true });
  }

  if (!isAuthenticated(req)) {
    if (url.pathname.startsWith('/api/')) return json(res, 401, { error: 'Silakan login terlebih dahulu.' });
    if (url.pathname !== '/login.html' && url.pathname !== '/login.js' && url.pathname !== '/style.css' && url.pathname !== '/favicon.svg' && !url.pathname.startsWith('/assets/')) {
      res.writeHead(302, { Location: '/login.html' });
      return res.end();
    }
  }

  if (isAuthenticated(req) && (url.pathname === '/login.html' || url.pathname === '/')) {
    res.writeHead(302, { Location: '/index.html' });
    return res.end();
  }

  if (url.pathname === '/api/readings/export' && req.method === 'GET') {
    const start = url.searchParams.get('start');
    const end = url.searchParams.get('end');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start || '') || !/^\d{4}-\d{2}-\d{2}$/.test(end || '') || start > end) return json(res, 400, { error: 'Rentang tanggal tidak valid.' });
    return exportSheet(start, end)
      .then((xmlBody) => {
        res.writeHead(200, { 'Content-Type': 'application/vnd.ms-excel; charset=utf-8', 'Content-Disposition': `attachment; filename="riwayat-plts-${start}-sd-${end}.xls"` });
        res.end(xmlBody);
      })
      .catch((error) => json(res, 500, databaseError(error)));
  }

  if (url.pathname === '/api/readings' && req.method === 'GET') {
    const date = url.searchParams.get('date') || dateKey();
    if (!isDate(date)) return json(res, 400, { error: 'Tanggal tidak valid.' });
  return readingsFor(date)
      .then(async (readings) => {
        const previousDate = shiftDate(date, -1);
        const previousReadings = await readingsFor(previousDate);
        const database = await databaseTotal();
        return json(res, 200, {
          date,
          readings,
          summary: { ...summary(readings, tariffFor(date)), previousDayEnergyKwh: summary(previousReadings, tariffFor(previousDate)).totalEnergyKwh, databaseTotalEnergyKwh: database.energyKwh, databaseTotalRevenue: database.revenue, databaseReadingCount: database.readings },
        });
      })
      .catch((error) => json(res, 500, databaseError(error)));
  }

  if (url.pathname === '/api/readings/range' && req.method === 'GET') {
    const start = url.searchParams.get('start');
    const end = url.searchParams.get('end');
    if (!isDate(start) || !isDate(end) || start > end) return json(res, 400, { error: 'Rentang tanggal tidak valid.' });
    return Promise.all(datesInRange(start, end).map(async (itemDate) => {
      const readings = await readingsFor(itemDate);
      return { date: itemDate, readings, summary: summary(readings, tariffFor(itemDate)) };
    }))
      .then(async (days) => {
        const readings = days.flatMap((day) => day.readings);
        const totalEnergyKwh = days.reduce((sum, day) => sum + day.summary.totalEnergyKwh, 0);
        const totalRevenue = days.reduce((sum, day) => sum + day.summary.totalRevenue, 0);
        const averagePowerKw = readings.length ? readings.reduce((sum, row) => sum + Number(row.powerKw || 0), 0) / readings.length : 0;
        const temperatures = readings.filter((row) => row.temperature !== null && row.temperature !== undefined && Number.isFinite(Number(row.temperature)));
        const averageTemperature = temperatures.length ? temperatures.reduce((sum, row) => sum + Number(row.temperature), 0) / temperatures.length : 0;
        const database = await databaseTotal();
        return json(res, 200, {
          date: start,
          range: { start, end },
          readings,
          summary: { totalEnergyKwh: Number(totalEnergyKwh.toFixed(2)), averageTemperature: Number(averageTemperature.toFixed(1)), averagePowerKw: Number(averagePowerKw.toFixed(1)), totalRevenue, readingCount: readings.length, tariff: tariffFor(end), databaseTotalEnergyKwh: database.energyKwh, databaseTotalRevenue: database.revenue, databaseReadingCount: database.readings },
        });
      })
      .catch((error) => json(res, 500, databaseError(error)));
  }

  if (url.pathname === '/api/readings/chart' && req.method === 'GET') {
    const date = url.searchParams.get('date') || dateKey();
    const period = url.searchParams.get('period') || 'daily';
    if (!isDate(date) || !['daily', 'weekly', 'monthly'].includes(period)) return json(res, 400, { error: 'Tanggal atau periode grafik tidak valid.' });
    return chartFor(period, date)
      .then((chart) => json(res, 200, chart))
      .catch((error) => json(res, 500, databaseError(error)));
  }

  if (url.pathname === '/api/tariffs' && req.method === 'GET') return json(res, 200, { tariffs: tariffs() });

  if (url.pathname === '/api/tariffs' && req.method === 'POST') {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    return req.on('end', () => {
      try {
        const item = JSON.parse(raw);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(item.effectiveDate || '') || !Number.isFinite(Number(item.rate)) || Number(item.rate) <= 0) return json(res, 400, { error: 'effectiveDate dan rate wajib valid.' });
        const list = tariffs().filter((tariff) => tariff.effectiveDate !== item.effectiveDate);
        list.push({ effectiveDate: item.effectiveDate, rate: Number(item.rate), category: item.category || 'P-1/TR', source: item.source || 'Pembaruan admin' });
        writeJson(TARIFFS_FILE, list.sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate)));
        return json(res, 201, { tariff: item });
      } catch { return json(res, 400, { error: 'Format JSON tidak valid.' }); }
    });
  }

  // Catatan: endpoint POST /api/readings sudah tidak dipakai -- sensor menulis
  // langsung ke MySQL lewat script Python terpisah di Raspi.

  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.normalize(path.join(ROOT, requested));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`Monitoring PLTS SMPN 282 Jakarta berjalan di http://localhost:${PORT}`));
