# Logging

Write to the Lumiverse server console. Messages are prefixed with `[Spindle:your_identifier]`.

```ts
spindle.log.info('Extension loaded successfully')
spindle.log.warn('Config file not found, using defaults')
spindle.log.error('Failed to connect to API')
```

## Log Levels

| Method | Description |
|--------|-------------|
| `spindle.log.info(message)` | General informational messages |
| `spindle.log.warn(message)` | Warning conditions |
| `spindle.log.error(message)` | Error conditions |
