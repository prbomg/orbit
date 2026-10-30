const { createHash } = require('node:crypto');
const { z } = require('zod');
const catalog = require('./deviceCatalog');
const { localPassport } = require('./fingerprint');
const { createPlan } = require('./warmupPlan');
const previewSchema = z.object({
 count: z.number().int().min(1).max(1000),
 fingerprintMode: z.enum(['local','auto','mobileproxy']),
 fingerprintDevicePreset: z.enum(['mixed','s23_android14']),
 fingerprintDeviceWeights: catalog.weightsSchema,
 fingerprintLocale: z.string().min(1).max(35).refine(v=>{try{return Intl.DateTimeFormat.supportedLocalesOf([v]).length>0;}catch{return false;}},'Неверная локаль'),
 fingerprintTimezone: z.string().min(1).max(80).refine(v=>{try{new Intl.DateTimeFormat('en',{timeZone:v});return true;}catch{return false;}},'Неверный часовой пояс'),
}).strict();
async function previewProfiles(input, settings = {}) {
 const config=previewSchema.parse(input);
 const plan=createPlan(settings);
 // Only local generation can be inspected without making provider requests.
 const scope=config.fingerprintMode==='mobileproxy'?'provider_unavailable':config.fingerprintMode==='auto'?'local_fallback':'local';
 const counts=new Map(catalog.DEVICE_CATALOG.templates.map(t=>[t.id,{id:t.id,name:t.name,os:t.os,count:0}]));
 const errors=new Map();let passed=0;
 if(scope!=='provider_unavailable'){
  const {passportValidation}=await import('../worker/passport-validation.mjs');
  for(let i=0;i<config.count;i++){
   const seed=createHash('sha256').update(`orbit-preview-v1:${i}`).digest('hex').slice(0,32);
   const passport=localPassport(config,{seed});
   const result=passportValidation(passport);
   counts.get(passport.deviceTemplate.id).count++;
   if(result.status==='passed')passed++;
   for(const code of result.errors)errors.set(code,(errors.get(code)||0)+1);
  }
 }
 return {scope,count:config.count,checked:scope==='provider_unavailable'?0:config.count,passed,
  catalogVersion:catalog.DEVICE_CATALOG.version,locale:config.fingerprintLocale,timezone:config.fingerprintTimezone,
  models:[...counts.values()],errors:[...errors].map(([code,count])=>({code,count})),plan,
  note:'Предварительная выборка с фиксированными тестовыми seed. Фактическое распределение новой партии может отличаться. Профили и настройки не сохраняются; браузер и внешние сервисы не запускаются.'};
}
module.exports={previewSchema,previewProfiles};
