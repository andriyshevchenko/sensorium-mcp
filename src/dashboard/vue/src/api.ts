let authToken = ''

export function setToken(token: string): void {
  authToken = token
}

export function getToken(): string {
  return authToken
}

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Authorization': `Bearer ${authToken}`,
      'Content-Type': 'application/json',
      ...(options?.headers ?? {}),
    },
  })
  if (!res.ok) {
    const err = new Error(res.statusText) as Error & { status: number }
    err.status = res.status
    throw err
  }
  return res.json() as Promise<T>
}
