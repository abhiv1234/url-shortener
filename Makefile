.PHONY: up down migrate run test worker

up:
	docker compose up -d

down:
	docker compose down

migrate:
	@echo "Run migrations after Phase 1 implementation"

run:
	@echo "Run server after Phase 1 implementation"

test:
	@echo "Run tests after Phase 1 implementation"

worker:
	@echo "Run click worker after Phase 3 implementation"
