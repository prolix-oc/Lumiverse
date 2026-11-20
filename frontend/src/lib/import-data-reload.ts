/** A bulk restore can change every independently cached editor and extension.
 * Restart the frontend at the current URL so all mount-time reads come from
 * the committed database. Authentication cookies and native hosting survive.
 */
export function reloadImportedData(userId: string, jobId: string): void {
  try { sessionStorage.setItem(`lumiverse:import-reloaded:${userId}`, jobId) } catch { /* Optional feedback. */ }
  window.location.reload()
}

export function takeImportReloadReceipt(userId: string): string | null {
  try {
    const key = `lumiverse:import-reloaded:${userId}`
    const jobId = sessionStorage.getItem(key)
    sessionStorage.removeItem(key)
    return jobId
  } catch { return null }
}
