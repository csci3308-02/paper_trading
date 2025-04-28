// ==== Persistence via localStorage ====
const STORAGE_KEY = 'myChartsSymbols';

function getSymbols() {
  let arr = JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  if (!arr.length) {
    arr = ['AAPL'];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(arr));
  }
  return arr;
}

function saveSymbols(arr) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(arr));
}

// ==== DOM refs & template ====
const container    = document.getElementById('chartsContainer');
const templateHTML = document.getElementById('chartTemplate').innerHTML;
const chartsMap    = new Map();

// ==== Initialize on page load + Add-Chart wiring ====
document.addEventListener('DOMContentLoaded', () => {
  initDashboard();
  const addBtn = document.getElementById('addChartBtn');
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      const arr = getSymbols();
      arr.push('');
      saveSymbols(arr);
      initDashboard();
    });
  }
});

function initDashboard() {
  container.innerHTML = '';
  chartsMap.clear();
  getSymbols().forEach((sym, idx) => createInstance(sym, idx));
}

// ==== Create one chart instance ====
function createInstance(symbol, id) {
  const html = templateHTML
    .replace(/__ID__/g, id)
    .replace(/__SYM__/g, symbol);
  const wrapper = document.createElement('div');
  wrapper.innerHTML = html;
  const el = wrapper.firstElementChild;
  container.appendChild(el);

  // search button
  el.querySelector('.chart-search-btn').onclick = () => {
    const input = el.querySelector('.chart-search');
    const newSym = input.value.trim().toUpperCase();
    if (!newSym) return;
    const arr = getSymbols();
    arr[id] = newSym;
    saveSymbols(arr);
    el.querySelector('.chart-title').textContent = newSym;
    simulateInstance(id, newSym);
  };

  // delete button
  el.querySelector('.chart-delete-btn').onclick = () => {
    let arr = getSymbols();
    if (arr.length <= 1) return;  // never delete last chart
    arr.splice(id, 1);
    saveSymbols(arr);
    initDashboard();
  };

  // period buttons
  el.querySelectorAll(`#periodButtons-${id} button[data-period]`)
    .forEach(btn => btn.onclick = () => {
      simulateInstance(id, getSymbols()[id], btn.dataset.period);
    });

  // reset zoom
  el.querySelector('.reset-zoom-btn').onclick = () => {
    const ch = chartsMap.get(id);
    if (ch) ch.resetZoom();
  };

  // first render
  simulateInstance(id, symbol);
}

// ==== Per-chart logic with zoom & dynamic color ====
function simulateInstance(id, symbol, period = '1d') {
  const priceEl = document.getElementById(`currentPrice-${id}`);
  const dateEl  = document.getElementById(`chartDate-${id}`);
  const infoEl  = document.getElementById(`stockInfoBox-${id}`);
  const ctx     = document.getElementById(`stockChart-${id}`).getContext('2d');

  // highlight active period
  document
    .querySelectorAll(`.chart-item[data-id="${id}"] .active-period`)
    .forEach(b => b.classList.remove('active-period'));
  const actBtn = document.querySelector(
    `.chart-item[data-id="${id}"] button[data-period="${period}"]`
  );
  if (actBtn) actBtn.classList.add('active-period');

  // fetch historical data
  fetch(`/api/history?ticker=${symbol}&period=${period}`)
    .then(r => r.json())
    .then(data => {
      if (!Array.isArray(data) || data.length === 0) {
        throw new Error('No history data');
      }
      const labels = data.map(p => p.time);
      const prices = data.map(p => p.price);

      // determine color by period performance
      const firstPrice = prices[0];
      const lastPrice  = prices[prices.length - 1];
      const trendColor = (lastPrice >= firstPrice) ? 'lime' : 'red';

      const [min, max] = [Math.min(...prices), Math.max(...prices)];
      const buf = (max - min) * 0.03;
      dateEl.textContent = `Data for: ${new Date(data[0].time).toLocaleDateString()}`;

      // fetch live stock details
      fetch(`/api/stock?ticker=${symbol}&live=true`)
        .then(r => r.json())
        .then(arr => {
          const s = arr[0] || {};
          priceEl.innerHTML = `
            <div style="font-size:1.5rem; font-weight:bold;">
              ${s.name} (${s.ticker})
            </div>
            <div style="font-size:1.25rem; color:${trendColor};">
              $${(lastPrice).toFixed(2)}
            </div>`;
          displayStockInfoInstance(id, s);
        })
        .catch(() => {
          priceEl.textContent = 'Info unavailable';
          infoEl.innerHTML = '';
        });

      // render or update chart with dynamic color
      if (chartsMap.has(id)) {
        const ch = chartsMap.get(id);
        ch.data.labels = labels;
        ch.data.datasets[0].data = prices;
        ch.data.datasets[0].borderColor = trendColor;
        ch.options.scales.y.min = min - buf;
        ch.options.scales.y.max = max + buf;
        ch.update();
      } else {
        const cfg = {
          type: 'line',
          data: {
            labels,
            datasets: [{
              label: symbol,
              data: prices,
              borderColor: trendColor,
              borderWidth: 1.5,
              fill: false,
              pointRadius: 0.5,
              pointHoverRadius: 4
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
              x: {
                title: { display: true, text: "Time" },
                ticks: {
                  maxTicksLimit: 12,
                  callback: function(value, index, ticks) {
                    const maxLength = 11;
                    let label = this.getLabelForValue(value);
                    return label.length > maxLength
                      ? label.substring(16, maxLength)
                      : label;
                  }
                },
              },
              y: {
                title: { display: true, text: 'Price (USD)' },
                min: min - buf,
                max: max + buf
              }
            },
            plugins: {
              zoom: {
                pan: { enabled: true, mode: 'x' },
                zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: 'x' }
              }
            }
          }
        };
        const ch = new Chart(ctx, cfg);
        chartsMap.set(id, ch);
      }
    })
    .catch(e => {
      priceEl.textContent = `Error: ${e.message}`;
    });
}

// ==== Side panel renderer ====
function displayStockInfoInstance(id, data) {
  const box = document.getElementById(`stockInfoBox-${id}`);
  if (!data) { box.innerHTML = ''; return; }
  box.innerHTML = `
    <h4>${data.name} (${data.ticker})</h4>
    <ul>
      <li><strong>Current Price:</strong> $${(data.price || 0).toFixed(2)}</li>
      <li><strong>Previous Close:</strong> $${(data.previousClose || 0).toFixed(2)}</li>
      <li><strong>Open:</strong> $${(data.open || 0).toFixed(2)}</li>
      <li><strong>High Today:</strong> $${(data.dayHigh || 0).toFixed(2)}</li>
      <li><strong>Low Today:</strong> $${(data.dayLow || 0).toFixed(2)}</li>
      <li><strong>52W High:</strong> $${(data.yearHigh || 0).toFixed(2)}</li>
      <li><strong>52W Low:</strong> $${(data.yearLow || 0).toFixed(2)}</li>
      <li><strong>Volume:</strong> ${(data.volume || 0).toLocaleString()}</li>
      <li><strong>Market Cap:</strong> ${formatMarketCap(data.marketCap)}</li>
    </ul>`;
}

// ==== Market cap helper ====
function formatMarketCap(n) {
  if (!n || isNaN(n)) return 'N/A';
  if (n >= 1e12) return (n / 1e12).toFixed(2) + 'T';
  if (n >= 1e9)  return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6)  return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3)  return (n / 1e3).toFixed(2) + 'K';
  return n.toString();
}
