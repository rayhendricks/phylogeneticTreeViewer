#!/usr/bin/env node
import { main } from '../src/cli/cli.js';

main(process.argv.slice(2)).catch(e => { console.error('localtree: ' + e.message); process.exit(1); });
