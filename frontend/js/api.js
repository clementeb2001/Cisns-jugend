// Dünner API-Client. Hängt automatisch das JWT an und meldet bei 401 ab.
const API = (() => {
  let token = null;

  function setToken(t) { token = t; }

  async function request(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const resp = await fetch('/api' + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (resp.status === 401) {
      window.dispatchEvent(new CustomEvent('auth-expired'));
      throw new Error('Nicht angemeldet');
    }
    const isJson = (resp.headers.get('content-type') || '').includes('application/json');
    const data = isJson ? await resp.json() : await resp.blob();
    if (!resp.ok) {
      throw new Error((data && data.error) || `Fehler ${resp.status}`);
    }
    return data;
  }

  return {
    setToken,
    get: (p) => request('GET', p),
    post: (p, b) => request('POST', p, b),
    put: (p, b) => request('PUT', p, b),
    del: (p) => request('DELETE', p),

    // Excel-Export als Blob herunterladen
    async downloadExport(query) {
      const headers = {};
      if (token) headers['Authorization'] = 'Bearer ' + token;
      const resp = await fetch('/api/export?' + new URLSearchParams(query), { headers });
      if (!resp.ok) throw new Error('Export fehlgeschlagen');
      return resp.blob();
    },
  };
})();

window.API = API;
