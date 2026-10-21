/**
 * CLI блока B: `argus list|gate|run --block B ...`.
 *
 *   argus list --block B
 *   argus gate --block B --family BC --sut-url URL
 *   argus gate --block B --family BS [--bind HOST:PORT]
 *   argus run --block B --family BC [--scenario S-BC-01] [--repeat N] --sut-url URL
 *   argus run --block B --family BS --scenario S-BS-01 [--observe-window-ms W] [--bind HOST:PORT]
 *
 * Exit-коды (совместимо с решением по CR-2):
 *   0 — нет FAIL; 1 — есть FAIL; 2 — HARNESS_ERROR/провал гейта/ошибка окружения.
 *
 * Env-фолбэки: ARGUS_B_SUT_URL, ARGUS_B_BIND, ARGUS_TEST_WALLET_PRIVATE_KEY.
 * Кто есть СУТ, объявляет оператор: BC требует URL ресурсного сервера СУТ,
 * BS — адрес, на котором Аргус поднимает плохой сервер и ждёт СУТ-клиента.
 */

import { privateKeyToAccount } from 'viem/accounts';
import {
  getBlockBScenario,
  listBlockBScenarios,
  validateBlockBRegistry,
  evaluateBcAttempt,
  evaluateBsSession,
} from '../blockb/BlockBRegistry';
import {
  rolesForFamily,
  parseScenarioId,
  type Family,
} from '../blockb/BlockBRoles';
import {
  validateRunConfig,
  type BlockBRunConfig,
} from '../blockb/BlockBScenario';
import type { BlockBScenarioSpec } from '../blockb/BlockBScenario';
import { PassthroughPaymentFaultInjector } from '../blockb/PaymentFaultInjector';
import { createBcRunner, type PaymentSigner } from '../blockb/runners/BcRunner';
import { BsRunner } from '../blockb/runners/BsRunner';
import { runBlockBGate } from '../blockb/runners/BlockBGate';
import {
  assertScenarioMatchesConfig,
  computeExitCode,
  worstVerdict,
  type BcAttemptObservation,
  type RunnerReport,
  type ScenarioRunResult,
} from '../blockb/runners/BlockBRunnerTypes';
import type { SigningBinding } from '../adapters/payment/SigningBinding';

interface BlockBFlags {
  action: 'list' | 'gate' | 'run';
  family?: Family;
  scenarioId?: string;
  repeat: number;
  observeWindowMs?: number;
  firstRequestTimeoutMs?: number;
  requestTimeoutMs?: number;
  sutUrl?: string;
  bind?: string;
  price?: string;
  json: boolean;
  skipGate: boolean;
}

const USAGE = [
  'Usage:',
  '  argus list --block B',
  '  argus gate --block B --family BC|BS [--sut-url URL | --bind HOST:PORT]',
  '  argus run  --block B --family BC [--scenario S-BC-NN] [--repeat N] --sut-url URL',
  '  argus run  --block B --family BS --scenario S-BS-NN [--observe-window-ms W] [--bind HOST:PORT]',
  'Flags: --json, --price ATOMIC_UNITS (BS), --skip-gate, --request-timeout-ms, --first-request-timeout-ms',
  'Env:   ARGUS_B_SUT_URL, ARGUS_B_BIND, ARGUS_TEST_WALLET_PRIVATE_KEY',
].join('\n');

