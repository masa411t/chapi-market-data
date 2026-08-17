export default {
  async fetch() {
    const r = await fetch("https://public.bitbank.cc/btc_jpy/ticker");
    return new Response(await r.text(), {
      headers: { "content-type": "application/json" }
    });
  }
};
