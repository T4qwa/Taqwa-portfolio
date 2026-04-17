/* =============================================================
   Taqwa Naseeb — Portfolio
   Client-side logic: tabs, CSV parsing, filtering, all charts,
   NLP keyword analysis, and FAQ interactions.
   ============================================================= */

/* =============================================================
   1. TAB SWITCHING
   ============================================================= */
const tabs = document.querySelectorAll('.tab');
const panels = document.querySelectorAll('.panel');

tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.tab;

    tabs.forEach(t => {
      t.classList.toggle('active', t === tab);
      t.setAttribute('aria-selected', t === tab);
    });
    panels.forEach(p => p.classList.toggle('active', p.id === target));

    // Plotly needs a resize nudge when a hidden chart becomes visible
    setTimeout(() => {
      document.querySelectorAll(`#${target} .chart`).forEach(el => {
        if (el._fullLayout) Plotly.Plots.resize(el);
      });
    }, 50);
  });
});

/* =============================================================
   2. SHARED PLOTLY CONFIG (matches "presentation" template feel)
   ============================================================= */
const PLOT_CONFIG = { responsive: true, displayModeBar: false };

const PLOT_LAYOUT_BASE = {
  font: { family: 'Manrope, sans-serif', color: '#2a1a2e', size: 13 },
  paper_bgcolor: 'rgba(0,0,0,0)',
  plot_bgcolor: 'rgba(253,246,241,0.4)',
  title: { font: { family: 'Fraunces, serif', size: 18, color: '#4a2c4a' }, x: 0.5 },
  margin: { t: 60, r: 30, b: 60, l: 70 },
  legend: { bgcolor: 'rgba(255,255,255,0.6)', bordercolor: '#e8d5c7', borderwidth: 1 },
};

// Sector color palette (stable across the scatter and box plots)
const SECTOR_PALETTE = [
  '#c2185b', '#e8a87c', '#85c1a8', '#6a8eae', '#d4a5a5',
  '#9b7baa', '#e4b363', '#5d8aa8', '#c490b5', '#7a9b76',
  '#b8697a', '#a4907c',
];
const sectorColorMap = new Map();
function colorFor(sector) {
  if (!sectorColorMap.has(sector)) {
    sectorColorMap.set(sector, SECTOR_PALETTE[sectorColorMap.size % SECTOR_PALETTE.length]);
  }
  return sectorColorMap.get(sector);
}

/* =============================================================
   3. CSV LOADING + PARSING
   Mirrors the notebook's pandas step: read CSV, drop NaNs,
   filter outliers (AvgCost_of_Debt < 5), compute %.
   ============================================================= */
const CSV_URL = 'https://gist.githubusercontent.com/DrAYim/80393243abdbb4bfe3b45fef58e8d3c8/raw/ed5cfd9f210bf80cb59a5f420bf8f2b88a9c2dcd/sp500_ZScore_AvgCostofDebt.csv';

function parseCSV(text) {
  // Lightweight CSV parser that handles quoted fields with commas.
  const rows = [];
  let field = '', row = [], inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { field += c; }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* skip */ }
      else { field += c; }
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }

  const headers = rows.shift().map(h => h.trim());
  return rows
    .filter(r => r.length === headers.length)
    .map(r => {
      const obj = {};
      headers.forEach((h, i) => {
        const v = r[i];
        const n = Number(v);
        obj[h] = (v === '' || Number.isNaN(n)) ? v : n;
      });
      return obj;
    });
}

let allData = [];
let allSectors = [];
let selectedSectors = new Set();

