#!/bin/sh
chown -R bun:bun /app/data
exec su -s /bin/sh bun -c "bun run src/index.ts"
