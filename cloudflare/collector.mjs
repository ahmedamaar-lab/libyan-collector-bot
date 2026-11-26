// Authenticated bridge for the existing Python scanner. No shared CI secret.
import { createPublicKey, verify, createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
const ISSUER = 'https://token.actions.githubusercontent.com';
const AUDIENCE = 'https://libyan-collector-notifications.ahmedamaartrack.workers.dev/';
const REPO = 'ahmedamaar-lab/libyan-collector-bot';
let jwks;
const json = (value, status=200) => Response.json(value, {status, headers:{'Cache-Control':'no-store'}});

export async function authorized(request) {
  try {
    const token = request.headers.get('authorization') || '';
    if (!token.startsWith('Bearer ') || token.length > 20000) return false;
    const parts = token.slice(7).split('.');
    if (parts.length !== 3) return false;
    const header = JSON.parse(Buffer.from(parts[0], 'base64url'));
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
    const now = Date.now()/1000;
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' ||
        claims.iss !== ISSUER || claims.aud !== AUDIENCE ||
        !Number.isFinite(claims.exp) || claims.exp <= now ||
        !Number.isFinite(claims.nbf) || claims.nbf > now+30 ||
        claims.repository !== REPO || claims.repository_id !== '1414448931' ||
        claims.repository_owner_id !== '341026316' ||
        claims.ref !== 'refs/heads/main' ||
        claims.workflow_ref !== REPO+'/.github/workflows/collector.yml@refs/heads/main' ||
        !['workflow_dispatch','schedule'].includes(claims.event_name)) return false;
    if (!jwks || jwks.expires < Date.now() || !jwks.keys.some(k=>k.kid===header.kid)) {
      const r = await fetch(ISSUER+'/.well-known/jwks', {redirect:'manual', signal:AbortSignal.timeout(10000)});
      if (!r.ok) return false;
      jwks = {keys:(await r.json()).keys, expires:Date.now()+3600000};
    }
    const key = jwks.keys.find(k=>k.kid===header.kid && k.kty==='RSA' && k.use==='sig');
    return !!key && verify('RSA-SHA256', Buffer.from(parts[0]+'.'+parts[1]),
      createPublicKey({key,format:'jwk'}), Buffer.from(parts[2],'base64url'));
  } catch { return false; }
}

const sellerRef=value=>createHash('sha256').update(String(value).trim().toLowerCase()).digest('hex');

// Keep only suppression hashes, then redact the raw notification identifiers.
// A notice without a usable username conservatively clears pending metadata.
export async function processDeletions(env) {
  const rows=await env.DB.prepare('SELECT notification_id,payload_json FROM deletion_requests WHERE processed_at IS NULL LIMIT 100').all();
  for(const row of rows.results){
    const data=JSON.parse(row.payload_json).data || {};
    const refs=[...new Set([data.username,data.userId].filter(v=>typeof v==='string' && v).map(sellerRef))];
    const statements=refs.map(ref=>env.DB.prepare('INSERT OR IGNORE INTO deletion_blocks(seller_ref) VALUES (?)').bind(ref));
    statements.push(env.DB.prepare(`UPDATE collector_state SET state_json=json_set(state_json,'$.pending',
      COALESCE((SELECT json_group_object(key,json(value)) FROM json_each(state_json,'$.pending')
        WHERE ? AND json_extract(value,'$.seller_ref') NOT IN (SELECT seller_ref FROM deletion_blocks)),json('{}'))),
      revision=revision+1 WHERE EXISTS (SELECT 1 FROM json_each(state_json,'$.pending')
        WHERE NOT ? OR json_extract(value,'$.seller_ref') IN (SELECT seller_ref FROM deletion_blocks))`)
      .bind(data.username ? 1 : 0,data.username ? 1 : 0));
    statements.push(env.DB.prepare("UPDATE deletion_requests SET payload_json='{}',processed_at=CURRENT_TIMESTAMP WHERE notification_id=?").bind(row.notification_id));
    const result=await env.DB.batch(statements);
    if(result.some(r=>!r.success))throw new Error('Deletion processing failed');
  }
}

