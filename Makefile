.DEFAULT_GOAL := local

DOMAIN ?=
ENV_FILE ?= .env
UNITY_CONFIG ?= ../unity/Assets/StreamingAssets/controller-connection.json
IMAGE ?= $(if $(PHONE_CONTROLLER_IMAGE),$(PHONE_CONTROLLER_IMAGE),nyaran336699/kosen-chanbara-phone-controller:latest)
COMPOSE := $(shell if docker compose version >/dev/null 2>&1; then printf '%s' 'docker compose'; elif command -v docker-compose >/dev/null 2>&1; then printf '%s' 'docker-compose'; fi)

export DOMAIN ENV_FILE UNITY_CONFIG

.PHONY: local up stop down restart logs status docker-up docker-stop docker-status docker-logs production production-down production-logs production-status configure check

local up:
	@./scripts/local-control.sh start

stop down:
	@./scripts/local-control.sh stop

restart:
	@./scripts/local-control.sh restart

logs:
	@./scripts/local-control.sh logs

status:
	@./scripts/local-control.sh status

docker-up:
	@PHONE_CONTROLLER_IMAGE=$(IMAGE) UNITY_CONFIG=$(UNITY_CONFIG) ./scripts/docker-control.sh up

docker-stop:
	@PHONE_CONTROLLER_IMAGE=$(IMAGE) UNITY_CONFIG=$(UNITY_CONFIG) ./scripts/docker-control.sh stop

docker-status:
	@PHONE_CONTROLLER_IMAGE=$(IMAGE) UNITY_CONFIG=$(UNITY_CONFIG) ./scripts/docker-control.sh status

docker-logs:
	@PHONE_CONTROLLER_IMAGE=$(IMAGE) UNITY_CONFIG=$(UNITY_CONFIG) ./scripts/docker-control.sh logs

production: check configure
	@$(COMPOSE) up -d --build
	@$(COMPOSE) ps

production-down: check
	@$(COMPOSE) down

production-logs: check
	@$(COMPOSE) logs -f --tail=100

production-status: check
	@$(COMPOSE) ps

configure:
	@./scripts/configure.sh

check:
	@command -v docker >/dev/null 2>&1 || { echo "Dockerが見つかりません。" >&2; exit 1; }
	@test -n "$(COMPOSE)" || { echo "Docker Composeが使えません。" >&2; exit 1; }
