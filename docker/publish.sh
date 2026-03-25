#!/bin/sh
set -e

SERVER_URL="${SPACETIMEDB_SERVER:-http://spacetimedb:3000}"
DB_NAME="${SPACETIMEDB_DB_NAME:-game}"
MAX_RETRIES=30
RETRY_INTERVAL=2

echo "Waiting for SpacetimeDB at $SERVER_URL..."

for i in $(seq 1 $MAX_RETRIES); do
  if curl -sf "$SERVER_URL/v1/ping" > /dev/null 2>&1 || curl -sf "$SERVER_URL/database/ping" > /dev/null 2>&1; then
    echo "SpacetimeDB is ready!"
    break
  fi
  if [ "$i" = "$MAX_RETRIES" ]; then
    echo "SpacetimeDB did not become ready after $MAX_RETRIES attempts, trying to publish anyway..."
  fi
  echo "Attempt $i/$MAX_RETRIES - waiting ${RETRY_INTERVAL}s..."
  sleep $RETRY_INTERVAL
done

echo "Publishing module to $SERVER_URL as '$DB_NAME'..."
spacetime publish \
  --server "$SERVER_URL" \
  --module-path /app/spacetimedb \
  --delete-data=on-conflict \
  --yes \
  "$DB_NAME"

echo "Module published successfully!"
