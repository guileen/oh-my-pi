.PHONY: test

test:
ifeq ($(strip $(TEST_ARGS)),)
	@bun run test
else
	@bun test $(TEST_ARGS)
endif
