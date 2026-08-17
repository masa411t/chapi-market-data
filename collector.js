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

export default {
  async fetch(request, env) {
    const result = await collect(env);

    return new Response(
      JSON.stringify(result, null, 2),
      {
        headers: {
          "content-type": "application/json; charset=UTF-8"
        }
      }
    );
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(collect(env));
  }
};