export function parseBlockBArgs(argv: string[]): BlockBFlags {
  const action = argv[0];
  if (action !== 'list' && action !== 'gate' && action !== 'run') {
    throw new Error(`Unknown block B action '${action ?? ''}'\n${USAGE}`);
  }
  const flags: BlockBFlags = { action, repeat: 1, json: false, skipGate: false };
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    const next = (): string => {
      i += 1;
      if (i >= argv.length) throw new Error(`Flag ${flag} expects a value\n${USAGE}`);
      return argv[i];
    };
    switch (flag) {
      case '--block':
        if (next() !== 'B') throw new Error(`Only '--block B' is supported by this command\n${USAGE}`);
        break;
      case '--family':
        flags.family = next() as Family;
        break;
      case '--scenario':
        flags.scenarioId = next();
        break;
      case '--repeat':
        flags.repeat = Number.parseInt(next(), 10);
        break;
      case '--observe-window-ms':
        flags.observeWindowMs = Number.parseInt(next(), 10);
        break;
      case '--first-request-timeout-ms':
        flags.firstRequestTimeoutMs = Number.parseInt(next(), 10);
        break;
      case '--request-timeout-ms':
        flags.requestTimeoutMs = Number.parseInt(next(), 10);
        break;
      case '--sut-url':
        flags.sutUrl = next();
        break;
      case '--bind':
        flags.bind = next();
        break;
      case '--price':
        flags.price = next();
        break;
      case '--json':
        flags.json = true;
        break;
      case '--skip-gate':
        flags.skipGate = true;
        break;
      default:
        throw new Error(`Unknown flag '${flag}'\n${USAGE}`);
    }
  }
  return flags;
}

/** Подписант честного/плохого клиента на ключе оператора (viem). */
export function walletSigner(privateKey: `0x${string}`): PaymentSigner {
  return async (binding: SigningBinding): Promise<string> => {
    const account = privateKeyToAccount(privateKey);
    const chainIdMatch = /eip155:(\d+)/.exec(binding.network);
    const chainId = chainIdMatch ? Number(chainIdMatch[1]) : 84532;
    const signature = await account.signTypedData({
      domain: {
        name: 'USDC',
        version: '2',
        chainId,
        verifyingContract: binding.asset as `0x${string}`,
      },
      types: {
        TransferWithAuthorization: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' },
        ],
      },
      primaryType: 'TransferWithAuthorization',
      message: {
        from: account.address,
        to: binding.to as `0x${string}`,
        value: BigInt(binding.value),
        validAfter: BigInt(binding.validAfter),
        validBefore: BigInt(binding.validBefore),
        nonce: binding.nonce as `0x${string}`,
      },
    });
    const envelope = {
      x402Version: 2,
      accepted: {
        scheme: binding.scheme,
        network: binding.network,
        asset: binding.asset,
        amount: binding.value,
        payTo: binding.to,
        maxTimeoutSeconds: binding.maxTimeoutSeconds,
      },
      payload: {
        signature,
        authorization: {
          from: account.address,
          to: binding.to,
          value: binding.value,
          validAfter: binding.validAfter,
          validBefore: binding.validBefore,
          nonce: binding.nonce,
        },
      },
    };
    return Buffer.from(JSON.stringify(envelope), 'utf-8').toString('base64');
  };
}

function requireSutUrl(flags: BlockBFlags): string {
  const url = flags.sutUrl ?? process.env.ARGUS_B_SUT_URL;
  if (!url) {
    throw new Error('BC runs require --sut-url (or env ARGUS_B_SUT_URL): адрес ресурсного сервера СУТ\n' + USAGE);
  }
  return url;
}

function requireBind(flags: BlockBFlags): string {
  const bind = flags.bind ?? process.env.ARGUS_B_BIND;
  if (!bind) {
    throw new Error('BS runs require --bind HOST:PORT (or env ARGUS_B_BIND): адрес плохого сервера Аргуса\n' + USAGE);
  }
  return bind;
}

function buildRunConfig(flags: BlockBFlags): BlockBRunConfig {
  let config: BlockBRunConfig;
  if (flags.family === 'BC') {
    config = {
      family: 'BC',
      sutRole: 'server',
      resourceUrl: requireSutUrl(flags),
      label: 'block-b CLI',
    };
  } else if (flags.family === 'BS') {
    config = {
      family: 'BS',
      sutRole: 'client',
      argusServerUrl: requireBind(flags),
      label: 'block-b CLI',
    };
  } else {
    throw new Error('--family BC|BS обязателен: СУТ исполняет одну роль на прогон\n' + USAGE);
  }
  validateRunConfig(config);
  return config;
}

