.PHONY: setup doctor test dev-cli dev-web verify-ui smoke

setup:
	./scripts/bootstrap_local_dev.sh

doctor:
	./scripts/doctor.sh

test:
	./scripts/test_all.sh --quick

dev-cli:
	./scripts/dev_cli.sh

dev-web:
	./scripts/dev_web.sh

verify-ui:
	./scripts/verify_ui.sh

smoke:
	./scripts/smoke_tsf.sh
	cd neoresearch/packages/neoresearch && bun test test/research/e2e-autonomous-loop.test.ts --timeout 120000
