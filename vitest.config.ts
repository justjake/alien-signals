import { defineConfig } from 'vitest/config';

// --expose-gc so the reclamation tests can force collection deterministically
// (vitest 4: worker exec args are a top-level test option).
export default defineConfig({
	test: {
		execArgv: ['--expose-gc'],
	},
});
