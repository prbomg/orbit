import { getPageSession } from './page-session.mjs';

// CDP exposes composition updates but no imeCommitText command. insertText is
// used ONLY to commit an active composition; dispatchKeyEvent('char') duplicates
// the composing text. This is Chromium composition, not a physical Android IME.
export async function composeMobileCharacter(page, text, { signal, check = async () => {}, focused = async () => true } = {}) {
  signal?.throwIfAborted();
  await check();
  if (!await focused()) throw Object.assign(new Error('search_input_typing_timeout'), { code: 'search_input_typing_timeout' });
  const session = await getPageSession(page);
  let composing = false;
  try {
    signal?.throwIfAborted();
    composing = true;
    await session.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
    signal?.throwIfAborted();
    // A composition handler may move focus synchronously. Never commit into a
    // different editor. The caller's bounded retry reselects the original field.
    if (!await focused()) throw Object.assign(new Error('search_input_typing_timeout'), { code: 'search_input_typing_timeout' });
    signal?.throwIfAborted();
    await session.send('Input.insertText', { text });
    composing = false;
  } finally {
    if (composing) await session.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 }).catch(() => {});
  }
}
