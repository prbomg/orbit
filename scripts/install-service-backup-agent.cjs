// Run as the same service user, from the prepared release. No root privileges.
const fs=require('node:fs/promises'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {createBackupManager}=require('../utils/serviceBackups');
(async()=>{const root=createBackupManager().root,version=path.join(root,'agents',randomUUID());await fs.mkdir(version,{recursive:true,mode:0o700});
 for(const name of ['scripts/service-backups.cjs','utils/serviceBackups.js','utils/serviceBackupRestore.js','utils/serviceResources.js','utils/releaseManager.js']){const dest=path.join(version,name);await fs.mkdir(path.dirname(dest),{recursive:true,mode:0o700});await fs.copyFile(path.resolve(name),dest);await fs.chmod(dest,0o600);}
 const temp=path.join(root,'.agent-'+randomUUID());await fs.symlink(version,temp);await fs.rename(temp,path.join(root,'agent'));console.log('Backup agent installed');
})().catch(()=>{console.error('Backup agent installation failed');process.exitCode=1;});
