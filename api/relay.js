export const config = { runtime: "edge", regions: ["sin1", "hkg1", "bom1"] };

import { Redis } from "@upstash/redis";
const r = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const J = (o, s=200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type":"application/json" }});

function fnv1a(str){ let h=2166136261>>>0; for(let i=0;i<str.length;i++){ h^=str.charCodeAt(i); h=Math.imul(h,16777619)>>>0;} return h>>>0; }

export default async function handler(req){
  const url = new URL(req.url);
  if (req.method==="GET" && url.pathname.endsWith("/api/relay")) return new Response("OK",{status:200});
  if (req.method!=="POST") return new Response("Method Not Allowed",{status:405});
  if (req.headers.get("x-api-key")!==process.env.API_KEY) return J({ok:false,error:"unauthorized"},401);

  let b; try{ b=await req.json() }catch{ return J({ok:false,error:"bad_json"},400) }

  const uid = String(b.user_id ?? (req.headers.get("x-forwarded-for") || "unknown"));
  const PER_MIN = Number(process.env.PER_MIN_LIMIT ?? "12");
  const PER_DAY = Number(process.env.PER_DAY_LIMIT ?? "30");

  // per-minute
  const minute = Math.floor(Date.now()/60000);
  const kMin = `m:${uid}:${minute}`;
  const usedMin = await r.incr(kMin);
  if (usedMin === 1) await r.expire(kMin, 60);
  if (usedMin > PER_MIN) return J({ok:false,error:"rate_limit_minute",limit:PER_MIN},429);

  // per-day
  const day = new Date().toISOString().slice(0,10);
  const kDay = `d:${uid}:${day}`;
  const usedDay = await r.incr(kDay);
  if (usedDay === 1) await r.expire(kDay, 172800);
  if (usedDay > PER_DAY) return J({ok:false,error:"rate_limit_day",limit:PER_DAY},429);

  const content = String(b.content||"").slice(0,1900);
  const embeds  = Array.isArray(b.embeds)?b.embeds:undefined;
  const payload = { content, embeds, allowed_mentions: b.everyone ? {parse:["everyone"]}:{parse:[]} };

  let hooks=[]; try{ if(process.env.WEBHOOKS_JSON) hooks=JSON.parse(process.env.WEBHOOKS_JSON);}catch{}
  if((!hooks||!hooks.length)&&process.env.DISCORD_WEBHOOK_URL) hooks=[process.env.DISCORD_WEBHOOK_URL];
  if(!hooks||!hooks.length) return J({ok:false,error:"missing_webhook"},500);

  const tries = Math.max(1, Number(process.env.FAILOVER_TRIES ?? "2"));
  const startIdx = fnv1a(uid) % hooks.length;

  for (let t=0; t<Math.min(tries, hooks.length); t++){
    const idx = (startIdx + t) % hooks.length;
    const hook = hooks[idx];
    try{
      const resp = await fetch(hook+"?wait=true",{
        method:"POST", headers:{ "content-type":"application/json" }, body: JSON.stringify(payload)
      });
      if (resp.ok) return J({ok:true, shard:idx},200);
      if (resp.status===429 || (resp.status>=500 && resp.status<600)) continue;
      continue;
    }catch{ continue; }
  }
  return J({ok:false,error:"discord_busy_or_all_shards_failed"},503);
}
