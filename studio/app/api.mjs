/* API 请求模块：全部 POST 带 X-Studio-Request: 1 与 X-Studio-CSRF
 * （进程绑定、与本地会话配套的 CSRF 令牌，服务端要求）。
 * CSRF 令牌经同源 /api/system/status 获取；跨源页面无法读取该响应（无 CORS）。 */

const csrfState = { token: "" };

async function ensureCsrfToken() {
  if (csrfState.token) return csrfState.token;
  const response = await fetch("/api/system/status");
  const payload = await response.json().catch(() => ({ ok: false }));
  if (!payload.ok || !payload.csrfToken) {
    throw new Error("无法取得本地会话令牌，请重新打开工作台。");
  }
  csrfState.token = payload.csrfToken;
  return csrfState.token;
}

async function api(path, body) {
  const csrf = await ensureCsrfToken();
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Studio-Request": "1",
      "X-Studio-CSRF": csrf,
    },
    body: JSON.stringify(body || {}),
  });
  const payload = await response.json().catch(() => ({ ok: false, error: { code: "internal-error", message: "服务返回了无法理解的响应。" } }));
  if (!payload.ok) {
    const error = new Error((payload.error && payload.error.message) || "请求失败。");
    error.code = payload.error && payload.error.code;
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function apiGet(path) {
  const response = await fetch(path);
  const payload = await response.json().catch(() => ({ ok: false, error: { code: "internal-error", message: "服务返回了无法理解的响应。" } }));
  if (!payload.ok) {
    const error = new Error((payload.error && payload.error.message) || "请求失败。");
    error.code = payload.error && payload.error.code;
    throw error;
  }
  return payload;
}

export { api, apiGet, ensureCsrfToken };
