export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function isNotFoundError(err: unknown): boolean {
  const e = err as { name?: string; data?: { name?: string } } | null | undefined
  const name = e?.name
  const dataName = e?.data?.name
  return name === 'NotFoundError' || dataName === 'NotFoundError'
}
