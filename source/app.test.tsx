import test from 'ava';
import {render} from 'ink-testing-library';
import App from './app.js';

test('renders', t => {
	const {lastFrame} = render(<App />);

	t.is(lastFrame(), 'jwoo-cli');
});
