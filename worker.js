import { collect } from "./collector.js";
import { analyzeHourly } from "./hourly.js";

export default {
  async fetch(request, env, ctx) {
    return new Response(
      JSON.stringify({
        ok: true,
        service: "chapi-market-data"
      }),
      {
        headers: {
          "content-type": "application/json"
        }
      }
    );
  },

  async scheduled(event, env, ctx) {
    const now = new Date();

    // 毎分：市場データ収集
    await collect(env);

    // 毎時：市場分析
    if (now.getUTCMinutes() === 0) {
      ctx.waitUntil(
        analyzeHourly(env)
      );
    }
  }
};
