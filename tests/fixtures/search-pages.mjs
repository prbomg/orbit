export async function installSearchFixture(context, { targetPage = 2, iframe = false, noNext = false, failure = false, canonicalRoot = false, competitorPopup = false, refinement = false, ajax = false, targetPopup = false } = {}) {
  const visits = []; const typed = [];
  await context.route('**/*', async route => {
    const request = route.request(); const url = new URL(request.url());
    if (!['search.test', 'target.test', 'www.target.test', 'competitor.test', 'target.test.evil'].includes(url.hostname)) { await route.abort(); return; }
    visits.push(url.href);
    const html = body => route.fulfill({ status: failure && url.hostname === 'www.target.test' ? 503 : 200, contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">${body}` });
    if (url.hostname !== 'search.test') {
      await html(`<script>localStorage.setItem('synthetic_search_session', 'saved');</script><h1>Destination</h1><a href="/next">Next</a><main style="height:8000px">Local fixture</main>`); return;
    }
    if (url.pathname === '/typed') { typed.push(request.postData()); await route.fulfill({ status: 204 }); return; }
    if (url.pathname === '/redirect') {
      await route.fulfill({ status: 302, headers: { Location: url.searchParams.get('url') } }); return;
    }
    if (url.pathname === '/') {
      const form = `<form action="http://search.test/search" target="${iframe ? '_parent' : '_blank'}"><textarea name="text" onkeydown="if(event.key==='Enter'){event.preventDefault();this.form.requestSubmit();}" oninput="fetch('http://search.test/typed', {method:'POST',body:this.value})"></textarea><button>Search</button></form>`;
      await html(iframe ? `<form action="/search"><iframe name="search_fixture" class="search-arrow-frame" srcdoc="${form.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"></iframe></form>` : form); return;
    }
    const number = Number(url.searchParams.get('p') ?? 1);
    const result = (refinement ? url.searchParams.get('text') === 'qa brand' && number === 2 : targetPage === number)
      ? `<li class="serp-item"><h2><a target="_blank" onclick="event.preventDefault();location.assign(new window.URL(this.href).searchParams.get('url')${canonicalRoot ? ".replace('www.target.test', 'target.test')" : ''});" href="/redirect?url=${encodeURIComponent('http://www.target.test/landing')}">Target</a></h2></li>`
      : '<li class="serp-item"><h2><a href="http://competitor.test/article">Competitor</a></h2></li>';
    const targetLink = targetPopup && (refinement ? url.searchParams.get('text') === 'qa brand' && number === 2 : targetPage === number)
      ? '<li class="serp-item"><h2><a href="http://www.target.test/landing" target="_blank">Target</a></h2></li>' : result;
    const form = `<form action='/search'><input name='text' value='${url.searchParams.get('text') ?? 'qa'}' oninput="fetch('/typed',{method:'POST',body:this.value})"><button>Search</button></form>`;
    const competitor = `<li class='serp-item'><h2><a ${competitorPopup ? "target='_blank'" : ''} href='http://competitor.test/article'>Competitor</a></h2></li>`;
    const lookalike = targetPage ? '<li class="serp-item"><h2><a href="http://target.test.evil/spoof">Lookalike</a></h2></li>' : '';
    await html(`${form}<h1>Results ${number}</h1><ul>${competitor}${targetLink}${lookalike}<li class="serp-item" data-fast-name="adv"><span class="AdvLabel">Реклама</span><h2><a href="http://target.test/paid">Paid result</a></h2></li></ul>${noNext || number === 5 ? '' : `<nav class="Pager"><a ${ajax ? `onclick="event.preventDefault();const u=this.href;fetch(u).then(r=>r.text()).then(h=>{history.pushState({},\'\',u);document.body.innerHTML=h;});"` : ''} aria-label="Следующая страница" href="/search?text=${encodeURIComponent(url.searchParams.get('text') ?? 'qa')}&p=${number + 1}">Далее</a></nav>`}`);
  });
  return { visits, typed };
}
