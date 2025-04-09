let chart;
let interval;
let historicalData = [];

function simulateChart() {
  clearInterval(interval);
  historicalData = [];

  const ticker = getTicker();
  if (!ticker) return;

  const period = getValue("periodSelect");
  const intervalVal = getValue("intervalSelect");

  setText("currentPrice", `Fetching history for ${ticker}...`);

  fetch(`/api/history?ticker=${ticker}&period=${period}&interval=${intervalVal}`)
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

      createChart(ticker, labels, prices, min - buffer, max + buffer);

      const latest = data.at(-1);
      setText("currentPrice", `${ticker}: $${latest.price.toFixed(2)} @ ${formatTime(latest.time)}`);
    })
    .catch(err => setText("currentPrice", `Error: ${err.message}`));
}

function startLiveChart() {
  clearInterval(interval);
  historicalData = [];

  const ticker = getTicker();
  if (!ticker) return;

  setText("currentPrice", `Starting live updates for ${ticker}...`);
  setText("chartDate", "Live Mode");

  const ctx = document.getElementById("stockChart").getContext("2d");
  if (chart) chart.destroy();

  chart = new Chart(ctx, getChartConfig(ticker, [], [], null, null));

  interval = setInterval(() => {
    fetch(`/api/stock?ticker=${ticker}`)
      .then(res => res.json())
      .then(data => {
        const stock = data[0];
        if (!stock || !stock.price) return;

        const now = new Date();
        chart.data.labels.push(now.toISOString());
        chart.data.datasets[0].data.push(stock.price);

        const [min, max] = getMinMax(chart.data.datasets[0].data);
        const buffer = (max - min) * 0.03;
        chart.options.scales.y.min = min - buffer;
        chart.options.scales.y.max = max + buffer;

        chart.update();

        setText("currentPrice", `${stock.name} (${stock.ticker}): $${stock.price.toFixed(2)} @ ${formatTime(now)}`);
      });
  }, 1000);
}

function getTicker() {
  const val = getValue("tickerInput").toUpperCase();
  if (!val) alert("Enter a valid ticker.");
  return val;
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

function createChart(ticker, labels, data, yMin, yMax) {
  const ctx = document.getElementById("stockChart").getContext("2d");
  if (chart) chart.destroy();
  chart = new Chart(ctx, getChartConfig(ticker, labels, data, yMin, yMax));
}

function getChartConfig(ticker, labels, data, yMin, yMax) {
  return {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: ticker,
        data,
        borderWidth: 2,
        fill: false,
        tension: 0.2,
        pointRadius: 2,
        pointHoverRadius: 4
      }]
    },
    options: {
      animation: false,
      animations: {
        tension: { duration: 0 },
        x: { duration: 0 },
        y: { duration: 0 }
      },
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          title: { display: true, text: "Time" },
          ticks: {
            maxTicksLimit: 20,
            callback: (value) => {
              const fullTime = value;
              return new Date(fullTime).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit'
              });
            }
          }
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
