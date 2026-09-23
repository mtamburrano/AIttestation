import { preflightAgent } from './agent.mjs';

const [namespace, build, optIn, scope] = process.argv.slice(2);
const report = await preflightAgent(namespace, build, optIn, scope === 'live-provider-send');
process.stdout.write(`${JSON.stringify(report)}\n`);
process.exitCode = report.status === 'READY' ? 0 : 2;
