const {open}=require('node:fs/promises');
async function readEventPage(path,{before,limit=120}={}) {
 if(before!==undefined&&(!Number.isSafeInteger(before)||before<0))throw new Error('invalid_cursor');
 let file;
 try{
  file=await open(path,'r');const {size}=await file.stat();const end=Math.min(before??size,size),length=Math.min(end,256000),start=end-length;
  const buffer=Buffer.alloc(length);await file.read(buffer,0,length,start);
  let at=start>0?buffer.indexOf(10)+1:0;if(start>0&&at===0)return {events:[],nextCursor:start||null};
  const records=[];
  while(at<buffer.length){let next=buffer.indexOf(10,at);if(next<0)next=buffer.length;try{const row=JSON.parse(buffer.subarray(at,next).toString('utf8'));if(row&&typeof row==='object'&&typeof row.time==='string'&&typeof row.event==='string')records.push({...row,_offset:start+at});}catch{}at=next+1;}
  const events=records.slice(-limit),first=events[0]?events[0]._offset:start;
  return {events,nextCursor:first>0?first:null};
 }catch(e){if(e.code==='ENOENT')return {events:[],nextCursor:null};throw e;}finally{await file?.close();}
}
module.exports={readEventPage};
