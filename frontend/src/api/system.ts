import { get } from './client'

export interface SystemInfo {
  os: {
    platform: string
    arch: string
    release: string
    hostname: string
  }
  cpu: {
    model: string
    cores: number
  }
  memory: {
    total: number
    free: number
  }
  disk: {
    total: number
    used: number
  } | null
  backend: {
    version: string
    runtime: string
  }
  git: {
    branch: string
    commit: string
  }
}

export const systemApi = {
  getInfo: () => get<SystemInfo>('/system/info'),
}
