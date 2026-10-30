import { behaviorRandom } from './behavior-random.mjs';
export function previewPlan(results,targetDomain,random=behaviorRandom){
 if(random()>=0.65)return [];
 const domain=d=>d.replace(/^www\./,'').toLowerCase(),target=domain(targetDomain);
 const candidates=[...new Map(results.slice(0,5).filter(r=>{const d=domain(r.domain);return d!==target&&!d.endsWith('.'+target);}).map(r=>[domain(r.domain),r])).values()];
 const count=Math.min(1+Math.floor(random()*2),candidates.length),selected=[];
 while(selected.length<count)selected.push(candidates.splice(Math.min(candidates.length-1,Math.floor(random()*candidates.length)),1)[0]);
 return selected;
}
