import fp from '../utils/fingerprint.js';
// Inspect only brands from a clean context; desktop OS/hardware are never copied.
export async function readRuntimeBrands(browser) {
  const context=await browser.newContext();
  try {
    await context.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Orbit runtime check</title>'}));
    const page=await context.newPage();await page.goto('https://orbit-runtime.invalid/',{waitUntil:'domcontentloaded'});
    const hints=await page.evaluate(()=>navigator.userAgentData?.getHighEntropyValues(['fullVersionList']));
    const options={nativeBrands:hints?.brands,nativeFullVersionList:hints?.fullVersionList};
    // Fail qualification if the binary returns incomplete or inconsistent metadata.
    if(!options.nativeBrands||!options.nativeFullVersionList)throw Error('runtime_brands_unavailable');
    fp.chromeMetadata({fullVersion:browser.version(),osVersion:'14.0.0',modelCode:'control',...options});
    return options;
  }finally{await context.close();}
}
