import {execFileSync} from 'node:child_process';
import {mkdir,copyFile,writeFile,readFile} from 'node:fs/promises';
import {resolve,basename} from 'node:path';
import {createHash} from 'node:crypto';
const root=resolve(process.argv[2]||'prepared/browser-fonts');
const wanted=new Set(['Roboto','Noto Sans','Noto Serif','Noto Mono','Noto Sans Mono','Noto Color Emoji','Noto Sans CJK SC','Noto Sans CJK TC','Noto Sans CJK JP','Noto Naskh Arabic','Noto Sans Devanagari','Noto Sans Thai']);
const files=new Map();
for(const line of execFileSync('fc-list',['-f','%{file}\t%{family}\n'],{encoding:'utf8'}).split('\n')){
 const [file,families]=line.split('\t');if(file&&families?.split(',').some(f=>wanted.has(f)))files.set(file,families);
}
for(const name of ['Roboto','Noto Sans','Noto Serif'])if(![...files.values()].some(f=>f.split(',').includes(name)))throw Error(`Missing installed font: ${name}`);
await mkdir(root+'/files',{recursive:true,mode:0o700});await mkdir(root+'/cache',{recursive:true,mode:0o700});
const manifest=[];
for(const [file,families]of files){const bytes=await readFile(file),sha256=createHash('sha256').update(bytes).digest('hex'),name=sha256.slice(0,16)+'-'+basename(file);await copyFile(file,root+'/files/'+name);manifest.push({name,families,sha256});}
const xml=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
await writeFile(root+'/fonts.conf',`<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd"><fontconfig><reset-dirs/><dir>${xml(root+'/files')}</dir><cachedir>${xml(root+'/cache')}</cachedir><alias><family>sans-serif</family><prefer><family>Roboto</family><family>Noto Sans</family></prefer></alias><alias><family>serif</family><prefer><family>Noto Serif</family></prefer></alias><alias><family>monospace</family><prefer><family>Noto Sans Mono</family><family>Noto Mono</family></prefer></alias></fontconfig>\n`,{mode:0o600});
await writeFile(root+'/manifest.json',JSON.stringify({version:1,source:'installed-packages',androidReferenceMeasured:false,files:manifest},null,2)+'\n',{mode:0o600});
execFileSync('fc-cache',['-f'],{env:{...process.env,FONTCONFIG_FILE:root+'/fonts.conf'},stdio:'ignore'});
console.log(JSON.stringify({directory:root,files:manifest.length,fontconfig:root+'/fonts.conf'}));
