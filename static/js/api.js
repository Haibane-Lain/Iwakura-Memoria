export function encodePath(id) {
  return id.split("/").map(encodeURIComponent).join("/");
}

export async function triggerDownload(resp) {
  const blob = await resp.blob();
  const disposition = resp.headers.get("Content-Disposition") || "";
  const match = disposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
  let filename = "download";
  if (match && match[1]) {
    filename = match[1].replace(/['"]/g, "");
  }
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

const REQUEST_TIMEOUT_MS = 15000;

async function request(method, url, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const opts = { method, headers: {}, signal: controller.signal };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, opts);
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s: ${method} ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const data = await res.json();
      if (data.detail) detail = typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail);
    } catch {
      /* ignore */
    }
    const err = new Error(detail);
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return null;
  return res.json();
}

export const api = {
  get: (url) => request("GET", url),
  post: (url, body) => request("POST", url, body),
  put: (url, body) => request("PUT", url, body),
  patch: (url, body) => request("PATCH", url, body),
  del: (url) => request("DELETE", url),

  settings: {
    get: () => api.get("/api/settings"),
    update: (patch) => api.put("/api/settings", patch),
  },

  projects: {
    list: () => api.get("/api/projects"),
    create: (name) => api.post("/api/projects", { name }),
    get: (id) => api.get(`/api/projects/${encodePath(id)}`),
    rename: (id, title) => api.patch(`/api/projects/${encodePath(id)}`, { title }),
    remove: (id) => api.del(`/api/projects/${encodePath(id)}`),
    tree: (id, scope) =>
      api.get(`/api/projects/${encodePath(id)}/tree${scope ? `?scope=${scope}` : ""}`),
    setGoal: (id, wordsPerDay, enabled) =>
      api.put(`/api/projects/${encodePath(id)}/goal`, { wordsPerDay, enabled }),
    exportUrl: (id) => `/api/projects/${encodePath(id)}/export`,
    export: async (id, payload) => {
      const url = `/api/projects/${encodePath(id)}/export`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        let detail = `${res.status} ${res.statusText}`;
        try {
          const data = await res.json();
          if (data.detail) detail = typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail);
        } catch {
          /* ignore */
        }
        throw new Error(detail);
      }
      return res;
    },
    stats: (id) => api.get(`/api/projects/${encodePath(id)}/stats`),
    wiki: (id) => api.get(`/api/projects/${encodePath(id)}/wiki`),
    dictionary: {
      get: (id) => api.get(`/api/projects/${encodePath(id)}/dictionary`),
      update: (id, words) => api.put(`/api/projects/${encodePath(id)}/dictionary`, { words }),
    },
  },

  docs: {
    create: (pid, payload) =>
      api.post(`/api/projects/${encodePath(pid)}/documents`, payload),
    get: (pid, docId) =>
      api.get(`/api/projects/${encodePath(pid)}/documents/${encodePath(docId)}`),
    save: (pid, docId, content) =>
      api.put(`/api/projects/${encodePath(pid)}/documents/${encodePath(docId)}`, { content }),
    style: (pid, docId, payload) =>
      api.put(`/api/projects/${encodePath(pid)}/documents/${encodePath(docId)}/style`, payload),
    rename: (pid, docId, title) =>
      api.patch(`/api/projects/${encodePath(pid)}/documents/${encodePath(docId)}`, { title }),
    remove: (pid, docId) =>
      api.del(`/api/projects/${encodePath(pid)}/documents/${encodePath(docId)}`),
    move: (pid, docId, folder, index) =>
      api.put(`/api/projects/${encodePath(pid)}/documents/move`, { docId, folder: folder || null, index }),
    reorder: (pid, orderedIds, folder) =>
      api.put(`/api/projects/${encodePath(pid)}/documents/reorder`, { orderedIds, folder: folder || null }),
  },

    folders: {
    create: (pid, name, parent) =>
      api.post(`/api/projects/${encodePath(pid)}/folders`, { name, parent: parent || null }),
    rename: (pid, folderId, name) =>
      api.patch(`/api/projects/${encodePath(pid)}/folders/${encodePath(folderId)}`, { name }),
    remove: (pid, folderId) =>
      api.del(`/api/projects/${encodePath(pid)}/folders/${encodePath(folderId)}`),
    move: (pid, folderId, targetFolder, index) =>
      api.put(`/api/projects/${encodePath(pid)}/folders/move`, { folderId, targetFolder: targetFolder || null, index }),
  },

  templates: {
    list: (pid) => api.get(`/api/projects/${encodePath(pid)}/templates`),
    create: (pid, name, sections) =>
      api.post(`/api/projects/${encodePath(pid)}/templates`, { name, sections }),
    update: (pid, tplId, patch) =>
      api.put(`/api/projects/${encodePath(pid)}/templates/${encodePath(tplId)}`, patch),
    remove: (pid, tplId) =>
      api.del(`/api/projects/${encodePath(pid)}/templates/${encodePath(tplId)}`),
  },

  ai: {
    status: () => api.get("/api/ai/status"),
    test: () => api.post("/api/ai/test"),
    chat: (pid, payload) =>
      api.post(`/api/projects/${encodePath(pid)}/ai/chat`, payload),
    chatStream: async (pid, payload) => {
      const res = await fetch(`/api/projects/${encodePath(pid)}/ai/chat/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        let detail = `${res.status} ${res.statusText}`;
        try {
          const data = await res.json();
          if (data.detail) detail = typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail);
        } catch {
          /* ignore */
        }
        throw new Error(detail);
      }
      return res.body;
    },
    confirm: (pid, sessionId, decision) =>
      api.post(`/api/projects/${encodePath(pid)}/ai/confirm`, { sessionId, decision }),
    compress: (pid, sessionId, keepMessages) =>
      api.post(`/api/projects/${encodePath(pid)}/ai/sessions/${encodePath(sessionId)}/compress`, { keepMessages }),
    attach: (pid, sessionId, file) => {
      const fd = new FormData();
      fd.append("file", file);
      return fetch(`/api/projects/${encodePath(pid)}/ai/sessions/${encodePath(sessionId)}/attachments`, {
        method: "POST",
        body: fd,
      }).then(async (res) => {
        if (!res.ok) {
          let detail = `${res.status} ${res.statusText}`;
          try {
            const data = await res.json();
            if (data.detail) detail = typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail);
          } catch {
            /* ignore */
          }
          throw new Error(detail);
        }
        return res.json();
      });
    },
    removeAttachment: (pid, sessionId, attachmentId) =>
      api.del(`/api/projects/${encodePath(pid)}/ai/sessions/${encodePath(sessionId)}/attachments/${encodePath(attachmentId)}`),
    sessions: {
      list: (pid) => api.get(`/api/projects/${encodePath(pid)}/ai/sessions`),
      create: (pid) => api.post(`/api/projects/${encodePath(pid)}/ai/sessions`),
      get: (pid, sessionId) =>
        api.get(`/api/projects/${encodePath(pid)}/ai/sessions/${encodePath(sessionId)}`),
      rename: (pid, sessionId, title) =>
        api.patch(`/api/projects/${encodePath(pid)}/ai/sessions/${encodePath(sessionId)}`, { title }),
      remove: (pid, sessionId) =>
        api.del(`/api/projects/${encodePath(pid)}/ai/sessions/${encodePath(sessionId)}`),
    },
  },
};
