import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {authorized,collector,processDeletions} from './collector.mjs';
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const jwk={...publicKey.export({format:'jwk'}),kid:'test',use:'sig'};
const url='https://libyan-collector-notifications.ahmedamaartrack.workers.dev/';
const claims={iss:'https://token.actions.githubusercontent.com',aud:url,
  nbf:Date.now()/1000-10,exp:Date.now()/1000+300,repository:'ahmedamaar-lab/libyan-collector-bot',
  repository_id:'1414448931',repository_owner_id:'341026316',ref:'refs/heads/main',
  workflow_ref:'ahmedamaar-lab/libyan-collector-bot/.github/workflows/collector.yml@refs/heads/main',event_name:'workflow_dispatch'};
function request(path,changes={},method='GET',body){
  const payload=[{alg:'RS256',kid:'test'},{...claims,...changes}].map(v=>Buffer.from(JSON.stringify(v)).toString('base64url')).join('.');
  const jwt=payload+'.'+sign('RSA-SHA256',Buffer.from(payload),privateKey).toString('base64url');
  return new Request(url+path,{method,headers:{authorization:'Bearer '+jwt},body:body&&JSON.stringify(body)});
}
let upstream=0;
globalThis.fetch=async target=>{
  if(String(target).includes('jwks'))return Response.json({keys:[jwk]});
  upstream++;return Response.json({itemSummaries:[{itemId:'v1|123|0',title:'Libya watch',seller:{username:'PRIVATE'},itemLocation:{country:'IT',postalCode:'PRIVATE'}}]});
};
assert(await authorized(request('collector/state')));
for(const changed of [{exp:0},{aud:'wrong'},{repository_id:'0'},{ref:'refs/heads/evil'},
  {event_name:'pull_request'},{workflow_ref:'wrong'},{nbf:Date.now()/1000+3600}])
  assert.equal(await authorized(request('collector/state',changed)),false);
assert.equal(await authorized(new Request(url+'collector/state')),false);
let revision=3;
const env={DB:{
  prepare(sql){return {all:async()=>({results:[]}),bind(...values){return {run:async()=>({success:true,meta:{changes:values.at(-1)===revision?1:0}})};},sql};},
  batch:async statements=>statements.map(()=>({success:true}))
}};
let r=await collector(request('collector/search?q=Libya&market=EBAY_IT'),env,async()=>'fake');
assert.equal(r.status,200);const data=await r.json();assert(!JSON.stringify(data).includes('PRIVATE'));assert.equal(upstream,1);
r=await collector(request('collector/search?q=Libya&market=EVIL'),env,async()=>'fake');assert.equal(r.status,400);assert.equal(upstream,1);
r=await collector(request('collector/state',{},'POST',{state:{version:1,seeded:true,seen:{},pending:{}},revision:2}),env);assert.equal(r.status,409);
await assert.rejects(()=>processDeletions({DB:{prepare:()=>({all:async()=>({results:[{notification_id:'x',payload_json:'{"data":{"username":"u"}}'}]}),bind:()=>({})}),batch:async()=>[{success:false}]}}));
console.log('OIDC, repository/branch restrictions, expiry, search field minimization, invalid search, stale revision, deletion failure checks passed.');
