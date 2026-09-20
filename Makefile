.PHONY: help install config secrets dev dev-fake fake-b2 typecheck deps-check test-sigv4 \
        deploy tail health curl purge tf-init tf-plan tf-apply tf-destroy check-b2-env

.DEFAULT_GOAL := help

help:
	@echo "egarots"
	@echo "  make install           Install dependencies"
	@echo "  make config            Create wrangler.toml from the example"
	@echo "  make secrets           Push B2_KEY_ID and B2_APP_KEY to Cloudflare"
	@echo "  make tf-apply          Create the B2 bucket + lifecycle rule with Terraform"
	@echo "  make dev               Run the Worker locally on :8082 (talks to real B2)"
	@echo "  make fake-b2           Run a local signature-checking B2 stand-in on :9000"
	@echo "  make dev-fake          Run the Worker against the stand-in, no credentials"
	@echo "  make typecheck         tsc --noEmit"
	@echo "  make deps-check        Assert src/core imports nothing it must not"
	@echo "  make test-sigv4        Check the signer against the AWS test vector"
	@echo "  make deploy            Publish to Cloudflare"
	@echo "  make tail              Stream production logs"
	@echo "  make health            GET /health"
	@echo "  make curl              Round trip: store bytes, read them back"
	@echo "  make purge ID=abc123   Delete one object out of band (takedown)"
	@echo ""
	@echo "Terraform needs B2_APPLICATION_KEY_ID and B2_APPLICATION_KEY in the environment."
	@echo "Set a DAILY CAP in the B2 console before deploying - see README 'Free tier'."

install:
	npm install

config: wrangler.toml

wrangler.toml:
	@cp wrangler.toml.example wrangler.toml
	@echo "Created wrangler.toml from wrangler.toml.example."
	@echo "Set B2_BUCKET and B2_REGION in it, then run 'make secrets'."

# B2 is an HTTP API, not a binding, so these are real credentials. Scope the
# application key to this one bucket, read+write, in the B2 console.
secrets: wrangler.toml
	npx wrangler secret put B2_KEY_ID
	npx wrangler secret put B2_APP_KEY

dev: wrangler.toml
	@test -f .dev.vars || (echo "No .dev.vars - copy .dev.vars.example and fill it in,"; \
	  echo "or run 'make dev-fake' to work without B2 credentials."; exit 1)
	npx wrangler dev --port 8082

# A local stand-in that recomputes the SigV4 signature and rejects a mismatch,
# so the signer is genuinely exercised without touching the account or the bill.
fake-b2:
	node scripts/fake-b2.mjs

dev-fake: wrangler.toml
	@echo "Point B2_ENDPOINT at http://127.0.0.1:9000 in wrangler.toml, and put"
	@echo "B2_KEY_ID=test-key-id / B2_APP_KEY=test-app-key in .dev.vars."
	@echo "Run 'make fake-b2' in another shell first."
	npx wrangler dev --port 8082

test-sigv4:
	node --experimental-strip-types scripts/sigv4-test.mts

typecheck:
	npx tsc --noEmit

# There is no linter and there are no tests, so this grep is the only thing
# standing between the project and a quiet dependency-rule violation.
deps-check:
	@! grep -rEn "from \"(\.\./)*(adapter|app)/|from \"hono" src/core \
	  || (echo "src/core imported an adapter, the app layer, or Hono"; exit 1)
	@echo "core is clean"

deploy: wrangler.toml
	npx wrangler deploy

tail: wrangler.toml
	npx wrangler tail

health:
	curl -sS http://localhost:8082/health
	@echo

curl:
	@printf 'hello from egarots' | curl -sS -X POST \
	  'http://localhost:8082/api/objects?ttl=3600&filename=hello.txt' \
	  -H 'content-type: text/plain; charset=utf-8' --data-binary @- \
	  | tee /dev/stderr \
	  | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' > /tmp/egarots-id
	@echo
	@curl -sS -D - "http://localhost:8082/$$(cat /tmp/egarots-id)"
	@echo

# Uploads are anonymous and there is no delete endpoint by design, so this is
# the operator's only takedown path. Needs the B2 CLI, or use the web console.
purge:
	@test -n "$(ID)" || (echo "usage: make purge ID=<object id>"; exit 1)
	b2 file delete "b2://$$(grep -E '^B2_BUCKET' wrangler.toml | cut -d'"' -f2)/$(ID)"

# The B2 Terraform provider reads these straight from the environment, and make
# only forwards variables that were exported. Checking $$VAR rather than $(VAR)
# tests the real environment, which is what terraform ends up seeing.
check-b2-env:
	@if [ -z "$$B2_APPLICATION_KEY_ID" ]; then \
		echo "B2_APPLICATION_KEY_ID is not set in this shell."; \
		echo "  export B2_APPLICATION_KEY_ID='your-key-id'   # 'export' is required"; \
		exit 1; \
	fi
	@if [ -z "$$B2_APPLICATION_KEY" ]; then \
		echo "B2_APPLICATION_KEY is not set in this shell."; \
		echo "  export B2_APPLICATION_KEY='your-application-key'"; \
		exit 1; \
	fi

tf-init:
	cd terraform && terraform init

tf-plan: check-b2-env
	cd terraform && terraform plan

tf-apply: check-b2-env
	cd terraform && terraform apply

tf-destroy: check-b2-env
	cd terraform && terraform destroy
