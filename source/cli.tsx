#!/usr/bin/env node
import {render} from 'ink';
import App from './app.js';

// Argument parsing arrives with the CLI structure (#8). Until then the entry
// point is just the TUI:
//
//   Usage
//     $ jwoo-cli
render(<App />);
