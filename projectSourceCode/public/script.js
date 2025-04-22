let chart;
let interval;
let historicalData = [];

function displayStockInfo(data) {
  const infoBox = document.getElementById("stockInfoBox");
  if (!data) return infoBox.innerHTML = '';

  infoBox.innerHTML = `
    <h3>${data.name} (${data.ticker})</h3>
    <ul>
      <li><strong>Current Price:</strong> $${data.price?.toFixed(2) || 'N/A'}</li>
      <li><strong>Previous Close:</strong> $${data.previousClose?.toFixed(2) || 'N/A'}</li>
      <li><strong>Open:</strong> $${data.open?.toFixed(2) || 'N/A'}</li>
      <li><strong>High today:</strong> $${data.dayHigh?.toFixed(2) || 'N/A'}</li>
      <li><strong>Low today:</strong> $${data.dayLow?.toFixed(2) || 'N/A'}</li>
      <li><strong>52 Week High:</strong> $${data.yearHigh?.toFixed(2) || 'N/A'}</li>
      <li><strong>52 Week Low:</strong> $${data.yearLow?.toFixed(2) || 'N/A'}</li>
      <li><strong>Day Range:</strong> $${(data.dayHigh - data.dayLow).toFixed(2) || 'N/A'}</li>
      <li><strong>52 Week Range:</strong> $${(data.yearHigh - data.yearLow).toFixed(2) || 'N/A'}</li>
      <li><strong>Volume:</strong> ${data.volume?.toLocaleString() || 'N/A'}</li>
      <li><strong>Market Cap:</strong> $${formatMarketCap(data.marketCap) || 'N/A'}</li>
    </ul>
  `;
}

function formatMarketCap(num) {
  if (!num || isNaN(num)) return "N/A";
  if (num >= 1e12) return (num / 1e12).toFixed(2) + "T";
  if (num >= 1e9) return (num / 1e9).toFixed(2) + "B";
  if (num >= 1e6) return (num / 1e6).toFixed(2) + "M";
  if (num >= 1e3) return (num / 1e3).toFixed(2) + "K";
  return num.toString();
}

function simulateChart(period) {
  if (period == undefined){
    period = '1d';
  }

  //highlight selected period
  document.querySelectorAll('#periodButtons button').forEach(btn => {
    btn.classList.remove('active-period');
  });
  const activeBtn = document.querySelector(`#periodButtons button[data-period="${period}"]`);
  if (activeBtn) activeBtn.classList.add('active-period');

  clearInterval(interval);
  historicalData = [];

  const ticker = getTicker();
  if (!ticker) return;

  //setText("currentPrice", `Fetching history for ${ticker}...`);
  
  fetch(`/api/history?ticker=${ticker}&period=${period}`)
    .then(res => res.json())
    .then(data => {
      if (!data || data.length === 0) throw new Error("No data returned");

      historicalData = data;

      const labels = data.map(p => p.time);
      const prices = data.map(p => p.price);
      const [min, max] = getMinMax(prices);
      const buffer = (max - min) * 0.03;

      const fullDate = new Date(data[0].time).toLocaleDateString();
      setText("chartDate", `Data for: ${fullDate}`);

      const latest = data.at(-1);

      fetch(`/api/stock?ticker=${ticker}&live=true`)
        .then(res => res.json())
        .then(stockData => {
          const stock = stockData[0];
          if (!stock || stock.price == null) return;

          const change = latest.price - prices[0];
          const changePercent = (change / prices[0]) * 100;
          const changeClass = change >= 0 ? 'change-positive' : 'change-negative';

          setText("currentPrice", `
            <div class="stock-header">
              <div class="stock-name">${stock.name} (${stock.ticker})</div>
              <div class="stock-price">$${latest.price.toFixed(2)}</div>
              <div class="stock-change ${changeClass}">
                ${change >= 0 ? '+' : '-'}$${Math.abs(change).toFixed(2)} (${changePercent.toFixed(2)}%)
              </div>
              <div class="stock-time">@ ${formatTime(latest.time)}</div>
            </div>
          `);

          displayStockInfo(stock);
        })
        .catch(err => {
          console.error("Info fetch failed", err);
        });
      
      const color = latest.price > prices[0] ? 'rgba(10, 167, 41, 0.8)' : 'rgba(255, 32, 0, 0.77)'; // check if curent price > first price on chart
      createChart(ticker, labels, prices, min - buffer, max + buffer, color);

      fetch(`/api/stock?ticker=${ticker}&live=true`)
        .then(res => res.json())
        .then(data => displayStockInfo(data[0]))
        .catch(err => console.error("Info fetch failed", err));
    })
    .catch(err => setText("currentPrice", `Error: ${err.message}`));
}

function simulateDay(){
  if (isMarketClosed()){
    simulateChart('1d');
  } else {
    startLiveChart();
  }
}

