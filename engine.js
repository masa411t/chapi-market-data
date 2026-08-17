export async function analyzeMarkets(env) {
  const query = `
    SELECT
      symbol,
      buy,
      sell,
      last,
      market_timestamp,
      collected_at
    FROM market_data
    WHERE collected_at >= datetime('now', '-40 minutes')
    ORDER BY symbol ASC, market_timestamp ASC
  `;

  const result = await env.DB.prepare(query).all();
  const rows = result.results || [];

  const grouped = {};

  for (const row of rows) {
    if (!grouped[row.symbol]) grouped[row.symbol] = [];
    grouped[row.symbol].push(row);
  }

  const analyses = [];

  for (const [symbol, data] of Object.entries(grouped)) {
    if (data.length < 5) continue;

    const latest = data[data.length - 1];
    const current = Number(latest.last);

    if (!current || current <= 0) continue;

    const findPast = (minutes) => {
      const target =
        Number(latest.market_timestamp) - minutes * 60 * 1000;

      let best = data[0];

      for (const row of data) {
        if (
          Math.abs(Number(row.market_timestamp) - target) <
          Math.abs(Number(best.market_timestamp) - target)
        ) {
          best = row;
        }
      }

      return Number(best.last);
    };

    const pctChange = (past) => {
      if (!past || past <= 0) return 0;
      return ((current - past) / past) * 100;
    };

    const ret5 = pctChange(findPast(5));
    const ret15 = pctChange(findPast(15));
    const ret30 = pctChange(findPast(30));

    const bid = Number(latest.buy);
    const ask = Number(latest.sell);

    const mid =
      bid > 0 && ask > 0
        ? (bid + ask) / 2
        : current;

    const spreadPct =
      bid > 0 && ask > 0
        ? ((ask - bid) / mid) * 100
        : 999;

    const returns = [];

    for (let i = 1; i < data.length; i++) {
      const prev = Number(data[i - 1].last);
      const next = Number(data[i].last);

      if (prev > 0 && next > 0) {
        returns.push(Math.log(next / prev));
      }
    }

    let volatility = 0;

    if (returns.length > 1) {
      const avg =
        returns.reduce((a, b) => a + b, 0) / returns.length;

      const variance =
        returns.reduce(
          (sum, r) => sum + Math.pow(r - avg, 2),
          0
        ) /
        (returns.length - 1);

      volatility = Math.sqrt(variance) * 100;
    }

    const momentum =
      ret5 * 0.5 +
      ret15 * 0.3 +
      ret30 * 0.2;

    let direction = "neutral";

    if (momentum > 0.15) direction = "bullish";
    if (momentum < -0.15) direction = "bearish";

    const opportunityScore =
      Math.abs(momentum) * 25 +
      volatility * 20 -
      spreadPct * 150;

    analyses.push({
      symbol,
      last: current,
      ret5: Number(ret5.toFixed(4)),
      ret15: Number(ret15.toFixed(4)),
      ret30: Number(ret30.toFixed(4)),
      spreadPct: Number(spreadPct.toFixed(4)),
      volatility: Number(volatility.toFixed(4)),
      momentum: Number(momentum.toFixed(4)),
      direction,
      samples: data.length,
      opportunityScore: Number(
        opportunityScore.toFixed(2)
      )
    });
  }

  analyses.sort(
    (a, b) =>
      b.opportunityScore - a.opportunityScore
  );

  return {
    generatedAt: new Date().toISOString(),
    analyzedSymbols: analyses.length,
    top10: analyses.slice(0, 10),
    all: analyses
  };
}
