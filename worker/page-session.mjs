// One page-lifetime session owns both network overrides and native input.
// A gesture must not detach it: that would reset the page's Client Hints.
export const pageSessions = new WeakMap();
const pendingSessions = new WeakMap();

export async function getPageSession(page) {
  const existing = pageSessions.get(page);
  if (existing) return existing;
  if (pendingSessions.has(page)) return pendingSessions.get(page);
  const pending = (async () => {
    const session = await page.context().newCDPSession(page);
    if (page.isClosed()) {
      await session.detach().catch(() => {});
      throw new Error('Page is closed');
    }
    const closed = () => {
      if (pageSessions.get(page) === session) pageSessions.delete(page);
      void session.detach().catch(() => {});
    };
    session.once('close', () => {
      if (pageSessions.get(page) === session) pageSessions.delete(page);
      page.off('close', closed);
    });
    page.once('close', closed);
    pageSessions.set(page, session);
    return session;
  })();
  pendingSessions.set(page, pending);
  try { return await pending; }
  finally { if (pendingSessions.get(page) === pending) pendingSessions.delete(page); }
}
