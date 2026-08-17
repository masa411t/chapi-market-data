function round(value, digits = 4) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }
  return Number(value.toFixed(digits));
}

function pctChange(current, past) {
  if (!Number.isFinite(current) || !Number.isFinite(past) || past <= 0) {
    return null;
  }
  return ((current - past) / past) * 100;
}

function nearestPastRow(
  data,
  latestTimestamp,
  minutes,
  toleranceMinutes = 3
) {
  const target = latestTimestamp - minutes * 60 * 1000;

  let best = null;
  let bestDiff = Infinity;

  for (const row of data) {
    const ts = Number(row.market_timestamp);
    if (!Number.isFinite(ts)) continue;

    const diff = Math.abs(ts - target);

    if (diff < bestDiff) {
      best = row;
      bestDiff = diff;
    }
  }

  if (!best || bestDiff > toleranceMinutes * 60 * 1000) {
    return null;
  }

  return best;
}

function realizedVolatility(data) {
  const returns = [];

  for (let i = 1; i < data.length; i++) {
    const prev = Number(data[i - 1].last);
    const next = Number(data[i].last);

    if (prev > 0 && next > 0) {
      returns.push(Math.log(next / prev));
    }
  }

  if (returns.length < 2) return 0;

  const avg =
    returns.reduce((a, b) => a + b, 0) /
    returns.length;

  const variance =
    returns.reduce(
      (sum, r) => sum + Math.pow(r - avg, 2),
      0
    ) /
    (returns.length - 1);

  return Math.sqrt(variance) * 100;
}

function classifyDataQuality(samples, coverageMinutes) {
  if (samples >= 25 && coverageMinutes >= 28) {
    return "high";
  }

  if (samples >= 12 && coverageMinutes >= 13) {
    return "medium";
  }

  return "low";
}

function buildTradePlan({
  current,
  ask,
  spreadPct,
  volatility,
  ret5,
  momentum,
  relativeStrength,
  dataQuality
}) {
  const entry = ask > 0 ? ask : current;

  const stopPct = Math.max(
    0.35,
    Math.min(1.5, volatility * 5),
    Math.abs(ret5 ?? 0) * 0.8
  );

  const rewardRisk = 1.8;
  const targetPct = stopPct * rewardRisk;

  const stopLoss =
    entry * (1 - stopPct / 100);

  const takeProfit =
    entry * (1 + targetPct / 100);

  let action = "WAIT";
  let reason = "No clear edge";

  if (!Number.isFinite(spreadPct) || spreadPct > 0.5) {
    action = "REJECT";
    reason = "Spread too wide";
  } else if (dataQuality === "low") {
    action = "WAIT";
    reason = "Not enough history yet";
  } else if (momentum <= -0.15) {
    action = "SELL_OR_AVOID";
    reason = "Short-term momentum is bearish";
  } else if (
    momentum >= 0.12 &&
    relativeStrength >= 0 &&
    spreadPct <= 0.12
  ) {
    action = "BUY_CANDIDATE";
    reason =
      "Positive momentum, BTC-relative strength and acceptable spread";
  } else if (spreadPct > 0.2) {
    action = "REJECT";
    reason =
      "Trading cost is too high for short-term trading";
  }

  return {
    action,
    reason,
    entry: round(entry, 8),
    takeProfit: round(takeProfit, 8),
    stopLoss: round(stopLoss, 8),
    stopPct: round(stopPct, 3),
    targetPct: round(targetPct, 3),
    rewardRisk: round(rewardRisk, 2)
  };
}

