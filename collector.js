import { analyzeMarkets } from "./engine.js";

async function collect(env) {
  const res = await fetch("https://public.bitbank.cc/tickers_jpy");
  const json = await res.json();

  if (json.success !== 1 || !Array.isArray(json.data)) {
    throw new Error("bitbank API error");
  }

  const statements = json.data.map((t) =>
    env.DB.prepare(`
      INSERT INTO market_data
      (
        symbol,
        sell,
        buy,
        open,
        high,
        low,
        last,
        volume,
        market_timestamp
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      t.pair,
      Number(t.sell),
      Number(t.buy),
      Number(t.open),
      Number(t.high),
      Number(t.low),
      Number(t.last),
      Number(t.vol),
      t.timestamp
    )
  );

  await env.DB.batch(statements);

  return {
    success: true,
    saved: statements.length,
    collected_at: new Date().toISOString()
  };
}

async function closeOpenPaperTrades(env) {
  const openTrades = await env.DB.prepare(`
    SELECT *
    FROM paper_trades
    WHERE status = 'OPEN'
    ORDER BY id ASC
  `).all();

  for (const trade of openTrades.results || []) {
    const latest = await env.DB.prepare(`
      SELECT last
      FROM market_data
      WHERE symbol = ?
      ORDER BY market_timestamp DESC
      LIMIT 1
    `).bind(trade.symbol).first();

    if (!latest) continue;

    const price = Number(latest.last);
    const tp = Number(trade.take_profit);
    const sl = Number(trade.stop_loss);
    const entry = Number(trade.entry_price);

    let result = null;
    let exitPrice = null;

    if (price >= tp) {
      result = "WIN";
      exitPrice = price;
    } else if (price <= sl) {
      result = "LOSS";
      exitPrice = price;
    }

    if (result) {
      const pnlPct =
        ((exitPrice - entry) / entry) * 100;

      await env.DB.prepare(`
        UPDATE paper_trades
        SET
          status = 'CLOSED',
          exit_price = ?,
          result = ?,
          pnl_pct = ?,
          closed_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(
        exitPrice,
        result,
        pnlPct,
        trade.id
      ).run();
    }
  }
}

async function openNewPaperTrades(env) {
  const analysis = await analyzeMarkets(env);

  for (const candidate of analysis.buyCandidates || []) {
    const existing = await env.DB.prepare(`
      SELECT id
      FROM paper_trades
      WHERE symbol = ?
        AND status = 'OPEN'
      LIMIT 1
    `).bind(candidate.symbol).first();

    if (existing) continue;

    const plan = candidate.tradePlan;

    if (
      plan.action !== "BUY_CANDIDATE" ||
      !plan.entry ||
      !plan.takeProfit ||
      !plan.stopLoss
    ) {
      continue;
    }

    await env.DB.prepare(`
      INSERT INTO paper_trades
      (
        symbol,
        action,
        entry_price,
        take_profit,
        stop_loss,
        confidence,
        opportunity_score,
        status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 'OPEN')
    `).bind(
      candidate.symbol,
      plan.action,
      plan.entry,
      plan.takeProfit,
      plan.stopLoss,
      candidate.confidence,
      candidate.opportunityScore
    ).run();
  }

  return analysis;
}

async function runPaperTrading(env) {
  await closeOpenPaperTrades(env);
  return await openNewPaperTrades(env);
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "cache-control": "no-store"
    }
  });
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      if (url.pathname === "/analysis") {
        const result = await analyzeMarkets(env);
        return jsonResponse(result);
      }

      if (url.pathname === "/paper") {
        const result = await runPaperTrading(env);

        const trades = await env.DB.prepare(`
          SELECT *
          FROM paper_trades
          ORDER BY id DESC
          LIMIT 50
        `).all();

        return jsonResponse({
          success: true,
          analysisVersion: result.version,
          trades: trades.results || []
        });
      }

      if (url.pathname === "/health") {
        const row = await env.DB.prepare(`
          SELECT
            COUNT(*) AS total,
            MAX(collected_at) AS latest
          FROM market_data
        `).first();

        return jsonResponse({
          success: true,
          database: "ok",
          totalRows: Number(row?.total || 0),
          latest: row?.latest || null
        });
      }

      const result = await collect(env);
      return jsonResponse(result);

    } catch (error) {
      return jsonResponse({
        success: false,
        error: String(error?.message || error)
      }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        await collect(env);
        await runPaperTrading(env);
      })()
    );
  }
};