async function loadData() {
  const statusEl = document.getElementById('data-status');
  const controlsEl = document.getElementById('controls');
  try {
    const res = await fetch(CSV_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const parsed = parseCSV(text);

    // Mirror the notebook's cleaning: drop NaNs in key columns, filter extremes,
    // add % and market-cap-in-billions columns.
    allData = parsed.filter(r =>
      typeof r.AvgCost_of_Debt === 'number' &&
      typeof r.Z_Score_lag === 'number' &&
      r.Sector_Key &&
      r.AvgCost_of_Debt < 5
    ).map(r => ({
      ...r,
      Debt_Cost_Percent: r.AvgCost_of_Debt * 100,
      Market_Cap_B: (typeof r.Market_Cap === 'number') ? r.Market_Cap / 1e9 : 0,
    }));

    allSectors = [...new Set(allData.map(r => r.Sector_Key))].sort();
    // Default: first 3 sectors selected (matches the notebook)
    selectedSectors = new Set(allSectors.slice(0, 3));

    statusEl.hidden = true;
    controlsEl.hidden = false;

    buildSectorChips();
    updateCharts();
  } catch (err) {
    statusEl.textContent = `⚠️ Could not load dataset (${err.message}). Please check your internet connection.`;
    statusEl.style.color = '#c2185b';
    console.error(err);
  }
}

/* =============================================================
   4. UI CONTROLS — sector chips + slider
   ============================================================= */
function buildSectorChips() {
  const container = document.getElementById('sector-chips');
  container.innerHTML = '';
  allSectors.forEach(sector => {
    const chip = document.createElement('button');
    chip.className = 'sector-chip' + (selectedSectors.has(sector) ? ' active' : '');
    chip.textContent = sector;
    chip.addEventListener('click', () => {
      if (selectedSectors.has(sector)) selectedSectors.delete(sector);
      else selectedSectors.add(sector);
      chip.classList.toggle('active');
      updateCharts();
    });
    container.appendChild(chip);
  });
}

const capSlider = document.getElementById('cap-slider');
const capValue = document.getElementById('cap-value');

capSlider.addEventListener('input', () => {
  capValue.textContent = `$${capSlider.value}B`;
  updateCharts();
});

/* =============================================================
   5. FILTER LOGIC (reactive — like the notebook cell)
   ============================================================= */
function getFiltered() {
  const minCap = Number(capSlider.value);
  return allData.filter(r =>
    selectedSectors.has(r.Sector_Key) &&
    r.Market_Cap_B >= minCap
  );
}

/* =============================================================
   6. CHARTS
   ============================================================= */
function renderScatter(filtered) {
  const grouped = new Map();
  filtered.forEach(r => {
    if (!grouped.has(r.Sector_Key)) grouped.set(r.Sector_Key, []);
    grouped.get(r.Sector_Key).push(r);
  });

  // Bubble size: scale Market_Cap_B into a reasonable px range
  const maxCap = Math.max(1, ...filtered.map(r => r.Market_Cap_B));
  const sizeRef = (2 * maxCap) / (40 * 40); // Plotly's recommended sizeref formula

  const traces = [...grouped.entries()].map(([sector, rows]) => ({
    type: 'scatter',
    mode: 'markers',
    name: sector,
    x: rows.map(r => r.Z_Score_lag),
    y: rows.map(r => r.Debt_Cost_Percent),
    text: rows.map(r => r.Name || ''),
    customdata: rows.map(r => r.Market_Cap_B.toFixed(1)),
    hovertemplate:
      '<b>%{text}</b><br>' +
      'Z-Score: %{x:.2f}<br>' +
      'Cost of Debt: %{y:.2f}%<br>' +
      'Market Cap: $%{customdata}B<extra>' + sector + '</extra>',
    marker: {
      color: colorFor(sector),
      size: rows.map(r => Math.max(4, r.Market_Cap_B)),
      sizemode: 'area',
      sizeref: sizeRef,
      sizemin: 4,
      line: { width: 0.5, color: 'rgba(42,26,46,0.25)' },
      opacity: 0.75,
    },
  }));

  // Regression line (over rows with Debt_Cost_Percent < 5 — mirrors notebook)
  const forReg = filtered.filter(r => r.Debt_Cost_Percent < 5);
  if (forReg.length > 1) {
    const { slope, intercept, xMin, xMax } = linearFit(
      forReg.map(r => r.Z_Score_lag),
      forReg.map(r => r.Debt_Cost_Percent)
    );
    const xs = [];
    const ys = [];
    const steps = 50;
    for (let i = 0; i <= steps; i++) {
      const x = xMin + (xMax - xMin) * i / steps;
      xs.push(x);
      ys.push(intercept + slope * x);
    }
    traces.push({
      type: 'scatter', mode: 'lines', name: 'Trend',
      x: xs, y: ys,
      line: { color: 'rgba(42,26,46,0.6)', width: 1, dash: 'dot' },
      hoverinfo: 'skip', showlegend: true,
    });
  }

  const layout = {
    ...PLOT_LAYOUT_BASE,
    title: { ...PLOT_LAYOUT_BASE.title, text: `Cost of Debt vs. Z-Score (${filtered.length} observations)` },
    xaxis: { title: 'Altman Z-Score (lagged)', gridcolor: '#e8d5c7', zerolinecolor: '#e8d5c7' },
    yaxis: { title: 'Avg. Cost of Debt (%)', gridcolor: '#e8d5c7', zerolinecolor: '#e8d5c7' },
    shapes: [
      // Distress threshold (Z = 1.81)
      { type: 'line', x0: 1.81, x1: 1.81, yref: 'paper', y0: 0, y1: 1,
        line: { color: '#c2185b', width: 1.5, dash: 'dash' } },
      // Safe threshold (Z = 2.99)
      { type: 'line', x0: 2.99, x1: 2.99, yref: 'paper', y0: 0, y1: 1,
        line: { color: '#2e7d32', width: 1.5, dash: 'dash' } },
    ],
    annotations: [
      { x: 1.81, xref: 'x', y: 1.05, yref: 'paper', text: 'Distress (Z=1.81)',
        showarrow: false, font: { color: '#c2185b', size: 11 }, xanchor: 'right' },
      { x: 2.99, xref: 'x', y: 1.05, yref: 'paper', text: 'Safe (Z=2.99)',
        showarrow: false, font: { color: '#2e7d32', size: 11 }, xanchor: 'left' },
    ],
    height: 520,
  };

  Plotly.react('chart-scatter', traces, layout, PLOT_CONFIG);
}

function renderBox(filtered) {
  const grouped = new Map();
  filtered.forEach(r => {
    if (!grouped.has(r.Sector_Key)) grouped.set(r.Sector_Key, []);
    grouped.get(r.Sector_Key).push(r.Debt_Cost_Percent);
  });

  const traces = [...grouped.entries()].map(([sector, values]) => ({
    type: 'box',
    name: sector,
    y: values,
    boxpoints: 'outliers',
    marker: { color: colorFor(sector), size: 4 },
    line: { width: 1.2 },
  }));

  const layout = {
    ...PLOT_LAYOUT_BASE,
    title: { ...PLOT_LAYOUT_BASE.title, text: 'Cost of Debt Distribution by Sector' },
    xaxis: { tickangle: -30, gridcolor: '#e8d5c7' },
    yaxis: { title: 'Avg. Cost of Debt (%)', range: [-0.5, 12], gridcolor: '#e8d5c7' },
    showlegend: false,
    margin: { t: 60, r: 30, b: 140, l: 70 },
    height: 480,
  };

  Plotly.react('chart-box', traces, layout, PLOT_CONFIG);
}

function linearFit(x, y) {
  const n = x.length;
  let sx = 0, sy = 0, sxy = 0, sxx = 0, xMin = Infinity, xMax = -Infinity;
  for (let i = 0; i < n; i++) {
    sx += x[i]; sy += y[i]; sxy += x[i] * y[i]; sxx += x[i] * x[i];
    if (x[i] < xMin) xMin = x[i];
    if (x[i] > xMax) xMax = x[i];
  }
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const intercept = (sy - slope * sx) / n;
  return { slope, intercept, xMin, xMax };
}

function updateCharts() {
  const filtered = getFiltered();
  document.getElementById('obs-count').textContent = filtered.length;
  if (filtered.length === 0) {
    Plotly.purge('chart-scatter');
    Plotly.purge('chart-box');
    document.getElementById('chart-scatter').innerHTML =
      '<p style="text-align:center;padding:3rem;color:#8a7a8c;font-style:italic;">No observations match the current filters. Select at least one sector.</p>';
    document.getElementById('chart-box').innerHTML = '';
    return;
  }
  renderScatter(filtered);
  renderBox(filtered);
}

/* =============================================================
   7. TRAVEL MAP
   ============================================================= */
const travelData = [
  { Country: 'Italy',        Lat: 41.9, Lon: 12.5, Year: '2021' },
  { Country: 'France',       Lat: 46.2, Lon:  2.2, Year: '2023' },
  { Country: 'Austria',      Lat: 47.5, Lon: 14.5, Year: '2024' },
  { Country: 'Egypt',        Lat: 26.8, Lon: 30.8, Year: '2022' },
  { Country: 'Pakistan',     Lat: 30.4, Lon: 69.3, Year: '2023' },
  { Country: 'Saudi Arabia', Lat: 23.9, Lon: 45.1, Year: '2021' },
];

function renderTravelMap() {
  const years = [...new Set(travelData.map(d => d.Year))].sort();
  const yearColors = ['#c2185b', '#e8a87c', '#6a8eae', '#85c1a8'];

  const traces = years.map((yr, i) => {
    const rows = travelData.filter(d => d.Year === yr);
    return {
      type: 'scattergeo',
      mode: 'markers',
      name: yr,
      lat: rows.map(r => r.Lat),
      lon: rows.map(r => r.Lon),
      text: rows.map(r => r.Country),
      hovertemplate: '<b>%{text}</b><br>Visited: ' + yr + '<extra></extra>',
      marker: { size: 14, color: yearColors[i % yearColors.length], line: { width: 1, color: '#fff' } },
    };
  });

  const layout = {
    ...PLOT_LAYOUT_BASE,
    title: { ...PLOT_LAYOUT_BASE.title, text: '🌍 My Travel Footprint' },
    geo: {
      projection: { type: 'natural earth' },
      showland: true, landcolor: '#faeae0',
      showocean: true, oceancolor: '#f4f1ee',
      showcountries: true, countrycolor: '#e8d5c7',
      bgcolor: 'rgba(0,0,0,0)',
    },
    legend: { ...PLOT_LAYOUT_BASE.legend, title: { text: 'Visit Year' } },
    height: 520,
  };

  Plotly.newPlot('chart-travel', traces, layout, PLOT_CONFIG);
}

/* =============================================================
   8. NLP — headlines + keyword frequency
   (Direct port of the notebook's regex + Counter logic)
   ============================================================= */
const headlines = [
  'Federal Reserve holds interest rates steady amid inflation concerns',
  'Apple reports record quarterly profits driven by iPhone sales',
  'Oil prices surge as OPEC announces production cuts',
  'UK economy faces recession risk as GDP growth slows',
  'Bitcoin reaches new highs as institutional investors pile in',
  'Amazon announces major layoffs in cloud computing division',
  'Bank of England raises interest rates to combat inflation',
  'Global supply chain disruptions hit manufacturing output',
  'Tesla reports declining profit margins due to price competition',
  'IMF warns of growing debt crisis in emerging markets',
  'Goldman Sachs cuts global growth forecast for 2025',
  'Nvidia profits soar as AI chip demand continues to rise',
  'Microsoft acquires gaming company in billion dollar deal',
  'UK inflation falls but remains above Bank of England target',
  'Pound strengthens against dollar after positive trade data',
];

const stopWords = new Set([
  'the','a','an','and','or','but','in','on','at','to','for','of',
  'with','is','are','was','were','be','has','have','that','this',
  'it','as','by','from','not','will','says','said','new','than',
  'up','out','after','over','its','their','into','amid','due',
]);

function renderHeadlines() {
  const list = document.getElementById('headlines-list');
  list.innerHTML = headlines.map(h => `<li>${h}</li>`).join('');
}

function renderNLPChart() {
  const text = headlines.join(' ').toLowerCase();
  const matches = text.match(/\b[a-z]{3,}\b/g) || [];
  const counts = {};
  matches.forEach(w => {
    if (!stopWords.has(w)) counts[w] = (counts[w] || 0) + 1;
  });
  const sorted = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .reverse(); // reverse so biggest sits at top of horizontal bars

  const trace = {
    type: 'bar',
    orientation: 'h',
    x: sorted.map(d => d[1]),
    y: sorted.map(d => d[0]),
    marker: {
      color: sorted.map(d => d[1]),
      colorscale: [[0, '#ffd6e8'], [1, '#4a2c4a']],
      line: { width: 0 },
    },
    hovertemplate: '<b>%{y}</b><br>Frequency: %{x}<extra></extra>',
  };

  const layout = {
    ...PLOT_LAYOUT_BASE,
    title: { ...PLOT_LAYOUT_BASE.title, text: '📊 Top Keywords in Financial News Headlines' },
    xaxis: { title: 'Frequency', gridcolor: '#e8d5c7' },
    yaxis: { title: null, gridcolor: '#e8d5c7' },
    margin: { t: 60, r: 40, b: 60, l: 140 },
    height: 500,
  };

  Plotly.newPlot('chart-nlp', [trace], layout, PLOT_CONFIG);
}

/* =============================================================
   9. FAQ (replaces the live Groq LLM call)
   Pre-generated answers using the same Llama-3.3-70B model
   referenced in the notebook. Styled as an expandable accordion.
   ============================================================= */
const faqItems = [
  {
    q: 'What is inflation?',
    a: 'Inflation is the rate at which the general level of prices for goods and services is rising, which reduces purchasing power over time. Central banks, such as the Bank of England or the Federal Reserve, typically target a moderate inflation rate (around 2%) to keep the economy stable. High inflation erodes savings and makes borrowing more expensive, while deflation can signal weak demand and stall growth. For an accounting and finance student, understanding inflation is key to analysing real vs. nominal returns and evaluating the true performance of investments.',
  },
  {
    q: 'What is the Altman Z-Score?',
    a: 'The Altman Z-Score is a financial model developed by Professor Edward Altman in 1968 to predict the probability of a company going bankrupt within two years. It combines five financial ratios (covering liquidity, profitability, leverage, solvency, and activity) into a single weighted score. A Z-Score above 2.99 suggests a company is in the "safe zone", between 1.81 and 2.99 is a "grey zone", and below 1.81 indicates "distress". This is exactly why the threshold lines appear on the Credit Risk Analyzer chart in the Passion Projects tab.',
  },
  {
    q: 'How does cost of debt relate to credit risk?',
    a: 'The cost of debt is the effective interest rate a company pays on its borrowings. Lenders demand higher interest rates from companies they perceive as riskier — so a higher cost of debt usually signals higher credit risk. This is the relationship visualised in my interactive scatter plot: as the Altman Z-Score decreases (moving towards distress), the cost of debt tends to rise. For finance students, this illustrates the fundamental risk-return trade-off in fixed-income markets.',
  },
  {
    q: 'What is the difference between accounting profit and economic profit?',
    a: 'Accounting profit is revenue minus explicit costs (wages, rent, materials) as recorded in financial statements. Economic profit goes further by also subtracting implicit costs — the opportunity cost of using resources in their next-best alternative use. A company can show a positive accounting profit but a negative economic profit if its owners could earn more by deploying their capital elsewhere. This distinction matters for investment decisions and for understanding true value creation.',
  },
  {
    q: 'What is a dividend and why do companies pay them?',
    a: "A dividend is a portion of a company's profits distributed to its shareholders, usually in cash. Companies pay dividends to reward investors and signal financial health and confidence in future earnings. However, not all companies pay dividends — growth companies often reinvest profits instead to fund expansion. For investors, dividends provide regular income and can be a sign of a mature, profitable business.",
  },
  {
    q: 'What does ESG mean in finance?',
    a: 'ESG stands for Environmental, Social, and Governance — a framework used to evaluate a company\'s ethical impact and sustainability practices alongside its financial performance. Investors increasingly use ESG criteria to identify companies that manage non-financial risks well, such as climate exposure, labour practices, and board accountability. Research suggests strong ESG scores can be linked to lower credit risk and more stable long-term returns, though methodologies for measuring ESG still vary across providers.',
  },
  {
    q: 'What is the time value of money?',
    a: 'The time value of money (TVM) is the principle that a pound today is worth more than a pound in the future, because today\'s money can be invested to earn interest. TVM is the foundation of discounted cash flow (DCF) analysis, bond pricing, and capital budgeting. Two key formulas are present value (PV = FV / (1+r)^n) and future value (FV = PV × (1+r)^n). Mastering TVM is essential for anyone studying finance, and it underpins almost every valuation model used in practice.',
  },
];

function renderFAQ() {
  const container = document.getElementById('faq-list');
  container.innerHTML = faqItems.map((item, i) => `
    <div class="faq-item" data-index="${i}">
      <button class="faq-question" aria-expanded="false">
        <span>${item.q}</span>
        <span class="faq-toggle">+</span>
      </button>
      <div class="faq-answer">
        <p>${item.a}</p>
        <span class="model-tag">Generated by Groq · llama-3.3-70b-versatile</span>
      </div>
    </div>
  `).join('');

  container.querySelectorAll('.faq-item').forEach(item => {
    const btn = item.querySelector('.faq-question');
    btn.addEventListener('click', () => {
      const wasOpen = item.classList.contains('open');
      item.classList.toggle('open');
      btn.setAttribute('aria-expanded', !wasOpen);
    });
  });
}

/* =============================================================
   10. BOOT
   ============================================================= */
document.addEventListener('DOMContentLoaded', () => {
  renderHeadlines();
  renderNLPChart();
  renderTravelMap();
  renderFAQ();
  loadData();
});
