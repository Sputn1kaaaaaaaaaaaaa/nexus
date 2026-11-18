export class ApiError extends Error {
  constructor(status, message, data) {
    super(message)
    this.status = status
    this.data = data
  }
}

export async function api(method, url, body, opts = {}) {
  let res
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      keepalive: opts.keepalive,
      headers: { 'X-Nexus': '1', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch (e) {
    throw new ApiError(0, 'Cannot reach the NEXUS server')
  }
  const text = await res.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  if (!res.ok) throw new ApiError(res.status, (data && data.error) || res.statusText, data)
  return data
}

export const get = (url, params) => api('GET', params ? url + '?' + new URLSearchParams(params) : url)
export const post = (url, body = {}, opts) => api('POST', url, body, opts)
export const put = (url, body = {}, opts) => api('PUT', url, body, opts)
