.PHONY: help install up up-all down logs migrate run worker cleanup build test test-integration lint typecheck check load-test

help: ## Show available targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "}; {printf "  %-18s %s\n", $$1, $$2}'

install: ## Install dependencies
	npm ci

up: ## Start Postgres, Redis and Redpanda for local development
	docker compose up -d

up-all: ## Build and start the full stack (api, worker, cleaner, Prometheus)
	docker compose --profile app up -d --build

down: ## Stop everything
	docker compose --profile app down

logs: ## Tail full-stack logs
	docker compose --profile app logs -f api worker cleaner

migrate: ## Apply database migrations
	npm run migrate

run: ## Run the API with hot reload
	npm run dev

worker: ## Run the Kafka click consumer
	npm run worker

cleanup: ## Purge expired links once
	npm run cleanup -- --once

build: ## Compile TypeScript to dist/
	npm run build

test: ## Unit + HTTP tests (no infrastructure needed)
	npm test

test-integration: ## Integration tests against Postgres + Redis (make up && make migrate first)
	npm run test:integration

lint: ## ESLint
	npm run lint

typecheck: ## TypeScript, including tests
	npm run typecheck

check: ## Lint + typecheck + tests
	npm run check

load-test: ## 10:1 read/write load test (server must run with RATE_LIMIT_ENABLED=false)
	npm run load-test
