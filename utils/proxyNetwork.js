const { isIP } = require('node:net');
function networkSnapshot(input) {
 if(!input||typeof input!=='object'||Array.isArray(input))return null;
 const out={};
 for(const key of ['executionId','proxyId'])if(typeof input[key]==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(input[key]))out[key]=input[key];
 if(typeof input.proxyHost==='string'&&/^[a-zA-Z0-9.:[\]-]{1,253}$/.test(input.proxyHost))out.proxyHost=input.proxyHost;
 if(Number.isSafeInteger(input.proxyPort)&&input.proxyPort>0&&input.proxyPort<=65535)out.proxyPort=input.proxyPort;
 if(['http','https','socks5'].includes(input.proxyScheme))out.proxyScheme=input.proxyScheme;
 for(const key of ['browserIp','workerIp','previousIp'])if(typeof input[key]==='string'&&isIP(input[key]))out[key]=input[key];
 if(['pending','observed','failed','disabled'].includes(input.checkStatus))out.checkStatus=input.checkStatus;
 if(['first_observation','changed','unchanged'].includes(input.ipComparison))out.ipComparison=input.ipComparison;
 if(['worker_unknown','matches_worker','differs_from_worker'].includes(input.routeComparison))out.routeComparison=input.routeComparison;
 if(typeof input.checkedAt==='string'&&Number.isFinite(Date.parse(input.checkedAt)))out.checkedAt=new Date(input.checkedAt).toISOString();
 return Object.keys(out).length?out:null;
}
module.exports={networkSnapshot};