function selectScenarios(flags: BlockBFlags, config: BlockBRunConfig): readonly BlockBScenarioSpec[] {
  validateBlockBRegistry();
  if (flags.scenarioId) {
    const spec = getBlockBScenario(flags.scenarioId);
    if (!spec) {
      throw new Error(
        `Scenario '${flags.scenarioId}' not registered (wave 1 only; see docs/block-b/REGISTRY.md)`
      );
    }
    assertScenarioMatchesConfig(spec, config);
    return [spec];
  }
  const familyScenarios = listBlockBScenarios().filter((s) => s.family === config.family);
  if (config.family === 'BS') {
    throw new Error(
      'BS требует --scenario: каждая сессия BS — отдельный контакт СУТ с плохим сервером; ' +
      'запускайте сценарии по одному (волна 1: ' + familyScenarios.map((s) => s.id).join(', ') + ')'
    );
  }
  return familyScenarios;
}

function printReport(report: RunnerReport, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const roles = rolesForFamily(report.config.family);
  console.log(`\nBlock B report (${report.config.family}: СУТ=${roles.sut}, Аргус=${roles.argus})`);
  if (report.gate) {
    console.log(`  Gate: ${report.gate.passed ? 'PASS' : 'FAIL'} — ${report.gate.details ?? ''}`);
  }
  for (const scenario of report.scenarios) {
    console.log(`\n  ${scenario.scenarioId} ${scenario.slug}`);
    console.log(`    Verdict: ${scenario.verdict}`);
    for (const reason of scenario.reasons) {
      console.log(`      - ${reason}`);
    }
  }
  console.log(`\n  Exit: ${report.exitCode}`);
}

