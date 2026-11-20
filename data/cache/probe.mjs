const HEADERS = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36', 'accept-language': 'en;q=0.9', cookie: 'CONSENT=YES+1' };
async function search(q){
  const html=await (await fetch('https://www.youtube.com/results?hl=en&search_query='+encodeURIComponent(q),{headers:HEADERS})).text();
  const m=html.match(/ytInitialData\s*=\s*(\{.+?\});\s*<\/script>/s); const d=JSON.parse(m[1]); const out=[];
  const walk=o=>{if(!o||typeof o!=='object')return; if(o.videoRenderer){const v=o.videoRenderer;out.push(`${v.videoId} ${v.lengthText?.simpleText} [${(v.ownerText?.runs||[]).map(r=>r.text).join('')}] ${(v.title?.runs||[]).map(r=>r.text).join('')}`);return;} for(const k in o)walk(o[k]);};
  walk(d); return out.slice(0,6);
}
for (const q of process.argv.slice(2)) { console.log('\n## '+q); try{ for(const l of await search(q)) console.log(l);}catch(e){console.log('ERR',e.message)} }
