export async function worldBookPayloadFromFile(file: File): Promise<Record<string, any>> {
  const payload = JSON.parse(await file.text())
  if (!payload.name) payload.originalName = file.name.replace(/\.[^.]+$/, '')
  if (!payload.description) payload.description = `Uploaded at ${new Date().toLocaleString()}`
  return payload
}
