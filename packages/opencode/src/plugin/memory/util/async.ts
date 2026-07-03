export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function isNotFoundError(err: any): boolean {
  const name = err?.name
  const dataName = err?.data?.name
  return name === 'NotFoundError' || dataName === 'NotFoundError'
}
