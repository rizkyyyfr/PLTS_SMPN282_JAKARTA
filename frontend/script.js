let tariffPerKwh = 1699.53;
const rupiah = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat('id-ID', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const $ = (selector) => document.querySelector(selector);
let latestPayload = null;
let dashboardPayload = null;
let chartPeriod = 'daily';

function setText(selector, value) { const element = $(selector); if (element) element.textContent = value; }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
function localDateKey(date = new Date()) { const wib = new Date(date.getTime() + 7 * 60 * 60 * 1000); return wib.toISOString().slice(0, 10); }
function displayDate(date) { return new Intl.DateTimeFormat('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(`${date}T00:00:00+07:00`)); }
function numberOrDash(value, suffix = '') { return Number.isFinite(Number(value)) ? `${decimal.format(Number(value))}${suffix}` : '—'; }
function timeOf(timestamp) { return new Intl.DateTimeFormat('id-ID', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(timestamp)); }
function formatTariff() { return `Rp${tariffPerKwh.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/kWh`; }

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
  setText('#chartAxesDescription', chart.period === 'daily'
    ? 'Sumbu Y: total energi per jam (kWh) · Sumbu X: jam (24 jam)'
    : 'Sumbu Y: total energi per hari (kWh) · Sumbu X: tanggal');
  setText('#chartTotal', `${decimal.format(total)} kWh`);

  if (!values.length) {
    $('#linePath').setAttribute('d', '');
    $('#areaPath').setAttribute('d', '');
    $('#chartDot').setAttribute('visibility', 'hidden');
    yAxis.innerHTML = '<span>0</span><span>0</span><span>0</span><span>0</span><span>0</span>';
    xAxis.innerHTML = '<span>Belum ada data</span>';
    return;
  }

  const max = Math.max(...values, 0.01);
  const scaleMax = Math.ceil(max * 1.1 * 10) / 10;
  // Koordinat ini harus sama dengan garis grid dan label sumbu-Y di CSS/SVG.
  // Sebelumnya garis data berakhir di y=220, sedangkan garis grid dan label
  // nol berada di posisi lain. Akibatnya grafik terlihat tidak mengikuti data.
  const width = 760;
  const top = 10;
  const bottom = 186;
  const x = (index) => values.length === 1 ? width / 2 : (index / (values.length - 1)) * width;
  const y = (value) => bottom - (value / scaleMax) * (bottom - top);
  const coordinates = values.map((value, index) => [x(index), y(value)]);
  const line = coordinates.map(([pointX, pointY], index) => `${index ? 'L' : 'M'}${pointX.toFixed(1)},${pointY.toFixed(1)}`).join(' ');
  const area = `${line} L${coordinates.at(-1)[0].toFixed(1)},${bottom} L${coordinates[0][0].toFixed(1)},${bottom} Z`;
  $('#linePath').setAttribute('d', line);
  $('#areaPath').setAttribute('d', area);
  const last = coordinates.at(-1);
  $('#chartDot').setAttribute('cx', last[0].toFixed(1));
  $('#chartDot').setAttribute('cy', last[1].toFixed(1));
  $('#chartDot').setAttribute('visibility', 'visible');
  yAxis.innerHTML = [scaleMax, scaleMax * .75, scaleMax * .5, scaleMax * .25, 0].map((value) => `<span>${decimal.format(value)}</span>`).join('');

  const labelCount = Math.min(chart.period === 'daily' ? 7 : 6, chart.points.length);
  const labelIndexes = Array.from({ length: labelCount }, (_, index) => Math.round(index * (chart.points.length - 1) / Math.max(1, labelCount - 1)));
  xAxis.innerHTML = labelIndexes.map((index) => `<span>${formatChartLabel(chart.points[index].label, chart.period)}</span>`).join('');
}

async function loadChart() {
  const date = dashboardPayload?.date || localDateKey();
  // Grafik adalah bagian dashboard, jadi selalu memakai tanggal hari ini,
  // bukan tanggal awal dari rentang yang sedang ditampilkan di Riwayat.
  if (chartPeriod === 'daily' && dashboardPayload?.date === date) {
    renderEnergyChart({
      period: 'daily',
      label: `Produksi energi per jam · ${date}`,
      points: Array.from({ length: 24 }, (_, hour) => ({
        label: `${String(hour).padStart(2, '0')}:00`,
        value: dashboardPayload.readings
          .filter((reading) => Number(reading.timestamp.slice(11, 13)) === hour)
          .reduce((sum, reading) => sum + (Number(reading.energyKwh) || 0), 0),
      })),
    });
    return;
  }
  const response = await fetch(`/api/readings/chart?period=${chartPeriod}&date=${encodeURIComponent(date)}`);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || 'Gagal mengambil data grafik');
  }
  renderEnergyChart(await response.json());
}

