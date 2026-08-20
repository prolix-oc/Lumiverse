import { createProductivityHostSurfaceModule } from '../../shared/productivity-host-surface'
import { CONNECTIONS_PICKER_SETTINGS_KEY, normalizeConnectionsPickerSettings } from './settings-model'

export function createConnectionsPickerModule() {
  return createProductivityHostSurfaceModule({
    id: 'connections_picker',
    surfaceId: 'connections_picker.panel',
    settingsKey: CONNECTIONS_PICKER_SETTINGS_KEY,
    coreSettingsKey: 'connectionsPickerSettings',
    normalize: normalizeConnectionsPickerSettings,
    enabled: settings => settings.enabled,
    mountPoint: () => 'chat_actions',
    quickToolbarAction: {
      id: 'lumiverse_suite.connections_picker.open',
      label: 'Connections Picker',
      subtitle: 'Choose the active connection and model',
      iconName: 'waypoints',
    },
  })
}
