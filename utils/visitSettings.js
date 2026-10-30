function normalizeSection(value){
 if(typeof value!=='string')throw Error('invalid_section');
 let path=value.trim();try{path=decodeURIComponent(path);}catch{throw Error('invalid_section');}
 if(!path.startsWith('/')||path.startsWith('//')||/[\\?#%\u0000-\u001f\u007f]/.test(path)||path.split('/').some(p=>p==='.'||p==='..')||path.length>500)throw Error('invalid_section');
 return path.replace(/\/+$/,'')||'/';
}
function allowsSection(url,sections=[]){
 if(!sections.length)return true;
 try{const path=normalizeSection(new URL(url).pathname);return sections.some(s=>s==='/'||path===s||path.startsWith(`${s}/`));}catch{return false;}
}
function visitSettings(value){
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('invalid_visit_settings');
 if(!Object.keys(value).length)return null;
 const {minSeconds,maxSeconds,maxInternalTransitions,allowedSections,trackMetrics,disableMetrics}=value;
 if(Object.keys(value).some(k=>!['minSeconds','maxSeconds','maxInternalTransitions','allowedSections','trackMetrics','disableMetrics'].includes(k))||
  !Number.isInteger(minSeconds)||!Number.isInteger(maxSeconds)||minSeconds<15||maxSeconds>1800||minSeconds>maxSeconds||
  !Number.isInteger(maxInternalTransitions)||maxInternalTransitions<0||maxInternalTransitions>10||!Array.isArray(allowedSections)||allowedSections.length>30||
  (trackMetrics!==undefined&&typeof trackMetrics!=='boolean')||
  (disableMetrics!==undefined&&typeof disableMetrics!=='boolean'))throw Error('invalid_visit_settings');
 const result={minSeconds,maxSeconds,maxInternalTransitions,allowedSections:[...new Set(allowedSections.map(normalizeSection))]};
 if(trackMetrics!==undefined)result.trackMetrics=trackMetrics;
 if(disableMetrics!==undefined)result.disableMetrics=disableMetrics;
 return result;
}
module.exports={normalizeSection,allowsSection,visitSettings};