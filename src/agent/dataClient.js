// 站点数据 API 客户端（同源）：账单与画像数据走平台 Function，不读取凭证。
export const DATA_CLIENT_PATHS = Object.freeze({
  bills: '/functions/v1/app/api/bills',
  profile: '/functions/v1/app/api/profile',
  facts: '/functions/v1/app/api/profile/facts',
  summary: '/functions/v1/app/api/profile/summary',
  rules: '/functions/v1/app/api/rules',
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export const DATA_CLIENT_CODES = Object.freeze({
  CONFIG: 'E_DATA_CONFIG',
  REQUEST: 'E_DATA_REQUEST',
  NETWORK: 'E_DATA_NETWORK',
  ABORTED: 'E_DATA_ABORTED',
  STATUS: 'E_DATA_STATUS',
  JSON: 'E_DATA_JSON',
  RESPONSE: 'E_DATA_RESPONSE',
});

const FIXED_MESSAGES = Object.freeze({
  [DATA_CLIENT_CODES.CONFIG]: '数据接口配置非法',
  [DATA_CLIENT_CODES.REQUEST]: '数据请求内容非法',
  [DATA_CLIENT_CODES.NETWORK]: '数据接口网络请求失败',
  [DATA_CLIENT_CODES.ABORTED]: '数据请求已取消',
  [DATA_CLIENT_CODES.STATUS]: '数据接口返回非成功状态',
  [DATA_CLIENT_CODES.JSON]: '数据接口响应不是合法 JSON',
  [DATA_CLIENT_CODES.RESPONSE]: '数据接口响应格式非法',
});

function dataError(code, extra = {}) {
  const error = new Error(FIXED_MESSAGES[code] ?? FIXED_MESSAGES[DATA_CLIENT_CODES.RESPONSE]);
  error.code = code;
  return Object.assign(error, extra);
}

export function createDataClient({
  fetchImpl = globalThis.fetch,
  paths = DATA_CLIENT_PATHS,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl 必须为函数');
  if (paths === null || typeof paths !== 'object') throw new TypeError('paths 必须为对象');
  const routes = { ...DATA_CLIENT_PATHS, ...paths };

  async function request(path, { method = 'GET', body, signal } = {}) {
    let response;
    try {
      response = await fetchImpl(path, {
        method,
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal,
      });
    } catch (error) {
      if ((signal && signal.aborted) || (error && error.name === 'AbortError')) {
        throw dataError(DATA_CLIENT_CODES.ABORTED);
      }
      throw dataError(DATA_CLIENT_CODES.NETWORK);
    }
    if (signal && signal.aborted) throw dataError(DATA_CLIENT_CODES.ABORTED);
    if (response === null || typeof response !== 'object' || typeof response.ok !== 'boolean') {
      throw dataError(DATA_CLIENT_CODES.RESPONSE);
    }
    if (!response.ok) {
      const error = dataError(DATA_CLIENT_CODES.STATUS, { status: Number.isInteger(response.status) ? response.status : null });
      try {
        const payload = await response.json();
        if (payload && typeof payload.error === 'string') error.upstreamCode = payload.error;
        else if (payload && typeof payload.code === 'string') error.upstreamCode = payload.code;
      } catch { /* 错误体不是 JSON 时只保留 HTTP 状态 */ }
      throw error;
    }
    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      if ((signal && signal.aborted) || (error && error.name === 'AbortError')) {
        throw dataError(DATA_CLIENT_CODES.ABORTED);
      }
      throw dataError(DATA_CLIENT_CODES.JSON);
    }
    if (signal && signal.aborted) throw dataError(DATA_CLIENT_CODES.ABORTED);
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload) || payload.ok !== true) {
      throw dataError(DATA_CLIENT_CODES.RESPONSE);
    }
    return payload;
  }

  function idPath(id, suffix = '') {
    if (typeof id !== 'string' || !UUID_RE.test(id)) throw dataError(DATA_CLIENT_CODES.REQUEST);
    return `${routes.bills}/${id}${suffix}`;
  }

  return Object.freeze({
    saveBill({ body, signal } = {}) {
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        throw dataError(DATA_CLIENT_CODES.REQUEST);
      }
      return request(routes.bills, { method: 'POST', body, signal });
    },
    listBills({ limit = 20, offset = 0, signal } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 50
        || !Number.isInteger(offset) || offset < 0 || offset > 100000) {
        throw dataError(DATA_CLIENT_CODES.REQUEST);
      }
      return request(`${routes.bills}?limit=${limit}&offset=${offset}`, { signal });
    },
    deleteBill({ id, signal } = {}) {
      return request(idPath(id), { method: 'DELETE', signal });
    },
    getBill({ id, signal } = {}) {
      return request(idPath(id), { signal });
    },
    saveSnapshot({ id, snapshot, signal } = {}) {
      if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
        throw dataError(DATA_CLIENT_CODES.REQUEST);
      }
      return request(idPath(id, '/snapshot'), { method: 'POST', body: { snapshot }, signal });
    },
    getProfile({ signal } = {}) {
      return request(routes.profile, { signal });
    },
    getRules({ signal } = {}) {
      return request(routes.rules, { signal });
    },
    saveRules({ versions, signal } = {}) {
      if (!Array.isArray(versions)) throw dataError(DATA_CLIENT_CODES.REQUEST);
      return request(routes.rules, { method: 'PUT', body: { versions }, signal });
    },
    deleteFact({ id, signal } = {}) {
      if (typeof id !== 'string' || !UUID_RE.test(id)) throw dataError(DATA_CLIENT_CODES.REQUEST);
      return request(`${routes.facts}/${id}`, { method: 'DELETE', signal });
    },
    saveFacts({ facts, signal } = {}) {
      if (!Array.isArray(facts) || facts.length === 0) throw dataError(DATA_CLIENT_CODES.REQUEST);
      return request(routes.facts, { method: 'POST', body: { facts }, signal });
    },
    saveProfileSummary({ digest, summary, signal } = {}) {
      if (digest === null || typeof digest !== 'object' || Array.isArray(digest)
        || summary === null || typeof summary !== 'object' || Array.isArray(summary)) {
        throw dataError(DATA_CLIENT_CODES.REQUEST);
      }
      return request(routes.summary, { method: 'POST', body: { digest, summary }, signal });
    },
  });
}
