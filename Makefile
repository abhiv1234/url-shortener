.PHONY: up down migrate run test worker

up:
	docker compose up -d

down:
	docker compose down

migrate:
	npm run migrate

run:
	npm run dev

test:
	npm test

worker:
	@echo "Run click worker after Phase 3 implementation"
