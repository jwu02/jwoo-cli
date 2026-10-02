import reactHooks from 'eslint-plugin-react-hooks';

export default [
	{
		/*
		The OpenCode Shim is outside the gate, like the Swift helper source and
		for the same reason: the gate cannot load it — OpenCode's plugin loader is
		what runs it — and its shape is that loader's rather than this repo's. What
		the gate exercises is everything behind it, which is the CLI command and
		the projection.
		*/
		ignores: ['opencode-plugin/**'],
	},
	{
		prettier: true,
	},
	{
		plugins: {
			'react-hooks': reactHooks,
		},
		rules: reactHooks.configs.recommended.rules,
	},
	{
		/*
		A test for the keyboard rules is mostly bit arithmetic and quoted Key
		Labels, and both of the rules relaxed here are about code that ships.

		`no-bitwise` guards against clever flag wrangling in production code;
		a fixture that composes `SHIFT | OPTION` is not that, it is the falsest
		possible way to write the same number.

		`naming-convention` wants camelCase, and a Key Label is a wire format
		whose whole point is that it is `A`, `Return` and `Left Cmd` verbatim
		(ADR-0004). A test asserting on `{a: 1}` would be asserting about a
		label nothing produces.

		Scoped to the test files that need it rather than to every `*.test.ts`,
		so a narrower disable elsewhere — `config.test.ts` has one for environment
		variable names — is not quietly made redundant by this.

		`key-labels.test.ts` is here for the bit arithmetic alone: it sweeps
		keycode against chord to enumerate the labels the Collector can produce,
		so it has to compose the chords itself rather than borrow the tables it is
		checking.
		*/
		files: [
			'source/capture/keyboard.test.ts',
			'source/capture/key-character.test.ts',
			'source/capture/key-labels.test.ts',
			'source/capture/mouse.test.ts',
		],
		rules: {
			'no-bitwise': 'off',
			'@typescript-eslint/naming-convention': 'off',
		},
	},
	{
		/*
		`naming-convention` wants camelCase, and this test writes two vocabularies
		that are not JavaScript's: Key Labels, which are a wire format whose whole
		point is that they are `A`, `Return` and `Left Cmd` verbatim (ADR-0004),
		and the Local Store's own column names, which are `left_clicks` and
		`pushed_at` in the schema the test asserts against.

		Its own entry rather than a fifth `files` line above, because only the
		naming rule is relaxed here: there is no bit arithmetic in this file, and
		adding it to that list would say there was.
		*/
		files: ['source/store/local-store.test.ts'],
		rules: {
			'@typescript-eslint/naming-convention': 'off',
		},
	},
	{
		/*
		The Push writes a Key Count Document whose fields are Key Labels
		themselves, so this test builds eras holding `A` and `Return` — the wire
		format the website reads, spelled the way it is on the wire (ADR-0004).
		*/
		files: ['source/store/push.test.ts'],
		rules: {
			'@typescript-eslint/naming-convention': 'off',
		},
	},
	{
		/*
		The transcript fixtures are Claude Code's own JSONL rows, so this test
		writes the Anthropic field names verbatim — `input_tokens`,
		`cache_read_input_tokens`, `tool_use_id` — because those are what the file
		on disk holds, and a camelCase fixture would test a transcript nothing
		produces.
		*/
		files: ['source/usage/usage-transcript.test.ts'],
		rules: {
			'@typescript-eslint/naming-convention': 'off',
		},
	},
];
