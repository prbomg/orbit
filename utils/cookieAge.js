const YANDEX=['yandex.ru','yandex.com','ya.ru','yandex.kz','yandex.by','yandex.com.tr','yandex.uz','yandex.az','yandex.eu'];
const validDomain=c=>c.name!=='yandexuid'||YANDEX.some(d=>c.domain.replace(/^\./,'').toLowerCase()===d||c.domain.toLowerCase().endsWith('.'+d));
const HOUR=3600000, NAMES=['_ym_d','yandexuid'];
function policyHours(){const hours=Number(process.env.ORBIT_COOKIE_MIN_AGE_HOURS||0);if(!Number.isFinite(hours)||hours<0||hours>96)throw Error('invalid_cookie_age_policy');return hours;}
function assessCookieAge(observations=[],hours=policyHours(),now=Date.now()){
 const names=NAMES.map(name=>{
  const dates=observations.filter(c=>c.name===name&&validDomain(c)&&(c.expires===-1||c.expires*1000>now)).map(c=>Date.parse(c.firstSeenAt)).filter(t=>Number.isFinite(t)&&t<=now);
  return {name,firstSeenAt:dates.length?new Date(Math.min(...dates)).toISOString():null};
 });
 const missing=names.filter(c=>!c.firstSeenAt).map(c=>c.name);
 const readyAt=missing.length?null:new Date(Math.max(...names.map(c=>Date.parse(c.firstSeenAt)))+hours*HOUR).toISOString();
 return {version:1,minimumHours:hours,status:!hours?'disabled':missing.length?'missing':Date.parse(readyAt)>now?'waiting':'passed',readyAt,missing,cookies:names,source:'first_observed',checkedAt:new Date(now).toISOString()};
}
function gatePassed(check,now=Date.now()){const gate=assessCookieAge(check?.cookieObservations||[],policyHours(),now);return ['passed','disabled'].includes(gate.status);}
module.exports={NAMES,validDomain,assessCookieAge,gatePassed,policyHours};