export async function collector(request, env, appToken) {
  if (!await authorized(request)) return json({error:'Unauthorized workflow'},401);
  await processDeletions(env);
  const url = new URL(request.url);
  if (url.pathname === '/collector/search' && request.method === 'GET') {
    const query=url.searchParams.get('q') || '';
    const market=url.searchParams.get('market');
    const limit=Number(url.searchParams.get('limit') || 100);
    const offset=Number(url.searchParams.get('offset') || 0);
    if (!query || query.length>500 || !['EBAY_US','EBAY_IT','EBAY_DE','EBAY_FR','EBAY_GB','EBAY_ES'].includes(market) ||
        !Number.isInteger(limit) || limit<1 || limit>100 || !Number.isInteger(offset) || offset<0 || offset>9900)
      return json({error:'Invalid search'},400);
    const params=new URLSearchParams({q:query,sort:'newlyListed',limit:String(limit),offset:String(offset),
      filter:'buyingOptions:{FIXED_PRICE|AUCTION|BEST_OFFER}'});
    const response=await fetch('https://api.ebay.com/buy/browse/v1/item_summary/search?'+params,{
      redirect:'manual',signal:AbortSignal.timeout(20000),
      headers:{Authorization:'Bearer '+await appToken(env),'X-EBAY-C-MARKETPLACE-ID':market}});
    if (!response.ok) return json({error:'eBay search rejected',upstream_status:response.status},502);
    const data=await response.json();
    // Return only fields the scanner uses, excluding seller identity/feedback.
    const fields=['itemId','legacyItemId','title','categories','price','currentBidPrice',
      'itemWebUrl','buyingOptions','itemEndDate'];
    const items=(data.itemSummaries || []).map(item=>{
      const value={}; for(const field of fields) if(item[field]!==undefined)value[field]=item[field];
      value.itemLocation={country:item.itemLocation?.country || '?'};
      value.seller_ref=item.seller?.username ? sellerRef(item.seller.username) : null;
      return value;
    }).filter(item=>item.seller_ref);
    return json({itemSummaries:items,next:!!data.next});
  }
  if (url.pathname !== '/collector/state') return json({error:'Not found'},404);
  await env.DB.prepare(`INSERT INTO collector_state(state_key,state_json,revision)
    VALUES ('main',?,0) ON CONFLICT(state_key) DO NOTHING`).bind(JSON.stringify({version:1,seeded:false,seen:{},pending:{}})).run();
  if(request.method==='GET') {
    const row=await env.DB.prepare("SELECT state_json,revision FROM collector_state WHERE state_key='main'").first();
    return json({state:JSON.parse(row.state_json),revision:row.revision});
  }
  if(request.method!=='POST')return json({error:'Method not allowed'},405);
  // Bounded streaming avoids reading arbitrarily large authenticated requests.
  const reader=request.body?.getReader();if(!reader)return json({error:'Body required'},400);
  const chunks=[];let size=0;
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;
    if(size>2000000){await reader.cancel();return json({error:'State too large'},413);}chunks.push(Buffer.from(value));}
  let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return json({error:'Invalid JSON'},400);}
  const state=body.state;
  if(!Number.isInteger(body.revision) || !state || state.version!==1 || typeof state.seeded!=='boolean' ||
    !state.seen || Array.isArray(state.seen) || typeof state.seen!=='object' ||
    !state.pending || Array.isArray(state.pending) || typeof state.pending!=='object') return json({error:'Invalid state'},400);
  const result=await env.DB.prepare(`UPDATE collector_state SET state_json=json_set(?,'$.pending',
      COALESCE((SELECT json_group_object(key,json(value)) FROM json_each(?,'$.pending')
        WHERE json_extract(value,'$.seller_ref') NOT IN (SELECT seller_ref FROM deletion_blocks)),json('{}'))),revision=revision+1
    WHERE state_key='main' AND revision=? AND NOT EXISTS
    (SELECT 1 FROM deletion_requests WHERE processed_at IS NULL)`).bind(JSON.stringify(state),JSON.stringify(state),body.revision).run();
  if(result.meta.changes!==1)return json({error:'State changed; restart scan'},409);
  return json({revision:body.revision+1});
}
