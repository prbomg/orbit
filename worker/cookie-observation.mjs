import {createHash} from 'node:crypto';
import cookieAge from '../utils/cookieAge.js';
export function observeCookies(cookies,previous=[],now=Date.now()){
 const old=new Map(previous.map(c=>[c.key,c]));
 return cookies.filter(c=>cookieAge.NAMES.includes(c.name)&&cookieAge.validDomain(c)&&(c.expires===-1||c.expires*1000>now)).map(c=>{
  const key=JSON.stringify([c.name,c.domain,c.path,c.partitionKey||null]),valueHash=createHash('sha256').update(c.value).digest('hex'),p=old.get(key);
  const firstSeenAt=p?.valueHash===valueHash&&Number.isFinite(Date.parse(p.firstSeenAt))&&Date.parse(p.firstSeenAt)<=now?p.firstSeenAt:new Date(now).toISOString();
  return {key,name:c.name,domain:c.domain,valueHash,firstSeenAt,expires:c.expires};
 });
}
