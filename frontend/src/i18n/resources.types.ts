export const I18N_NAMESPACES = [
  'common',
  'auth',
  'landing',
  'chat',
  'shared',
  'commands',
  'modals',
  'panels',
  'settings',
  'weaver',
  'errors',
] as const

export type I18nNamespace = (typeof I18N_NAMESPACES)[number]
