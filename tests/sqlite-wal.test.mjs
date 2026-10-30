import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';

test('setup enables persistent WAL, is repeatable, and readers see committed data during an uncommitted writer',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'orbit-wal-'));const file=join(dir,'test.db');let a,b;
 try{
 for(let i=0;i<2;i++)execFileSync(process.execPath,['scripts/ensure-sqlite.mjs'],{env:{...process.env,DATABASE_URL:`file:${file}`}});
 a=new DatabaseSync(file);b=new DatabaseSync(file);
 assert.equal(a.prepare('PRAGMA journal_mode').get().journal_mode,'wal');
 a.exec('CREATE TABLE fixture(value INTEGER); INSERT INTO fixture VALUES(1); BEGIN IMMEDIATE; UPDATE fixture SET value=2');
 assert.equal(b.prepare('SELECT value FROM fixture').get().value,1);
 a.exec('COMMIT');assert.equal(b.prepare('SELECT value FROM fixture').get().value,2);
 }finally{b?.close();a?.close();await rm(dir,{recursive:true,force:true});}
});
