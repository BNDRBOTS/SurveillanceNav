# Surveillance Transparency Navigator — developer entry points
.PHONY: install dev build start migrate migrate-down seed seed-perf test test-server test-web typecheck lint audit contrast icons basemap compose clean

install:           ## install all workspace dependencies
	npm install

dev:               ## run API (4000) + web dev server (5173, proxied) together
	npm run dev

build:             ## typecheck + production build (server bundle + web dist)
	npm run build

start: build       ## run the production server (serves built web same-origin)
	npm start

migrate:           ## apply pending database migrations
	npm run migrate -w server

migrate-down:      ## roll back the most recent migration
	cd server && npx tsx src/db/migrate.ts down 1

seed:              ## seed reference data + demo dataset (idempotent)
	npm run seed -w server

seed-perf:         ## seed ~100k+ assets for performance testing
	cd server && SEED_SCALE=perf SEED_FORCE=true npx tsx src/db/seed.ts

test:              ## run every test suite (server integration + web)
	npm test

test-server:
	npm run test -w server

test-web:
	npm run test -w web

typecheck:
	npm run typecheck

lint:
	npx eslint .

contrast:          ## WCAG 2.2 token contrast audit (CI gate)
	node scripts/contrast-audit.mjs

audit: typecheck lint contrast test build  ## the full local audit gate

icons:             ## regenerate PWA icons
	node scripts/gen-icons.mjs

basemap:           ## regenerate the bundled offline basemap from us-atlas
	node scripts/gen-basemap.mjs

compose:           ## full stack via docker (PostGIS+Redis+MinIO+app)
	docker compose up --build

clean:
	rm -rf server/dist web/dist node_modules/.vite
