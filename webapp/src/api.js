const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8000";

function authHeader() {
  const token = localStorage.getItem("idToken");
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

export async function uploadOcr(file) {
  const form = new FormData();
  form.append("file", file);

  const res = await fetch(`${API_BASE}/api/ocr`, {
    method: "POST",
    body: form,
    headers: {
      ...authHeader(),
    },
  });

  if (!res.ok) {
    throw new Error(await res.text());
  }

  return res.json();
}

export async function createLabel(payload) {
  const res = await fetch(`${API_BASE}/api/labels`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeader(),
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error(await res.text());
  }

  return res.json();
}

export async function listHistory() {
  const res = await fetch(`${API_BASE}/api/history`, {
    headers: {
      ...authHeader(),
    },
  });

  if (!res.ok) {
    throw new Error(await res.text());
  }

  return res.json();
}

export async function requestDownload(labelId) {
  const res = await fetch(`${API_BASE}/api/labels/${labelId}/download`, {
    method: "POST",
    headers: {
      ...authHeader(),
    },
  });

  if (!res.ok) {
    throw new Error(await res.text());
  }

  return res.json();
}
