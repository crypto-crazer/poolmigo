#!/usr/bin/env node
/**
 * CLI entry point.
 *
 *   keeper tick     run exactly one tick and exit
 *   keeper run      run the interval loop until SIGINT/SIGTERM
 *   keeper status   print preflight + a read-only view of what a tick would do, then exit
 *
 * Flags: `--dry-run` / `--execute` override `DRY_RUN`; `--help`, `--version`.
 *
 * Exit codes (see README — these are what a supervisor should alert on):
 *   0  clean
 *   1  unexpected fatal error
 *   2  configuration error
 *   3  preflight failure (wrong chain, or this address is not an authorised keeper)
 */

import { createClients } from './chain.js';
import { ConfigError, describeConfig, loadConfig } from './config.js';
import { createLogger, serializeError } from './logger.js';
import {
  EXIT_CONFIG,
  EXIT_FATAL,
  EXIT_OK,
  EXIT_PREFLIGHT,
  PreflightError,
  preflight,
  runLoop,
  runTick,
  type TickDeps,
} from './keeper.js';
import { StateStore } from './state.js';

const USAGE = `poolmigo-keeper — keeper service for the Poolmigo vault

Usage:
  keeper tick    [--dry-run|--execute]   run one tick and exit
  keeper run     [--dry-run|--execute]   run the interval loop (SIGINT/SIGTERM to stop)
  keeper status                          preflight + config summary, no actions
  keeper --help | --version

Configuration is environment-only; see .env.example for every variable.
DRY_RUN defaults to true — pass --execute (or DRY_RUN=false) to send transactions.
`;

interface ParsedArgs {
  command: 'tick' | 'run' | 'status' | 'help' | 'version';
  dryRunOverride: boolean | undefined;
  error?: string;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let command: ParsedArgs['command'] | undefined;
  let dryRunOverride: boolean | undefined;

  for (const arg of argv) {
    switch (arg) {
      case '--help':
      case '-h':
        return { command: 'help', dryRunOverride: undefined };
      case '--version':
      case '-v':
        return { command: 'version', dryRunOverride: undefined };
      case '--dry-run':
        dryRunOverride = true;
        break;
      case '--execute':
      case '--no-dry-run':
        dryRunOverride = false;
        break;
      case 'tick':
      case 'run':
      case 'status':
        command = arg;
        break;
      default:
        return {
          command: 'help',
          dryRunOverride: undefined,
          error: `unknown argument "${arg}"`,
        };
    }
  }
  return { command: command ?? 'help', dryRunOverride };
}

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.command === 'help') {
    if (args.error !== undefined) {
      process.stderr.write(`${args.error}\n\n${USAGE}`);
      return EXIT_CONFIG;
    }
    process.stdout.write(USAGE);
    return EXIT_OK;
  }
  if (args.command === 'version') {
    process.stdout.write('poolmigo-keeper 0.1.0\n');
    return EXIT_OK;
  }

  let deps: TickDeps;
  try {
    const cfg = loadConfig();
    const logger = createLogger(cfg.logLevel);
    logger.info('starting', {
      command: args.command,
      // `config.dryRun` is what the env says; `effectiveDryRun` is what this invocation will do
      // after any --dry-run/--execute flag. An operator reads this line to confirm the mode.
      effectiveDryRun: args.dryRunOverride ?? cfg.dryRun,
      config: describeConfig(cfg),
    });
    const clients = createClients(cfg);
    const store = new StateStore(cfg.stateFile);
    deps = {
      cfg,
      clients,
      logger,
      store,
      ...(args.dryRunOverride !== undefined ? { dryRunOverride: args.dryRunOverride } : {}),
    };
  } catch (err) {
    // No logger yet in the worst case — write a structured line by hand.
    process.stderr.write(
      `${JSON.stringify({
        ts: new Date().toISOString(),
        level: 'error',
        msg: 'configuration error',
        svc: 'poolmigo-keeper',
        ...serializeError(err),
      })}\n`,
    );
    return err instanceof ConfigError ? EXIT_CONFIG : EXIT_FATAL;
  }

  const { logger } = deps;

  try {
    if (args.command === 'status') {
      await preflight(deps);
      // Read-only: simulate but never send, and never touch the durable state.
      const result = await runTick({ ...deps, dryRunOverride: true, persistState: false });
      logger.info('status', {
        block: result.blockNumber,
        paused: result.paused,
        plannedDeploys: result.decision.plans.length,
        rebalance: result.rebalance,
        state: deps.store.read().state,
      });
      return EXIT_OK;
    }

    if (args.command === 'tick') {
      await preflight(deps);
      const result = await runTick(deps);
      return result.ok ? EXIT_OK : EXIT_FATAL;
    }

    // `run`: loop until a signal arrives.
    const handle = runLoop(deps);
    const onSignal = (signal: NodeJS.Signals): void => handle.stop(signal);
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    await handle.done;
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    return EXIT_OK;
  } catch (err) {
    if (err instanceof PreflightError) {
      logger.error('preflight failed', serializeError(err));
      return EXIT_PREFLIGHT;
    }
    logger.error('fatal', serializeError(err));
    return EXIT_FATAL;
  }
}

// Only run when invoked as a program (not when imported by tests).
const invokedDirectly =
  process.argv[1] !== undefined && /cli\.(ts|js)$/.test(process.argv[1]);

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      process.stderr.write(`${JSON.stringify({ level: 'error', ...serializeError(err) })}\n`);
      process.exitCode = EXIT_FATAL;
    });
}

export { main };
