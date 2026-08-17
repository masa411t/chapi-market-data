import { analyzeMarkets } from "./engine.js";

export async function analyzeHourly(env) {
  const analysis = await analyzeMarkets(env);

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS hourly_analysis (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      generated_at TEXT NOT NULL,
      analyzed_symbols INTEGER,
      tradable_symbols INTEGER,
      result_json TEXT NOT NULL
    )
  `).run();

  await env.DB.prepare(`
    INSERT INTO hourly_analysis (
      generated_at,
      analyzed_symbols,
      tradable_symbols,
      result_json
    )
    VALUES (?, ?, ?, ?)
  `)
    .bind(
      analysis.generatedAt,
      analysis.analyzedSymbols,
      analysis.tradableSymbols,
      JSON.stringify(analysis)
    )
    .run();

  return {
    success: true,
    generatedAt: analysis.generatedAt,
    analyzedSymbols: analysis.analyzedSymbols,
    tradableSymbols: analysis.tradableSymbols
  };
}
