import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import fp from '../../utils/fingerprint.js';
const legacyIos=JSON.parse(readFileSync(new URL('../fixtures/legacy-ios-profile.json',import.meta.url)));
// iOS is a frozen legacy fixture, never a production generation path.
export function mobileProfileFixture(profileId,mobileOS='android') {
  if(mobileOS==='ios')return {...structuredClone(legacyIos),profileId};
  const seed=createHash('sha256').update(`fixture:${profileId}`).digest('hex').slice(0,32);
  return fp.profileFromPassport(profileId,fp.localPassport({fingerprintMode:'local'},{seed}));
}
