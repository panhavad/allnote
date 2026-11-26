const rnd = new Uint8Array(12);
crypto.getRandomValues(rnd);
export const clientId = Array.from(rnd, (b) => b.toString(16).padStart(2, '0')).join('');

export async function api(method, url, body, { timeoutMs = 20_000 } = {}) {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Client-Id': clientId },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (res.status === 403 && String(data?.code || '').startsWith('account_')) {
    window.dispatchEvent(new CustomEvent('allnote:account'));
  }
  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const get = (url) => api('GET', url);
export const post = (url, body = {}) => api('POST', url, body);
export const put = (url, body = {}) => api('PUT', url, body);
export const del = (url) => api('DELETE', url);
