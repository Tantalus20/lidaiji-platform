/* API 请求模块。 */

/* API 请求模块：全部 POST 带 X-Studio-Request: 1（服务端 CSRF 防线要求）。 */

async function api(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Studio-Request": "1" },
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

export { api, apiGet };

