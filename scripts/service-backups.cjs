#!/usr/bin/env node
// Installed outside releases so scheduled backups survive a version rollback.
const {createBackupManager,BackupError}=require('../utils/serviceBackups');
const manager=createBackupManager();
const action=process.argv[2];
(async()=>{if(action==='tick')await manager.tick();else if(action==='job')await manager.performJob(process.argv[3]);else throw new Error('Usage: service-backups.cjs tick|job ID');})().catch(e=>{if(e instanceof BackupError&&e.message.includes('Другая операция'))return;console.error(JSON.stringify({event:'service_backup_error',message:e instanceof BackupError?e.message:'Операция не завершена',at:new Date().toISOString()}));process.exitCode=1;});
