import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import worker from './worker.mjs';
const f=JSON.parse(await readFile(new URL('./fixture.json',import.meta.url)));
const good=f.VALID;
const endpoint='https://libyan-collector-notifications.ahmedamaartrack.workers.dev/';
const env={EBAY_VERIFICATION_TOKEN:'a'.repeat(64),EBAY_CLIENT_ID:'test',EBAY_CLIENT_SECRET:'test'};
let writes=0;
const stored=new Map();
env.DB = {
  async batch(statements) {return statements.map(()=>({success:true}));},
  prepare(sql) {
    return {
      sql,
      async all(){return {results:[...stored].map(([notification_id,payload_json])=>({notification_id,payload_json}))};},
      bind(id,body) {return {sql,async run(){
        writes++;
        if(!stored.has(id))stored.set(id,body);
        return {success:true};
      }};}
    };
  }
};
const realFetch=globalThis.fetch;
globalThis.fetch=async(url)=>Response.json(String(url).includes('oauth2')?{access_token:'fake',expires_in:7200}:good.response);
const req=(msg,signature=good.signature)=>new Request(endpoint,{method:'POST',headers:{'content-type':'application/json','x-ebay-signature':signature},body:JSON.stringify(msg,null,2)});
let r=await worker.fetch(new Request(endpoint+'?challenge_code=test'),env);
assert.equal((await r.json()).challengeResponse,createHash('sha256').update('test'+'a'.repeat(64)+endpoint).digest('hex'));
r=await worker.fetch(req(good.message),env);assert.equal(r.status,204);assert.equal(stored.size,1);
const before=stored.get(good.message.notification.notificationId);
r=await worker.fetch(req(good.message),env);assert.equal(r.status,204);assert.equal(stored.size,1);assert.equal(stored.get(good.message.notification.notificationId),before);
const bad=structuredClone(good.message);bad.notification.data.username='tampered';
r=await worker.fetch(req(bad),env);assert.equal(r.status,412);assert.equal(writes,2);
r=await worker.fetch(req(good.message,f.SIGNATURE_MISMATCH.signature),env);assert.equal(r.status,412);
r=await worker.fetch(req(good.message,''),env);assert.equal(r.status,412);
r=await worker.fetch(req(good.message),{...env,DB:null});assert.equal(r.status,503);
r=await worker.fetch(req(good.message),{...env,DB:{prepare(){throw new Error('deliberate DB failure')}}});assert.equal(r.status,503);
r=await worker.fetch(req(good.message),{...env,DB:{prepare(){return{bind(){return{run:async()=>({success:false})}}}}}});assert.equal(r.status,503);
r=await worker.fetch(new Request(endpoint,{method:'DELETE'}),env);assert.equal(r.status,405);
globalThis.fetch=realFetch;
console.log('10 checks passed: challenge, signed fixture, duplicate, tampering, bad signature, unsigned, missing binding, DB exception, DB failure, unsupported method.');
