# @nebgov/indexer

Off-chain governance event indexer for NebGov.

## Quick start

```bash
cp .env.example .env
# Edit .env with your governor contract address
docker-compose up -d
```

## API endpoints

- `GET /proposals?offset=0&limit=20` — paginated proposal list
- `GET /proposals/:id/votes` — votes for a specific proposal
- `GET /delegates?top=20` — top delegates by delegator count
- `GET /profile/:address` — governance activity for an address