/** Точка входа `argus ... --block B`. Возвращает exit-код. */
export async function runBlockBCommand(argv: string[]): Promise<number> {
  let flags: BlockBFlags;
  try {
    flags = parseBlockBArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  try {
    if (flags.action === 'list') {
      validateBlockBRegistry();
      console.log('Block B scenarios (registered in code, wave 1):');
      for (const spec of listBlockBScenarios()) {
        console.log(
          `  ${spec.id}  ${spec.slug.padEnd(24)} family=${spec.family} phase=${spec.phase} wave=${spec.wave}  ${spec.title}`
        );
      }
      console.log('\nПолный реестр 28 сценариев: docs/block-b/REGISTRY.md');
      return 0;
    }

    const config = buildRunConfig(flags);

    if (flags.action === 'gate') {
      const gate = await runGateForConfig(config, flags);
      const report: RunnerReport = {
        config,
        gate,
        scenarios: [],
        exitCode: gate.passed ? 0 : 2,
        finishedAtMs: Date.now(),
      };
      printReport(report, flags.json);
      return report.exitCode;
    }

    // action === 'run'
    const scenarios = selectScenarios(flags, config);
    const gate = flags.skipGate ? undefined : await runGateForConfig(config, flags);
    if (gate && !gate.passed) {
      const report: RunnerReport = {
        config,
        gate,
        scenarios: [],
        exitCode: 2,
        finishedAtMs: Date.now(),
      };
      printReport(report, flags.json);
      return 2;
    }

    const results: ScenarioRunResult[] = [];
    if (config.family === 'BC') {
      const signer = resolveBcSigner();
      for (const spec of scenarios) {
        results.push(await runBcScenario(spec, config, signer, flags));
      }
    } else {
      for (const spec of scenarios) {
        results.push(await runBsScenario(spec, config, flags));
      }
    }

    const verdict = worstVerdict(results.map((r) => r.verdict));
    const report: RunnerReport = {
      config,
      gate,
      scenarios: results,
      exitCode: computeExitCode({ config, gate, scenarios: results, exitCode: 0, finishedAtMs: Date.now() }),
      finishedAtMs: Date.now(),
    };
    void verdict;
    printReport(report, flags.json);
    return report.exitCode;
  } catch (error) {
    console.error(`Block B error: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

function resolveBcSigner(): PaymentSigner {
  const pk = process.env.ARGUS_TEST_WALLET_PRIVATE_KEY as `0x${string}` | undefined;
  if (!pk) {
    throw new Error(
      'BC runs require ARGUS_TEST_WALLET_PRIVATE_KEY (одноразовый ключ плохого клиента)'
    );
  }
  return walletSigner(pk);
}

async function runGateForConfig(
  config: BlockBRunConfig,
  flags: BlockBFlags
): Promise<{ family: Family; passed: boolean; details?: string }> {
  return runBlockBGate({
    config,
    signer: config.family === 'BC' ? resolveBcSigner() : undefined,
    resourcePrice: flags.price,
    observeWindowMs: flags.observeWindowMs ?? (config.family === 'BS' ? 2000 : undefined),
    firstRequestTimeoutMs: flags.firstRequestTimeoutMs,
  });
}

async function runBcScenario(
  spec: BlockBScenarioSpec,
  config: BlockBRunConfig,
  signer: PaymentSigner,
  flags: BlockBFlags
): Promise<ScenarioRunResult> {
  const injector = spec.createInjector();
  const runner = createBcRunner({
    runConfig: { ...config, family: 'BC' } as BlockBRunConfig & { family: 'BC' },
    scenario: spec,
    signer,
    requestTimeoutMs: flags.requestTimeoutMs,
  });
  const startedAt = Date.now();
  const repeat = flags.repeat > 0 ? flags.repeat : (spec.suggestedRepeat ?? 1);
  const observations: BcAttemptObservation[] = [];
  for (let attempt = 1; attempt <= repeat; attempt++) {
    const attemptInjector = attempt === 1 ? injector : spec.createInjector();
    observations.push(await runner.runAttempt(attemptInjector, attempt));
  }
  const evaluations = observations.map((obs) => evaluateBcAttempt(spec, obs));
  return {
    scenarioId: spec.id,
    slug: spec.slug,
    family: spec.family,
    title: spec.title,
    verdict: worstVerdict(evaluations.map((e) => e.verdict)),
    reasons: evaluations.flatMap((e) => [`${e.verdict}:`, ...e.reasons]),
    startedAtMs: startedAt,
    finishedAtMs: Date.now(),
  };
}

async function runBsScenario(
  spec: BlockBScenarioSpec,
  config: BlockBRunConfig,
  flags: BlockBFlags
): Promise<ScenarioRunResult> {
  const startedAt = Date.now();
  const repeat = flags.repeat > 0 ? flags.repeat : (spec.suggestedRepeat ?? 1);
  const evaluations = [];
  for (let attempt = 1; attempt <= repeat; attempt++) {
    const runner = new BsRunner({
      runConfig: { ...config, family: 'BS' } as BlockBRunConfig & { family: 'BS' },
      scenario: spec,
      resourcePrice: flags.price,
      observeWindowMs: flags.observeWindowMs,
      firstRequestTimeoutMs: flags.firstRequestTimeoutMs,
    });
    const session = await runner.runSession();
    evaluations.push(evaluateBsSession(spec, session));
  }
  void PassthroughPaymentFaultInjector;
  return {
    scenarioId: spec.id,
    slug: spec.slug,
    family: spec.family,
    title: spec.title,
    verdict: worstVerdict(evaluations.map((e) => e.verdict)),
    reasons: evaluations.flatMap((e, i) => [`${e.verdict} (attempt ${i + 1}):`, ...e.reasons]),
    startedAtMs: startedAt,
    finishedAtMs: Date.now(),
  };
}

export { parseScenarioId };
