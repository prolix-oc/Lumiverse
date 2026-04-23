import { get, post, del } from './client'

export interface PushSubscriptionRecord {
  id: string
  user_id: string
  endpoint: string
  user_agent: string
  label: string
  created_at: number
  updated_at: number
}

export interface PushTestResult {
  success: boolean
  sent: number
  reason?: 'no_subscriptions' | 'disabled' | 'event_disabled'
}

export const pushApi = {
  getVapidPublicKey() {
    return get<{ publicKey: string }>('/push/vapid-public-key')
  },

  listSubscriptions() {
    return get<PushSubscriptionRecord[]>('/push/subscriptions')
  },

  subscribe(subscription: PushSubscriptionJSON) {
    return post<PushSubscriptionRecord>('/push/subscriptions', {
      endpoint: subscription.endpoint,
      keys: subscription.keys,
      userAgent: navigator.userAgent,
    })
  },

  unsubscribe(id: string) {
    return del<{ success: boolean }>(`/push/subscriptions/${id}`)
  },

  test() {
    return post<PushTestResult>('/push/subscriptions/test')
  },
}
