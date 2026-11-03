# Smart Farmer

Early development foundation for a farm-management application. **Not ready for production or farm operations.** The committed brief is in [docs/product-brief.txt](docs/product-brief.txt); the actual implementation and missing acceptance criteria are recorded in [docs/status.md](docs/status.md).

This slice provides a TypeScript/Fastify API with PostgreSQL, owner registration and sign-in, farm-scoped project and activity endpoints, and a React web interface. It does not yet implement the rest of the product brief, including safe offline use, mobile apps, livestock, inventory, equipment or trading. Do not enter sensitive farm data into this prototype.

## Local development

Requires Node 24, npm and Docker. Each deployable owns its dependencies and lockfile.

```sh
nvm use
cp .env.example .env
# Set a local-only POSTGRES_PASSWORD in .env
# Set DATABASE_URL in your shell using the same password and localhost:5432/smart_farmer
# Set WEB_ORIGIN=http://localhost:5173
npm ci --prefix smart-farmer-backend
npm ci --prefix smart-farmer-frontend/web
docker compose up -d db
npm run migrate --prefix smart-farmer-backend
npm run dev --prefix smart-farmer-backend
# In a second terminal:
npm run dev --prefix smart-farmer-frontend/web
```

The web defaults to `http://localhost:3000`; set `VITE_API_URL` before starting Vite to use another API. Configuration examples contain placeholders and are not automatically loaded by Node. Never commit real credentials.

Run `npm run build` and `npm test`. To run the PostgreSQL integration test, set `TEST_DATABASE_URL` to an isolated test database on which the test user may create and drop schemas, then run `npm test --prefix smart-farmer-backend`. The test creates and removes its own random schema. A skipped integration test is not a pass.

See [architecture and operations](docs/architecture.md) for API and deployment boundaries and [acceptance matrix](docs/status.md) for precise coverage. Native iOS/Android and edge directories are reserved, not runnable applications.
