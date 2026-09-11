// =====================================================================
// AUTH GUARD — cek sesi Supabase Auth dulu sebelum render dashboard
// =====================================================================
const { data: { session } } = await supabaseClient.auth.getSession();
if (!session) {
  window.location.href = '/login.html';
}
supabaseClient.auth.onAuthStateChange((_event, newSession) => {
  if (!newSession) window.location.href = '/login.html';
});

// =====================================================================
// Konstanta & util (sama seperti sebelumnya)
// =====================================================================
const DEFAULT_TARIFF = { effectiveDate: '2026-01-01', rate: 1699.53, category: 'P-1/TR', source: 'Tarif aktif aplikasi' };
let tariffCache = null;
const rupiah = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat('id-ID', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const $ = (selector) => document.querySelector(selector);
let latestPayload = null;
let dashboardPayload = null;
let chartPeriod = 'daily';
let databaseTotalCache = null;

function setText(selector, value) { const element = $(selector); if (element) element.textContent = value; }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
function localDateKey(date = new Date()) { const wib = new Date(date.getTime() + 7 * 60 * 60 * 1000); return wib.toISOString().slice(0, 10); }
function displayDate(date) { return new Intl.DateTimeFormat('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(`${date}T00:00:00+07:00`)); }
function numberOrDash(value, suffix = '') { return Number.isFinite(Number(value)) ? `${decimal.format(Number(value))}${suffix}` : '—'; }
function timeOf(timestamp) { return new Intl.DateTimeFormat('id-ID', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(timestamp)); }
function formatTariff(rate) { return `Rp${rate.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/kWh`; }
function isDate(value) { return /^\d{4}-\d{2}-\d{2}$/.test(value || ''); }
function shiftDate(date, days) { const value = new Date(`${date}T00:00:00Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10); }
function datesInRange(start, end) {
  const result = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (cursor <= last && result.length < 366) { result.push(cursor.toISOString().slice(0, 10)); cursor.setUTCDate(cursor.getUTCDate() + 1); }
  return result;
}
function toIso(timestamp) { return timestamp.replace(' ', 'T') + '+07:00'; }

// =====================================================================
// Tarif — sekarang dari tabel Supabase "tariffs" (bukan file tariffs.json)
// =====================================================================
async function loadTariffs() {
  if (tariffCache) return tariffCache;
  const { data, error } = await supabaseClient.from('tariffs').select('*').order('effective_date', { ascending: true });
  if (error || !data || !data.length) { tariffCache = [DEFAULT_TARIFF]; return tariffCache; }
  tariffCache = data.map((row) => ({ effectiveDate: row.effective_date, rate: Number(row.rate), category: row.category, source: row.source }));
  return tariffCache;
}
async function tariffFor(date) {
  const list = await loadTariffs();
  return list.filter((item) => item.effectiveDate <= date).at(-1) || list[0];
}

// =====================================================================
// Pengambilan data sensor dari Supabase (menggantikan query MySQL di server.js)
// =====================================================================
function nearestTemperature(tempRows, targetMs, toleranceMs = 6 * 60 * 1000) {
  let closest = null; let closestDiff = Infinity;
  for (const row of tempRows) {
    const diff = Math.abs(row.ms - targetMs);
    if (diff < closestDiff) { closestDiff = diff; closest = row; }
  }
  return closest && closestDiff <= toleranceMs ? closest.temperature : null;
}

async function fetchKwhRange(startInclusive, endExclusive) {
  const { data, error } = await supabaseClient
    .from('kwh_log')
    .select('id,timestamp,kwh_v,kwh_i,kwh_p,kwh_eexp')
    .gte('timestamp', startInclusive)
    .lt('timestamp', endExclusive)
    .order('timestamp', { ascending: true });
  if (error) throw new Error('Gagal mengambil data kwh_log: ' + error.message);
  return data || [];
}

async function fetchTempRange(startInclusive, endExclusive) {
  const { data, error } = await supabaseClient
    .from('temp_log')
    .select('id,timestamp,module_temp')
    .gte('timestamp', startInclusive)
    .lt('timestamp', endExclusive)
    .order('timestamp', { ascending: true });
  if (error) throw new Error('Gagal mengambil data temp_log: ' + error.message);
  return data || [];
}

async function previousCumExport(beforeTimestamp) {
  const { data, error } = await supabaseClient
    .from('kwh_log')
    .select('kwh_eexp')
    .lt('timestamp', beforeTimestamp)
    .order('timestamp', { ascending: false })
    .limit(1);
  if (error) throw new Error('Gagal mengambil data pembanding: ' + error.message);
  return data && data.length ? Number(data[0].kwh_eexp) : null;
}

function buildReadings(kwhRows, tempRowsRaw, prevCumExportInit) {
  const tempRows = tempRowsRaw.map((row) => ({ ms: new Date(toIso(row.timestamp)).getTime(), temperature: Number(row.module_temp) }));
  let prevCumExport = prevCumExportInit;
  return kwhRows.map((row) => {
    const isoTimestamp = toIso(row.timestamp);
    const ms = new Date(isoTimestamp).getTime();
    const cumExport = Number(row.kwh_eexp);
    const delta = prevCumExport === null ? 0 : cumExport - prevCumExport;
    const energyKwh = Number.isFinite(delta) && delta >= 0 ? Number(delta.toFixed(3)) : 0;
    prevCumExport = cumExport;
    return {
      id: `kwh-${row.id}`,
      timestamp: isoTimestamp,
      powerKw: Number(Math.abs(Number(row.kwh_p)).toFixed(2)),
      energyKwh,
      voltage: Number(row.kwh_v),
      current: Number(row.kwh_i),
      temperature: nearestTemperature(tempRows, ms),
      source: 'sensor',
    };
  });
}

async function readingsFor(date) {
  const next = shiftDate(date, 1);
  const [kwhRows, tempRowsRaw, prevCumExport] = await Promise.all([
    fetchKwhRange(`${date} 00:00:00`, `${next} 00:00:00`),
    fetchTempRange(`${date} 00:00:00`, `${next} 00:00:00`),
    previousCumExport(`${date} 00:00:00`),
  ]);
  return buildReadings(kwhRows, tempRowsRaw, prevCumExport);
}

// Total keseluruhan database — dipaginasi karena Supabase membatasi 1000 baris/request
async function fetchAllKwh() {
  const pageSize = 1000;
  let from = 0;
  let all = [];
  while (true) {
    const { data, error } = await supabaseClient
      .from('kwh_log')
      .select('timestamp,kwh_eexp')
      .order('timestamp', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error('Gagal mengambil total database: ' + error.message);
    if (!data || !data.length) break;
    all = all.concat(data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

async function databaseTotal() {
  if (databaseTotalCache && databaseTotalCache.expiresAt > Date.now()) return databaseTotalCache.value;
  const rows = await fetchAllKwh();
  let previous = null; let energyKwh = 0; let revenue = 0;
  for (const row of rows) {
    const current = Number(row.kwh_eexp);
    const delta = previous === null ? 0 : current - previous;
    if (Number.isFinite(delta) && delta >= 0) {
      energyKwh += delta;
      revenue += delta * (await tariffFor(String(row.timestamp).slice(0, 10))).rate;
    }
    previous = current;
  }
  const value = { energyKwh: Number(energyKwh.toFixed(2)), revenue: Math.round(revenue), readings: rows.length };
  databaseTotalCache = { value, expiresAt: Date.now() + 30 * 1000 };
  return value;
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

async function chartFor(period, date) {
  if (period === 'daily') {
    const readings = await readingsFor(date);
    const hourly = Array.from({ length: 24 }, (_, hour) => ({ label: `${String(hour).padStart(2, '0')}:00`, value: 0 }));
    for (const reading of readings) {
      const hour = Number(reading.timestamp.slice(11, 13));
      if (hour >= 0 && hour < 24) hourly[hour].value += Number(reading.energyKwh) || 0;
    }
    return { period, label: `Produksi energi per jam · ${date}`, points: hourly.map((point) => ({ ...point, value: Number(point.value.toFixed(3)) })) };
  }
  const start = period === 'weekly' ? shiftDate(date, -6) : `${date.slice(0, 8)}01`;
  const [rows, prevCumExport] = await Promise.all([
    fetchKwhRange(`${start} 00:00:00`, `${shiftDate(date, 1)} 00:00:00`),
    previousCumExport(`${start} 00:00:00`),
  ]);
  let previous = prevCumExport;
  const energyByDate = new Map();
  for (const row of rows) {
    const current = Number(row.kwh_eexp);
    const delta = previous === null ? 0 : current - previous;
    const energy = Number.isFinite(delta) && delta >= 0 ? delta : 0;
    const day = String(row.timestamp).slice(0, 10);
    energyByDate.set(day, (energyByDate.get(day) || 0) + energy);
    previous = current;
  }
  const points = datesInRange(start, date).map((itemDate) => ({ label: itemDate, value: Number((energyByDate.get(itemDate) || 0).toFixed(3)) }));
  return { period, label: period === 'weekly' ? 'Produksi energi 7 hari terakhir' : 'Produksi energi bulan ini', points };
}

// =====================================================================
// Rendering (SAMA seperti sebelumnya — tidak diubah)
// =====================================================================
function formatChartLabel(label, period) {
  if (period === 'daily') return label;
  return new Intl.DateTimeFormat('id-ID', { day: '2-digit', month: 'short' }).format(new Date(`${label}T00:00:00`));
}

function renderEnergyChart(chart) {
  const values = chart.points.map((point) => Number(point.value) || 0);
  const total = values.reduce((sum, value) => sum + value, 0);
  const yAxis = $('#chartYAxis');
  const xAxis = $('#chartXAxis');
  setText('#chartSubtitle', chart.label);
  setText('#chartAxesDescription', chart.period === 'daily' ? 'Sumbu Y: total energi per jam (kWh) · Sumbu X: jam (24 jam)' : 'Sumbu Y: total energi per hari (kWh) · Sumbu X: tanggal');
  setText('#chartTotal', `${decimal.format(total)} kWh`);
  if (!values.length) {
    $('#linePath').setAttribute('d', ''); $('#areaPath').setAttribute('d', ''); $('#chartDot').setAttribute('visibility', 'hidden');
    yAxis.innerHTML = '<span>0</span><span>0</span><span>0</span><span>0</span><span>0</span>';
    xAxis.innerHTML = '<span>Belum ada data</span>';
    return;
  }
  const max = Math.max(...values, 0.01);
  const scaleMax = Math.ceil(max * 1.1 * 10) / 10;
  const width = 760, top = 10, bottom = 186;
  const x = (index) => values.length === 1 ? width / 2 : (index / (values.length - 1)) * width;
  const y = (value) => bottom - (value / scaleMax) * (bottom - top);
  const coordinates = values.map((value, index) => [x(index), y(value)]);
  const line = coordinates.map(([pointX, pointY], index) => `${index ? 'L' : 'M'}${pointX.toFixed(1)},${pointY.toFixed(1)}`).join(' ');
  const area = `${line} L${coordinates.at(-1)[0].toFixed(1)},${bottom} L${coordinates[0][0].toFixed(1)},${bottom} Z`;
  $('#linePath').setAttribute('d', line); $('#areaPath').setAttribute('d', area);
  const last = coordinates.at(-1);
  $('#chartDot').setAttribute('cx', last[0].toFixed(1)); $('#chartDot').setAttribute('cy', last[1].toFixed(1)); $('#chartDot').setAttribute('visibility', 'visible');
  yAxis.innerHTML = [scaleMax, scaleMax * .75, scaleMax * .5, scaleMax * .25, 0].map((value) => `<span>${decimal.format(value)}</span>`).join('');
  const labelCount = Math.min(chart.period === 'daily' ? 7 : 6, chart.points.length);
  const labelIndexes = Array.from({ length: labelCount }, (_, index) => Math.round(index * (chart.points.length - 1) / Math.max(1, labelCount - 1)));
  xAxis.innerHTML = labelIndexes.map((index) => `<span>${formatChartLabel(chart.points[index].label, chart.period)}</span>`).join('');
}

async function loadChart() {
  const date = dashboardPayload?.date || localDateKey();
  if (chartPeriod === 'daily' && dashboardPayload?.date === date) {
    renderEnergyChart({
      period: 'daily',
      label: `Produksi energi per jam · ${date}`,
      points: Array.from({ length: 24 }, (_, hour) => ({
        label: `${String(hour).padStart(2, '0')}:00`,
        value: dashboardPayload.readings.filter((reading) => Number(reading.timestamp.slice(11, 13)) === hour).reduce((sum, reading) => sum + (Number(reading.energyKwh) || 0), 0),
      })),
    });
    return;
  }
  renderEnergyChart(await chartFor(chartPeriod, date));
}

function renderHistory(readings, totals) {
  if (!readings.length) {
    $('#historyRows').innerHTML = '<tr><td colspan="8" class="history-error">Belum ada data sensor untuk rentang tanggal yang dipilih.</td></tr>';
    setText('#historyDescription', 'Tidak ada pembacaan pada tanggal yang dipilih');
    ['#summaryEnergy', '#summaryRevenue', '#summaryPower', '#summaryTemperature', '#summaryReadings'].forEach((selector) => setText(selector, '—'));
    return;
  }
  const range = latestPayload?.range;
  setText('#historyDescription', range && range.start !== range.end ? `${readings.length} pembacaan sensor dari ${range.start} sampai ${range.end}` : `${readings.length} pembacaan sensor pada tanggal yang dipilih`);
  $('#historyRows').innerHTML = readings.map((reading) => `<tr><td>${escapeHtml(reading.timestamp.slice(0, 10))}</td><td>${escapeHtml(timeOf(reading.timestamp))}</td><td>${numberOrDash(reading.temperature, ' °C')}</td><td>${numberOrDash(reading.powerKw, ' kW')}</td><td>${numberOrDash(reading.energyKwh, ' kWh')}</td><td>${numberOrDash(reading.voltage, ' V')}</td><td>${numberOrDash(reading.current, ' A')}</td><td>Rp${rupiah.format(Number(reading.energyKwh || 0) * totals.tariff.rate)}</td></tr>`).join('');
  setText('#summaryEnergy', numberOrDash(totals.totalEnergyKwh));
  setText('#summaryRevenue', `Rp${rupiah.format(totals.totalRevenue)}`);
  setText('#summaryPower', numberOrDash(totals.averagePowerKw));
  setText('#summaryTemperature', numberOrDash(totals.averageTemperature));
  setText('#summaryReadings', String(totals.readingCount || readings.length));
}

function updateDashboard(readings, totals, payload = dashboardPayload) {
  if (!readings.length) {
    ['#energyValue', '#powerValue', '#dailyRevenue', '#dailyEnergy', '#meterEnergy', '#temperatureValue', '#voltageValue', '#currentValue', '#totalRevenueAllTime'].forEach((selector) => setText(selector, '—'));
    setText('#dashboardDate', payload?.date ? displayDate(payload.date) : '');
    setText('#heroComparison', 'Belum ada data produksi pada tanggal ini.');
    setText('#chartComparison', '');
    setText('#alertTitle', 'Tidak ada data sensor');
    setText('#alertDescription', 'Belum ada pembacaan untuk tanggal yang dipilih.');
    return;
  }
  const now = new Date();
  const applicable = readings.filter((reading) => new Date(reading.timestamp) <= now);
  const latest = applicable.at(-1) || readings[0];
  const energy = totals.totalEnergyKwh;
  const selectedDate = payload?.date || localDateKey();
  const isCurrentDate = selectedDate === localDateKey();
  const previousEnergy = Number(totals.previousDayEnergyKwh);
  const comparison = Number.isFinite(previousEnergy) && previousEnergy > 0 ? ((energy - previousEnergy) / previousEnergy) * 100 : null;
  setText('#dashboardDate', displayDate(selectedDate));
  setText('#energyMetricLabel', isCurrentDate ? 'Produksi hari ini' : 'Produksi tanggal terpilih');
  setText('#revenueMetricLabel', isCurrentDate ? 'Revenue hari ini' : 'Revenue tanggal terpilih');
  setText('#heroComparison', comparison === null ? 'Belum ada data pembanding dari hari sebelumnya.' : `Produksi ${comparison >= 0 ? 'lebih tinggi' : 'lebih rendah'} ${decimal.format(Math.abs(comparison))}% dari hari sebelumnya.`);
  setText('#chartComparison', comparison === null ? '' : `${comparison >= 0 ? '↑' : '↓'} ${decimal.format(Math.abs(comparison))}%`);
  $('#chartComparison').classList.toggle('positive', comparison !== null && comparison >= 0);
  $('#chartComparison').classList.toggle('negative', comparison !== null && comparison < 0);
  setText('#powerValue', numberOrDash(latest.powerKw));
  $('#powerProgress').style.width = `${Math.min(100, Math.max(0, Number(latest.powerKw) || 0))}%`;
  setText('#energyValue', decimal.format(energy)); setText('#chartTotal', `${decimal.format(energy)} kWh`);
  const dailyRevenue = totals.totalRevenue;
  setText('#dailyRevenue', rupiah.format(dailyRevenue)); setText('#dailyEnergy', decimal.format(energy)); setText('#tariffLabel', formatTariff(totals.tariff.rate));
  setText('#totalRevenueAllTime', Number.isFinite(Number(totals.databaseTotalRevenue)) ? `Rp${rupiah.format(totals.databaseTotalRevenue)}` : '—');
  setText('#projectionNote', Number.isFinite(Number(totals.databaseReadingCount)) ? `Akumulasi ${totals.databaseTotalEnergyKwh} kWh dari ${totals.databaseReadingCount} pembacaan sensor` : 'Akumulasi dari seluruh data sensor yang tersimpan');
  const temperature = latest.temperature === null || latest.temperature === undefined ? NaN : Number(latest.temperature);
  const hasTemperature = Number.isFinite(temperature);
  const latestAgeMinutes = (Date.now() - new Date(latest.timestamp).getTime()) / 60000;
  const online = !isCurrentDate || latestAgeMinutes <= 15;
  setText('#temperatureValue', hasTemperature ? decimal.format(temperature) : '—');
  setText('#temperatureStatus', hasTemperature ? (temperature < 65 ? '● Normal' : '● Suhu tinggi') : '● Tidak tersedia');
  setText('#meterEnergy', decimal.format(energy));
  setText('#voltageValue', numberOrDash(latest.voltage, ' V')); setText('#currentValue', numberOrDash(latest.current, ' A'));
  setText('#alertTitle', online && hasTemperature ? (temperature < 65 ? 'Semua sensor normal' : 'Perhatian suhu panel') : 'Periksa koneksi sensor');
  setText('#alertDescription', online && hasTemperature ? (temperature < 65 ? 'Suhu dan pembacaan meter berada pada rentang aman.' : 'Suhu panel melewati batas aman 65°C.') : 'Pembacaan terakhir sudah lebih dari 15 menit atau suhu tidak tersedia.');
  setText('#lastUpdated', new Intl.DateTimeFormat('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(now));
}

// =====================================================================
// Orkestrasi utama (menggantikan fetch ke /api/readings & /api/readings/range)
// =====================================================================
async function loadReadings() {
  try {
    const start = $('#historyDate').value;
    const end = $('#historyEndDate').value || start;
    const rangeReadings = (await Promise.all(datesInRange(start, end).map(async (itemDate) => ({
      date: itemDate, readings: await readingsFor(itemDate), tariff: await tariffFor(itemDate),
    })))).map((day) => ({ ...day, summary: summary(day.readings, day.tariff) }));

    const readings = rangeReadings.flatMap((day) => day.readings);
    const totalEnergyKwh = rangeReadings.reduce((sum, day) => sum + day.summary.totalEnergyKwh, 0);
    const totalRevenue = rangeReadings.reduce((sum, day) => sum + day.summary.totalRevenue, 0);
    const averagePowerKw = readings.length ? readings.reduce((sum, row) => sum + Number(row.powerKw || 0), 0) / readings.length : 0;
    const temperatures = readings.filter((row) => row.temperature !== null && row.temperature !== undefined && Number.isFinite(Number(row.temperature)));
    const averageTemperature = temperatures.length ? temperatures.reduce((sum, row) => sum + Number(row.temperature), 0) / temperatures.length : 0;
    const database = await databaseTotal();
    const rangeTariff = await tariffFor(end);

    latestPayload = {
      date: start, range: { start, end }, readings,
      summary: { totalEnergyKwh: Number(totalEnergyKwh.toFixed(2)), averageTemperature: Number(averageTemperature.toFixed(1)), averagePowerKw: Number(averagePowerKw.toFixed(1)), totalRevenue, readingCount: readings.length, tariff: rangeTariff, databaseTotalEnergyKwh: database.energyKwh, databaseTotalRevenue: database.revenue, databaseReadingCount: database.readings },
    };
    renderHistory(latestPayload.readings, latestPayload.summary);

    // Dashboard mengikuti tanggal/rentang yang sedang dipilih pada laporan.
    // Untuk rentang multi-hari, readings sudah berisi seluruh data dalam
    // rentang tersebut dan pembacaan terakhir dipakai untuk kartu daya/suhu.
    const previousDate = shiftDate(start, -1);
    const previousReadings = await readingsFor(previousDate);
    const selectedTariff = await tariffFor(end);
    dashboardPayload = {
      date: start, range: { start, end }, readings,
      summary: { ...latestPayload.summary, tariff: selectedTariff, previousDayEnergyKwh: summary(previousReadings, await tariffFor(previousDate)).totalEnergyKwh, databaseTotalEnergyKwh: database.energyKwh, databaseTotalRevenue: database.revenue, databaseReadingCount: database.readings },
    };
    updateDashboard(dashboardPayload.readings, dashboardPayload.summary, dashboardPayload);
    await loadChart();
  } catch (error) {
    $('#historyRows').innerHTML = `<tr><td colspan="8" class="history-error"></td></tr>`;
    setText('.history-error', error.message);
    console.error(error);
  }
}

// =====================================================================
// Export Excel — sekarang di-generate langsung di browser (bukan server)
// =====================================================================
function xml(value) { return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char])); }
function cell(value, type = 'String') { return `<Cell><Data ss:Type="${type}">${xml(value)}</Data></Cell>`; }

async function exportSheet(start, end) {
  const days = [];
  for (const date of datesInRange(start, end)) days.push({ date, readings: await readingsFor(date), tariff: await tariffFor(date) });
  const data = days.flatMap(({ date, readings, tariff }) => readings.map((r) => `<Row>${cell(date)}${cell(r.timestamp.slice(11, 16))}${cell(r.temperature ?? '')}${cell(r.powerKw, 'Number')}${cell(r.energyKwh, 'Number')}${cell(r.voltage, 'Number')}${cell(r.current, 'Number')}${cell(tariff.rate, 'Number')}${cell(Math.round(r.energyKwh * tariff.rate), 'Number')}</Row>`)).join('');
  const allReadings = days.flatMap(({ readings }) => readings);
  const dailySummaries = days.map(({ readings, tariff }) => summary(readings, tariff));
  const totalEnergy = dailySummaries.reduce((sum, s) => sum + s.totalEnergyKwh, 0);
  const totalRevenue = dailySummaries.reduce((sum, s) => sum + s.totalRevenue, 0);
  const average = (key) => { const v = allReadings.filter((r) => r[key] !== null && r[key] !== undefined && r[key] !== '').map((r) => Number(r[key])).filter(Number.isFinite); return v.length ? v.reduce((s, n) => s + n, 0) / v.length : 0; };
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

// =====================================================================
// Event listener (SAMA seperti sebelumnya, kecuali export & logout)
// =====================================================================
$('.menu-button').addEventListener('click', () => $('.sidebar').classList.toggle('open'));
document.querySelectorAll('.nav-item').forEach((link) => link.addEventListener('click', () => $('.sidebar').classList.remove('open')));
document.querySelectorAll('.chart-tabs button').forEach((button) => button.addEventListener('click', async () => {
  if (button.classList.contains('active')) return;
  $('.chart-tabs .active').classList.remove('active');
  button.classList.add('active');
  chartPeriod = button.dataset.period;
  setText('#chartSubtitle', 'Memuat data grafik…');
  try { await loadChart(); } catch (error) { console.error(error); setText('#chartSubtitle', error.message || 'Gagal memuat data grafik'); }
}));
$('#historyDate').value = localDateKey();
$('#historyEndDate').value = $('#historyDate').value;
$('#historyDate').addEventListener('change', () => { if ($('#historyEndDate').value < $('#historyDate').value) $('#historyEndDate').value = $('#historyDate').value; loadReadings(); });
$('#historyEndDate').addEventListener('change', () => { if ($('#historyEndDate').value < $('#historyDate').value) $('#historyEndDate').value = $('#historyDate').value; loadReadings(); });

$('#exportHistory').addEventListener('click', async () => {
  const start = $('#historyDate').value;
  const end = $('#historyEndDate').value;
  if (!start || !end || start > end) return window.alert('Pilih rentang tanggal yang valid.');
  const button = $('#exportHistory');
  const originalLabel = button.textContent;
  button.disabled = true; button.textContent = 'Menyiapkan Excel…';
  try {
    const xmlBody = await exportSheet(start, end);
    const blob = new Blob([xmlBody], { type: 'application/vnd.ms-excel;charset=utf-8' });
    const downloadUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = downloadUrl; link.download = `riwayat-plts-${start}-sd-${end}.xls`; link.style.display = 'none';
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
  } catch (error) {
    window.alert(error.message || 'Gagal mengunduh Excel.');
  } finally {
    button.disabled = false; button.textContent = originalLabel;
  }
});

$('#logoutButton').addEventListener('click', async () => {
  await supabaseClient.auth.signOut();
  window.location.href = '/login.html';
});

loadReadings();
setInterval(loadReadings, 30000);
