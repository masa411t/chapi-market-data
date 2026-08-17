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

      if (url.pathname === "/health") {
        const row = await env.DB.prepare(`
          SELECT COUNT(*) AS total, MAX(collected_at) AS latest
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
    ctx.waitUntil(collect(env));
  }
};