export async function analyzeMarkets(env) {
  const query = `
    SELECT
      symbol,
      buy,
      sell,
      last,
      volume,
      market_timestamp,
      collected_at
    FROM market_data
    WHERE collected_at >= datetime('now', '-75 minutes')
    ORDER BY symbol ASC, market_timestamp ASC
  `;

  const result =
    await env.DB.prepare(query).all();

  const rows = result.results || [];

  const grouped = {};

  for (const row of rows) {
    if (!grouped[row.symbol]) {
      grouped[row.symbol] = [];
    }

    grouped[row.symbol].push(row);
  }

  const rawMetrics = [];

  for (const [symbol, data] of Object.entries(grouped)) {
    if (data.length < 5) continue;

    const latest = data[data.length - 1];
    const first = data[0];

    const current = Number(latest.last);
    const latestTs =
      Number(latest.market_timestamp);

    const firstTs =
      Number(first.market_timestamp);

    if (
      !current ||
      current <= 0 ||
      !Number.isFinite(latestTs)
    ) {
      continue;
    }

    const coverageMinutes = Math.max(
      0,
      (latestTs - firstTs) / 60000
    );

    const row5 =
      nearestPastRow(data, latestTs, 5);

    const row15 =
      nearestPastRow(data, latestTs, 15);

    const row30 =
      nearestPastRow(data, latestTs, 30);

    const ret5 =
      row5
        ? pctChange(
            current,
            Number(row5.last)
          )
        : null;

    const ret15 =
      row15
        ? pctChange(
            current,
            Number(row15.last)
          )
        : null;

    const ret30 =
      row30
        ? pctChange(
            current,
            Number(row30.last)
          )
        : null;

    const bid = Number(latest.buy);
    const ask = Number(latest.sell);

    const mid =
      bid > 0 && ask > 0
        ? (bid + ask) / 2
        : current;

    const spreadPct =
      bid > 0 && ask > 0
        ? ((ask - bid) / mid) * 100
        : Infinity;

    const volatility =
      realizedVolatility(data);

    const latestVolume =
      Number(latest.volume);

    const pastVolume =
      row15
        ? Number(row15.volume)
        : null;

    let volumeChangePct = null;

    if (
      Number.isFinite(latestVolume) &&
      Number.isFinite(pastVolume) &&
      pastVolume > 0 &&
      latestVolume >= pastVolume
    ) {
      volumeChangePct =
        ((latestVolume - pastVolume) /
          pastVolume) *
        100;
    }

    const weighted = [];

    if (ret5 !== null) {
      weighted.push([ret5, 0.5]);
    }

    if (ret15 !== null) {
      weighted.push([ret15, 0.3]);
    }

    if (ret30 !== null) {
      weighted.push([ret30, 0.2]);
    }

    const totalWeight =
      weighted.reduce(
        (sum, [, weight]) =>
          sum + weight,
        0
      );

    const momentum =
      totalWeight > 0
        ? weighted.reduce(
            (sum, [ret, weight]) =>
              sum + ret * weight,
            0
          ) / totalWeight
        : 0;

    const dataQuality =
      classifyDataQuality(
        data.length,
        coverageMinutes
      );

    rawMetrics.push({
      symbol,
      current,
      bid,
      ask,
      ret5,
      ret15,
      ret30,
      spreadPct,
      volatility,
      volumeChangePct,
      momentum,
      samples: data.length,
      coverageMinutes,
      dataQuality
    });
  }

  const btc =
    rawMetrics.find(
      (metric) =>
        metric.symbol === "btc_jpy"
    );

  const btcRet5 =
    btc?.ret5 ?? 0;

  const btcMomentum =
    btc?.momentum ?? 0;

  const analyses =
    rawMetrics.map((metric) => {
      const relativeStrength =
        metric.symbol === "btc_jpy"
          ? 0
          : (
              metric.ret5 ??
              metric.momentum
            ) - btcRet5;

      let direction = "neutral";

      if (metric.momentum > 0.12) {
        direction = "bullish";
      }

      if (metric.momentum < -0.12) {
        direction = "bearish";
      }

      const spreadPenalty =
        Number.isFinite(
          metric.spreadPct
        )
          ? Math.min(
              metric.spreadPct,
              5
            ) * 120
          : 600;

      const qualityMultiplier =
        metric.dataQuality === "high"
          ? 1
          : metric.dataQuality === "medium"
          ? 0.8
          : 0.45;

      const volumeBonus =
        metric.volumeChangePct !== null
          ? Math.min(
              Math.max(
                metric.volumeChangePct,
                0
              ),
              2
            ) * 2
          : 0;

      const rawScore =
        Math.abs(
          metric.momentum
        ) * 28 +
        Math.abs(
          relativeStrength
        ) * 12 +
        metric.volatility * 18 +
        volumeBonus -
        spreadPenalty;

      const opportunityScore =
        rawScore *
        qualityMultiplier;

      const tradePlan =
        buildTradePlan({
          current:
            metric.current,

          ask:
            metric.ask,

          spreadPct:
            metric.spreadPct,

          volatility:
            metric.volatility,

          ret5:
            metric.ret5,

          momentum:
            metric.momentum,

          relativeStrength,

          dataQuality:
            metric.dataQuality
        });

      let confidence = 35;

      if (
        metric.dataQuality ===
        "medium"
      ) {
        confidence += 10;
      }

      if (
        metric.dataQuality ===
        "high"
      ) {
        confidence += 20;
      }

      if (
        Math.abs(
          metric.momentum
        ) >= 0.12
      ) {
        confidence += 10;
      }

      if (
        Number.isFinite(
          metric.spreadPct
        ) &&
        metric.spreadPct <= 0.1
      ) {
        confidence += 10;
      }

      if (
        Math.sign(
          metric.momentum
        ) ===
          Math.sign(
            relativeStrength
          ) &&
        relativeStrength !== 0
      ) {
        confidence += 5;
      }

      confidence =
        Math.min(
          90,
          Math.max(
            10,
            confidence
          )
        );

      return {
        symbol:
          metric.symbol,

        last:
          round(
            metric.current,
            8
          ),

        ret5:
          round(
            metric.ret5
          ),

        ret15:
          round(
            metric.ret15
          ),

        ret30:
          round(
            metric.ret30
          ),

        btcRet5:
          round(
            btcRet5
          ),

        btcMomentum:
          round(
            btcMomentum
          ),

        relativeStrengthVsBtc:
          round(
            relativeStrength
          ),

        spreadPct:
          Number.isFinite(
            metric.spreadPct
          )
            ? round(
                metric.spreadPct
              )
            : null,

        volatility:
          round(
            metric.volatility
          ),

        volumeChange15mPct:
          round(
            metric.volumeChangePct
          ),

        momentum:
          round(
            metric.momentum
          ),

        direction,

        samples:
          metric.samples,

        coverageMinutes:
          round(
            metric.coverageMinutes,
            1
          ),

        dataQuality:
          metric.dataQuality,

        opportunityScore:
          round(
            opportunityScore,
            2
          ),

        confidence,

        tradePlan
      };
    });

  const tradable =
    analyses.filter(
      (item) =>
        item.tradePlan.action !==
          "REJECT" &&
        item.dataQuality !==
          "low"
    );

  tradable.sort(
    (a, b) =>
      b.opportunityScore -
      a.opportunityScore
  );

  analyses.sort(
    (a, b) =>
      b.opportunityScore -
      a.opportunityScore
  );

  const buyCandidates =
    tradable
      .filter(
        (item) =>
          item.tradePlan.action ===
          "BUY_CANDIDATE"
      )
      .slice(0, 10);

  return {
    version: "2.0",

    generatedAt:
      new Date().toISOString(),

    analyzedSymbols:
      analyses.length,

    tradableSymbols:
      tradable.length,

    note:
      "Simulation only. Trade plans are experimental and require backtesting.",

    marketContext: {
      btcRet5:
        round(
          btcRet5
        ),

      btcMomentum:
        round(
          btcMomentum
        )
    },

    top10:
      tradable.slice(
        0,
        10
      ),

    buyCandidates,

    all:
      analyses
  };
}
