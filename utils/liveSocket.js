const {createHash}=require('node:crypto');
const {realpathSync}=require('node:fs');
const {resolve}=require('node:path');
function liveSocketPath(runtime,runId,taskId){
 const key=createHash('sha256').update(`${runId}:${taskId}`).digest('hex').slice(0,24);
 let root;try{root=realpathSync(runtime);}catch{root=resolve(runtime);}
 return resolve(root,`stream-${key}.sock`);
}
module.exports={liveSocketPath};
