const { z } = require('zod');
const { createHash } = require('node:crypto');
const catalog = require('./device-catalog.json');
const positive = z.number().finite().positive();
const size = z.object({ width: positive.int(), height: positive.int() }).strict();
const gpuSize = positive.int().min(2048).max(32768).refine(n => (n & (n - 1)) === 0, 'gpu_size_power_of_two');
const gpuCount = positive.int().max(0x7fffffff);
const webglLimitsSchema = z.object({
  maxTextureSize: gpuSize, maxCubeMapTextureSize: gpuSize, maxRenderbufferSize: gpuSize,
  maxViewportDims: z.tuple([gpuSize, gpuSize]), maxVertexAttribs: positive.int().min(8).max(32),
  // Optional until a device/browser measurement is available. No chip-family defaults.
  maxVertexUniformVectors: gpuCount.optional(), maxFragmentUniformVectors: gpuCount.optional(),
  maxVaryingVectors: gpuCount.optional(), maxTextureImageUnits: gpuCount.optional(),
  maxVertexUniformComponents: gpuCount.optional(), maxFragmentUniformComponents: gpuCount.optional(),
  maxVertexTextureImageUnits: z.number().int().min(0).max(0x7fffffff).optional(),
  maxCombinedTextureImageUnits: gpuCount.optional(),
}).strict().superRefine((limits, ctx) => {
  const fail = message => ctx.addIssue({code:z.ZodIssueCode.custom,message});
  for (const stage of ['Vertex', 'Fragment']) {
    const vectors = limits[`max${stage}UniformVectors`], components = limits[`max${stage}UniformComponents`];
    if (vectors !== undefined && components !== undefined && components < vectors * 4) fail('webgl_uniform_components');
  }
  if (limits.maxCombinedTextureImageUnits !== undefined &&
      [limits.maxTextureImageUnits, limits.maxVertexTextureImageUnits].some(value => value > limits.maxCombinedTextureImageUnits)) fail('webgl_texture_units');
});
const templateSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/), revision: z.number().int().positive(), name: z.string().min(1),
  model: z.string().min(1), os: z.string().regex(/^\d+\.\d+\.\d+$/),
  arch: z.literal('arm64').optional(), bitness: z.literal('64').optional(),
  webglLimits: webglLimitsSchema.optional(),
  physicalScreen: size, renderScreen: size, physicalMemoryGb: z.number().int().positive(),
  browser: z.object({ width: positive.int(), height: positive.int(), dpr: positive.max(5), memory: z.number(), cpu: positive.int(), touch: positive.int(), vendor: z.string().min(1), renderer: z.string().min(1) }).strict(),
  defaultWeight: z.number().int().min(0).max(10000),
  evidence: z.object({ reviewedAt: z.string().date(), status: z.literal('emulation'), measuredAt: z.string().datetime().nullable(), sources: z.array(z.object({ url: z.string().url(), scope: z.string().min(1) }).strict()).min(1), note: z.string().min(1) }).strict(),
}).strict().superRefine((t,ctx)=>{
  const b=t.browser;
  const fail=message=>ctx.addIssue({code:z.ZodIssueCode.custom,message});
  if(Math.abs(b.width*b.dpr-t.renderScreen.width)>2 || Math.abs(b.height*b.dpr-t.renderScreen.height)>2) fail('screen_geometry');
  if(t.renderScreen.width>t.physicalScreen.width || t.renderScreen.height>t.physicalScreen.height) fail('render_exceeds_panel');
  if(![0.25,0.5,1,2,4,8].includes(b.memory) || b.memory!==browserMemory(t.physicalMemoryGb)) fail('browser_memory');
  if(b.vendor==='Qualcomm'&&!/^Adreno\b/.test(b.renderer) || b.vendor==='ARM'&&!/^Mali-/.test(b.renderer)) fail('template_gpu_family');
});
// Catalog policy for the existing Android emulation backend, not a universal RAM API limit.
function browserMemory(gb) {
  const lower=2**Math.floor(Math.log2(gb)),upper=lower*2;
  return Math.max(0.25,Math.min(8,gb-lower<=upper-gb?lower:upper));
}
const catalogSchema=z.object({version:z.string().min(1),publishedAt:z.string().datetime().optional(),templates:z.array(templateSchema).min(1)}).strict().superRefine((c,ctx)=>{
 if(new Set(c.templates.map(t=>t.id)).size!==c.templates.length)ctx.addIssue({code:z.ZodIssueCode.custom,message:'duplicate_template'});
 if(c.version!=='android-catalog-2026-10-v1'&&(!c.publishedAt||c.templates.some(t=>!t.webglLimits||!t.arch||!t.bitness)))ctx.addIssue({code:z.ZodIssueCode.custom,message:'catalog_v2_metadata'});
});
function freeze(value){if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
const DEVICE_CATALOG=freeze(catalogSchema.parse(catalog));
// Never edit archived releases. Add each new catalog here before activating it.
const archivedCatalogs=[require('./device-catalog-archive/android-catalog-2026-10-v1.json'),require('./device-catalog-archive/android-catalog-2026-10-v2.json')];
function createCatalogRegistry(current, archives) {
 const versions=new Map();
 for(const input of [...archives,current]) {
  const entry=freeze(catalogSchema.parse(input));
  const previous=versions.get(entry.version);
  if(previous && JSON.stringify(previous)!==JSON.stringify(entry))throw Error('catalog_version_reused:'+entry.version);
  versions.set(entry.version,entry);
 }
 return Object.freeze({get:version=>versions.get(version)});
}
const CATALOG_REGISTRY=createCatalogRegistry(DEVICE_CATALOG,archivedCatalogs);
const DEFAULT_WEIGHTS=freeze(Object.fromEntries(DEVICE_CATALOG.templates.map(t=>[t.id,t.defaultWeight])));
function weightsSchemaFor(source=DEVICE_CATALOG){return z.record(z.number().finite().int().min(0).max(10000)).superRefine((weights,ctx)=>{
 const ids=source.templates.map(t=>t.id);
 if(Object.keys(weights).length!==ids.length||ids.some(id=>!Object.hasOwn(weights,id))||Object.keys(weights).some(id=>!ids.includes(id)))ctx.addIssue({code:z.ZodIssueCode.custom,message:'Укажите веса всех моделей каталога без неизвестных моделей.'});
 if(!Object.values(weights).some(w=>w>0))ctx.addIssue({code:z.ZodIssueCode.custom,message:'Хотя бы одна модель должна иметь положительный вес.'});
});}
const weightsSchema=weightsSchemaFor();
function resolveWeights(value){
 if(!value||!Object.keys(value).length)return {...DEFAULT_WEIGHTS};
 if(weightsSchema.safeParse(value).success)return weightsSchema.parse(value);
 // Stored custom distributions from an older catalog keep their proportions.
 // New models stay disabled until an explicit settings update activates them.
 for(const source of archivedCatalogs){
  if(source.version!==DEVICE_CATALOG.version&&weightsSchemaFor(source).safeParse(value).success){
   return weightsSchema.parse(Object.fromEntries(DEVICE_CATALOG.templates.map(t=>[t.id,value[t.id]??0])));
  }
 }
 return weightsSchema.parse(value);
}
function selectTemplate(seed,weights=DEFAULT_WEIGHTS,source=DEVICE_CATALOG){
 weights=weightsSchemaFor(source).parse(weights);
 const fraction=createHash('sha256').update('orbit-device-v1:'+seed).digest().readUIntBE(0,6)/2**48;
 const total=Object.values(weights).reduce((a,b)=>a+b,0);let position=fraction*total;
 for(const t of source.templates){position-=weights[t.id];if(position<0)return t;}
 throw Error('device_selection_failed');
}
function findTemplate(id,version=DEVICE_CATALOG.version,revision){return CATALOG_REGISTRY.get(version)?.templates.find(t=>t.id===id&&(revision===undefined||t.revision===revision));}
function templateIssues(passport,registry=CATALOG_REGISTRY){
 const reference=passport.deviceTemplate;
 if(passport.source!=='local')return reference?['provider_local_template']:[];
 const source=reference&&registry.get(reference.catalogVersion);
 if(!source)return ['device_template_version'];
 const t=source.templates.find(t=>t.id===reference.id);
 if(!t)return ['device_template_missing'];
 const n=passport.fingerprint?.navigator,s=passport.fingerprint?.screen,g=passport.fingerprint?.videoCard;
 const issues=[];const check=(ok,code)=>{if(!ok)issues.push(code);};
 check(reference.revision===t.revision,'device_template_version');
 check(n?.userAgentData?.model===t.model&&n?.userAgentData?.platformVersion===t.os,'device_template_identity');
 check(g?.vendor===t.browser.vendor&&g?.renderer===t.browser.renderer,'device_template_gpu');
 if(t.webglLimits)check(Object.entries(t.webglLimits).every(([key,value])=>JSON.stringify(passport.fingerprint?.webglLimits?.[key])===JSON.stringify(value)),'device_template_webgl_limits');
 check(s?.width===t.browser.width&&s?.height===t.browser.height&&s?.devicePixelRatio===t.browser.dpr,'device_template_screen');
 check(n?.deviceMemory===t.browser.memory&&n?.hardwareConcurrency===t.browser.cpu&&n?.maxTouchPoints===t.browser.touch,'device_template_hardware');
 const distribution=passport.generation?.distribution;
 try{
  if(!distribution||distribution.algorithm!=='sha256-weighted-v1'||!Number.isInteger(distribution.revision)||distribution.revision<1)throw Error();
  const weights=weightsSchemaFor(source).parse(distribution.weights);
  const selected=distribution.fixedTemplateId?source.templates.find(t=>t.id===distribution.fixedTemplateId):selectTemplate(passport.seed,weights,source);
  check(selected?.id===t.id,'device_distribution_selection');
 }catch{issues.push('device_distribution_invalid');}
 return issues;
}
function providerIssues(fingerprint,catalogVersion=DEVICE_CATALOG.version){
 const n=fingerprint?.navigator,h=n?.userAgentData,g=fingerprint?.videoCard,issues=[];
 if(![0.25,0.5,1,2,4,8].includes(n?.deviceMemory))issues.push('android_device_memory');
 if(!h?.model||!/^\d+\.\d+\.\d+$/.test(h?.platformVersion||''))issues.push('android_device_identity');
 const known=(CATALOG_REGISTRY.get(catalogVersion)?.templates||[]).filter(t=>t.model===h?.model);
 if(known.length&&!known.some(t=>typeof g?.vendor==='string'&&typeof g?.renderer==='string'&&g.vendor.includes(t.browser.vendor)&&g.renderer.includes(t.browser.renderer)))issues.push('device_model_gpu');
 return issues;
}
module.exports={CATALOG_REGISTRY,createCatalogRegistry,weightsSchemaFor,DEVICE_CATALOG,DEFAULT_WEIGHTS,webglLimitsSchema,templateSchema,catalogSchema,weightsSchema,browserMemory,resolveWeights,selectTemplate,findTemplate,templateIssues,providerIssues};