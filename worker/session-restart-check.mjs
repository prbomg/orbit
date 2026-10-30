import { isolateVerificationNetwork } from './verification-network.mjs';
import cookieAge from '../utils/cookieAge.js';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-extra';
import {createMobileContext,mobileContextOptions,verifyRestoredSession,ProfileError} from './profiles.mjs';
import snapshots from '../utils/profileSnapshots.js';
import readiness from '../utils/profileReadiness.js';
import { persistentLaunchOptions, closePersistentStartupPages } from './persistent-cache.mjs';

// Verification happens in a separate Chromium process, on local intercepted pages.
export async function verifySessionAfterRestart(staged,{launchOptions={},persistentPath,signal,onBrowser=()=>{}}={}){
 let browser,context,network;
 const abort=()=>{void context?.close().catch(()=>{});void browser?.close().catch(()=>{});};
 signal?.addEventListener('abort',abort,{once:true});
 try{
  signal?.throwIfAborted();
  network=await isolateVerificationNetwork(launchOptions);
  const profile=JSON.parse(await readFile(staged.temporary,'utf8'));
  if(!snapshots.checkSnapshot(profile)||profile.snapshot?.id!==staged.snapshot.snapshot.id)throw new ProfileError('profile_snapshot_mismatch');
  if(persistentPath){context=await chromium.launchPersistentContext(persistentPath,{...persistentLaunchOptions(network.options, profile),...mobileContextOptions(profile),serviceWorkers:'block',offline:true});browser=context.browser();await closePersistentStartupPages(context);await createMobileContext(browser,profile,undefined,context,false);}
  else{browser=await chromium.launch(network.options);context=await createMobileContext(browser,profile);}
  await onBrowser(browser);
  await context.setOffline(true);
  const report={...await verifyRestoredSession(context,profile,{discoverOrigins:Boolean(persistentPath)}),verificationVersion:readiness.VERIFICATION_VERSION,runtimeVersion:browser.version()};
  signal?.throwIfAborted();
  return {...report, cookieObservations:profile.cookieObservations||[],cookieAge:cookieAge.assessCookieAge(profile.cookieObservations), storageCoverage: { version: 1, cookies: 'verified', localStorage: 'verified', indexedDB: 'verified', httpCache: persistentPath ? 'native_allowed_unverified' : 'not_saved', serviceWorkers: persistentPath ? 'allowed_unverified' : 'not_saved', sessionStorage: 'not_saved', tlsResumption: 'not_verified' }, processRestartVerified:true,storageMode:persistentPath?'persistent':'snapshot',sessionCookiesRestored:persistentPath?profile.cookies.filter(c=>c.expires===-1).length:0};
 }finally{signal?.removeEventListener('abort',abort);await context?.close().catch(()=>{});await browser?.close().catch(()=>{});await network?.close();}
}
