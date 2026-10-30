import { getDomain } from 'tldts';

// Include the private suffix list: unrelated github.io tenants are not one site.
// Ports and schemes remain fixed; upgrading/changing them requires explicit consent.
export function sameSite(value, origin) {
  try {
    const target=new URL(value),source=new URL(origin);
    if (!['http:','https:'].includes(target.protocol) || target.username || target.password || target.protocol!==source.protocol || target.port!==source.port) return false;
    if (target.hostname===source.hostname) return true;
    const domain=getDomain(source.hostname,{allowPrivateDomains:true});
    return Boolean(domain && domain===getDomain(target.hostname,{allowPrivateDomains:true}));
  } catch { return false; }
}
export function navigationAllowed(value, origin, approvedRedirects = []) {
  if(sameSite(value,origin))return true;
  try {
    const target=new URL(value);target.hash='';
    if(!['http:','https:'].includes(target.protocol)||target.username||target.password)return false;
    return approvedRedirects.some(approved=>{const url=new URL(approved);url.hash='';return url.href===target.href;});
  } catch { return false; }
}
