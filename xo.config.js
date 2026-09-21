import reactHooks from 'eslint-plugin-react-hooks';

export default [
	{
		prettier: true,
	},
	{
		plugins: {
			'react-hooks': reactHooks,
		},
		rules: reactHooks.configs.recommended.rules,
	},
];