function renderHistory(readings, totals) {
  if (!readings.length) {
    $('#historyRows').innerHTML = '<tr><td colspan="8" class="history-error">Belum ada data sensor untuk rentang tanggal yang dipilih.</td></tr>';
    setText('#historyDescription', 'Tidak ada pembacaan pada tanggal yang dipilih');
    ['#summaryEnergy', '#summaryRevenue', '#summaryPower', '#summaryTemperature', '#summaryReadings'].forEach((selector) => setText(selector, '—'));
    return;
  }
  const range = latestPayload?.range;
  setText('#historyDescription', range && range.start !== range.end
    ? `${readings.length} pembacaan sensor dari ${range.start} sampai ${range.end}`
    : `${readings.length} pembacaan sensor pada tanggal yang dipilih`);
  $('#historyRows').innerHTML = readings.map((reading) => `<tr><td>${escapeHtml(reading.timestamp.slice(0, 10))}</td><td>${escapeHtml(timeOf(reading.timestamp))}</td><td>${numberOrDash(reading.temperature, ' °C')}</td><td>${numberOrDash(reading.powerKw, ' kW')}</td><td>${numberOrDash(reading.energyKwh, ' kWh')}</td><td>${numberOrDash(reading.voltage, ' V')}</td><td>${numberOrDash(reading.current, ' A')}</td><td>Rp${rupiah.format(Number(reading.energyKwh || 0) * tariffPerKwh)}</td></tr>`).join('');
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
  const dailyRevenue = energy * tariffPerKwh;
  setText('#dailyRevenue', rupiah.format(dailyRevenue)); setText('#dailyEnergy', decimal.format(energy)); setText('#tariffLabel', formatTariff());
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

async function loadReadings() {
  try {
    const start = $('#historyDate').value;
    const end = $('#historyEndDate').value || start;
    const today = localDateKey();
    const [response, dashboardResponse] = await Promise.all([
      fetch(`/api/readings/range?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`),
      fetch(`/api/readings?date=${encodeURIComponent(today)}`),
    ]);
    if (!response.ok || !dashboardResponse.ok) {
      const payload = await (response.ok ? dashboardResponse : response).json().catch(() => ({}));
      throw new Error(payload.error || 'Gagal mengambil data sensor');
    }
    const payload = await response.json();
    dashboardPayload = await dashboardResponse.json();
    latestPayload = payload;
    tariffPerKwh = payload.summary.tariff.rate;
    renderHistory(payload.readings, payload.summary);
    tariffPerKwh = dashboardPayload.summary.tariff.rate;
    updateDashboard(dashboardPayload.readings, dashboardPayload.summary, dashboardPayload);
    await loadChart();
  } catch (error) { $('#historyRows').innerHTML = `<tr><td colspan="8" class="history-error"></td></tr>`; setText('.history-error', error.message === 'Failed to fetch' ? 'Server belum berjalan. Jalankan node server.js lalu muat ulang halaman.' : error.message); }
}

$('.menu-button').addEventListener('click', () => $('.sidebar').classList.toggle('open'));
document.querySelectorAll('.nav-item').forEach((link) => link.addEventListener('click', () => $('.sidebar').classList.remove('open')));
document.querySelectorAll('.chart-tabs button').forEach((button) => button.addEventListener('click', async () => {
  if (button.classList.contains('active')) return;
  $('.chart-tabs .active').classList.remove('active');
  button.classList.add('active');
  chartPeriod = button.dataset.period;
  setText('#chartSubtitle', 'Memuat data grafik…');
  try {
    await loadChart();
  } catch (error) {
    console.error(error);
    setText('#chartSubtitle', error.message || 'Gagal memuat data grafik');
  }
}));
$('#historyDate').value = localDateKey();
$('#historyEndDate').value = $('#historyDate').value;
$('#historyDate').addEventListener('change', () => {
  if ($('#historyEndDate').value < $('#historyDate').value) $('#historyEndDate').value = $('#historyDate').value;
  loadReadings();
});
$('#historyEndDate').addEventListener('change', () => {
  if ($('#historyEndDate').value < $('#historyDate').value) $('#historyEndDate').value = $('#historyDate').value;
  loadReadings();
});
$('#exportHistory').addEventListener('click', async () => {
  const start = $('#historyDate').value;
  const end = $('#historyEndDate').value;
  if (!start || !end || start > end) return window.alert('Pilih rentang tanggal yang valid.');
  const button = $('#exportHistory');
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = 'Menyiapkan Excel…';
  try {
    const response = await fetch(`/api/readings/export?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`, { credentials: 'same-origin' });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || 'Gagal mengunduh Excel.');
    }
    const blob = await response.blob();
    const downloadUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = downloadUrl;
    link.download = `riwayat-plts-${start}-sd-${end}.xls`;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
  } catch (error) {
    window.alert(error.message === 'Failed to fetch' ? 'Tidak dapat terhubung ke server.' : error.message);
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
  }
});
$('#logoutButton').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login.html';
});
loadReadings(); setInterval(loadReadings, 30000);
