import axios from 'axios';

function normalizeApiBaseUrl(value?: string) {
  const trimmed = value?.trim().replace(/\/+$/, '');
  if (!trimmed) return '';

  try {
    const url = new URL(trimmed, window.location.origin);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      url.pathname = '';
      url.search = '';
      url.hash = '';
    }

    return url.toString().replace(/\/+$/, '');
  } catch {
    return trimmed.replace(/\/api(?:\/.*)?$/i, '');
  }
}

function extractMessage(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message || null;
  if (Array.isArray(value)) {
    const messages = value.map(extractMessage).filter(Boolean);
    return messages.length ? messages.join(', ') : null;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return (
      extractMessage(record.error) ||
      extractMessage(record.message) ||
      extractMessage(record.detail) ||
      extractMessage(record.title) ||
      extractMessage(record.errors) ||
      (record.code ? String(record.code) : null)
    );
  }

  return String(value);
}

export function configureApiClient() {
  const apiBaseUrl = normalizeApiBaseUrl(
    import.meta.env.VITE_API_BASE_URL || import.meta.env.VITE_API_URL,
  );

  if (apiBaseUrl) {
    axios.defaults.baseURL = apiBaseUrl;
  }
}

export function apiErrorMessage(error: unknown, fallback: string) {
  const responsePayload = (error as { response?: { data?: unknown } })?.response?.data;
  return extractMessage(responsePayload) || extractMessage(error) || fallback;
}