function startLiveChart() {
  if (isMarketClosed()) {
    alert("Market is closed. Please try again during market hours.");
    return;
  }

  document.querySelectorAll('#periodButtons button').forEach(btn => {
    btn.classList.remove('active-period');
  });
  const liveBtn = document.querySelector('#periodButtons button[data-period="1d"]');
  if (liveBtn) liveBtn.classList.add('active-period');

  clearInterval(interval);
  historicalData = [];

  const ticker = getTicker();
  if (!ticker) return;

  //setText("currentPrice", `Starting live updates for ${ticker}...`);
  setText("chartDate", "Live Mode");

  const ctx = document.getElementById("stockChart").getContext("2d");
  if (chart) chart.destroy();

  fetch(`/api/history?ticker=${ticker}&period=1d&interval=1m`)
    .then(res => res.json())
    .then(data => {
      if (!data || data.length === 0) throw new Error("No data returned");

      const labels = data.map(p => p.time);
      const prices = data.map(p => p.price);
      const [min, max] = getMinMax(prices);
      const buffer = (max - min) * 0.03;

      const latest = data.at(-1);
      const newColor = latest.price >= latest.open
        ? 'rgba(10, 167, 41, 0.8)'
        : 'rgba(255, 32, 0, 0.77)';

      chart = new Chart(ctx, getChartConfig(ticker, labels, prices, min - buffer, max + buffer, newColor));
      historicalData = prices;

      fetchAndUpdateLiveData(ticker); // initial fetch
      interval = setInterval(() => fetchAndUpdateLiveData(ticker), 1000); // keep repeating
    })
    .catch(err => {
      setText("currentPrice", `Error: ${err.message}`);
    });
}

let updateCounter = 0;

function fetchAndUpdateLiveData(ticker) {
  fetch(`/api/stock?ticker=${ticker}&live=true`)
    .then(res => res.json())
    .then(data => {
      const stock = data[0];
      if (!stock || stock.price == null) return;

      const now = new Date();
      const price = parseFloat(stock.price);

      // only update the chart every 10 seconds
      if (updateCounter % 10 === 0) {
        chart.data.labels.push(now.toISOString());
        chart.data.datasets[0].data.push(price);

        const newColor = price >= stock.open
          ? 'rgba(10, 167, 41, 0.8)'
          : 'rgba(255, 32, 0, 0.77)';
        chart.data.datasets[0].borderColor = newColor;

        const [min, max] = getMinMax(chart.data.datasets[0].data);
        const buffer = (max - min) * 0.03;
        chart.options.scales.y.min = min - buffer;
        chart.options.scales.y.max = max + buffer;

        chart.update();
      }

      updateCounter++;

      const firstPrice = chart.data.datasets[0].data[0];
      const change = price - firstPrice;
      const changePercent = (change / firstPrice) * 100;
      const changeClass = change >= 0 ? 'change-positive' : 'change-negative';

      setText("currentPrice", `
        <div class="stock-header">
          <div class="stock-name">${stock.name} (${stock.ticker})</div>
          <div class="stock-price">$${price.toFixed(2)}</div>
          <div class="stock-change ${changeClass}">
            ${change >= 0 ? '+' : '-'}$${Math.abs(change).toFixed(2)} (${changePercent.toFixed(2)}%)
          </div>
          <div class="stock-time">@ ${formatTime(now)}</div>
        </div>
      `);      

      displayStockInfo(stock);
    });
}

function isMarketClosed() {
  const now = new Date();

  // Convert to EST
  const now_est = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));

  const day = now_est.getDay();
  const hour = now_est.getHours();
  const minute = now_est.getMinutes();

  //market is open mon-fri, 930am to 4pm *EST*
  const isWeekend = day === 0 || day === 6;
  const beforeOpen = hour < 9 || (hour === 9 && minute < 30);
  const afterClose = hour > 16 || (hour === 16 && minute > 0);

  return isWeekend || beforeOpen || afterClose;
}

function getTicker() {
  const urlParams = new URLSearchParams(window.location.search);
  const symbol = urlParams.get('symbol');
  if (!symbol) {
    alert("No ticker provided in URL.");
    return null;
  }
  return symbol.toUpperCase();
}

function getValue(id) {
  return document.getElementById(id).value;
}

function setText(id, text) {
  document.getElementById(id).innerHTML = `<strong>${text}</strong>`;
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function getMinMax(data) {
  return [Math.min(...data), Math.max(...data)];
}

function createChart(ticker, labels, data, yMin, yMax, color = 'gray') {
  const ctx = document.getElementById("stockChart").getContext("2d");
  if (chart) chart.destroy();
  chart = new Chart(ctx, getChartConfig(ticker, labels, data, yMin, yMax, color));
}

function getChartConfig(ticker, labels, data, yMin, yMax, color='blue') {
  return {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: ticker,
        data,
        borderColor: color,
        borderWidth: 1.5,
        fill: false,
        tension: 0.2,
        pointRadius: 0.5,
        pointHoverRadius: 4
      }]
    },
    options: {
      animation: false,
      animations: false,
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
            return label.length > maxLength ? label.substring(16, maxLength) : label;
            }
          },
        },
        y: {
          min: yMin,
          max: yMax,
          title: { display: true, text: "Price (USD)" }
        }
      },
      plugins: {
        legend: { display: true },
        zoom: {
          pan: { enabled: true, mode: 'x', modifierKey: null },
          zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: 'x' }
        }
      }
    }
  };
}
