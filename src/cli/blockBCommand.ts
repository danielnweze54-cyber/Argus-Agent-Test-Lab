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
import { makeFacilitatorDrainProbe } from '../blockb/runners/FacilitatorDrainProbe';
import { BsRunner } from '../blockb/runners/BsRunner';
import { runBlockBGate } from '../blockb/runners/BlockBGate';
import {
  AutoFundingProvider,
  ManualFundingProvider,
  ManualTopUpRequiredError,
  type BalanceSource,
  type FaucetClient,
  type FundingProvider,
  type FundingReport,
} from '../blockb/FundingProvider';
import type { BcAttemptObservation, RunnerReport, RequirementFieldDelta, ScenarioRunResult } from '../blockb/runners/BlockBRunnerTypes';
import { assertScenarioMatchesConfig, computeExitCode, worstVerdict } from '../blockb/runners/BlockBRunnerTypes';
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
  /** S-BC-14: URL settle-эндпоинта фасилитатора СУТ (проба дрейна). */
  facilitatorSettleUrl?: string;
  /** Фондирование BC (решение В3): auto = faucet + ручной fallback; manual = без faucet. */
  funding?: 'auto' | 'manual';
  /** URL faucet-эндпоинта (POST {wallet, amount} → {ok, txHash}). */
  faucetUrl?: string;
  /** RPC-эндпоинт сети для проверки баланса USDC. */
  rpcUrl?: string;
  /** Минимальный баланс в atomic units (дефолт 100000 = 0.1 USDC). */
  fundingMinAtomic?: string;
  /** Пробы S-BS-06 (follow-up #3866): суммы requirements на каждый 402-контакт,
   *  через запятую ('10000,100000'; последний повторяется). BS-семейство. */
  requirementAmounts?: string;
  /** Пробы S-BS-06 binding-контроль (#3866): JSON-массив дельт полей
   *  '[{"contact":2,"payTo":"0x…"}]'. BS-семейство. */
  requirementDeltas?: string;
  /** Lost-response контроль: N-й платёж остаётся без ответа (сокет рвётся). */
  lostResponseAt?: number;
}

const USAGE = [
  'Usage:',
  '  argus list --block B',
  '  argus gate --block B --family BC|BS [--sut-url URL | --bind HOST:PORT]',
  '  argus run  --block B --family BC [--scenario S-BC-NN] [--repeat N] --sut-url URL',
  '  argus run  --block B --family BS --scenario S-BS-NN [--observe-window-ms W] [--bind HOST:PORT]',
  'Flags: --json, --price ATOMIC_UNITS (BS), --skip-gate, --request-timeout-ms, --first-request-timeout-ms',
  '       --facilitator-settle-url URL (S-BC-14 frontrun-drain: settle фасилитатора СУТ)',
  '       --funding auto|manual --faucet-url URL --rpc-url URL [--funding-min-atomic N] (BC, решение В3)',
  '       --requirement-amounts A1,A2 (BS S-BS-06 probes: sums per 402 contact; env ARGUS_B_REQUIREMENT_AMOUNTS)',
  '       --requirement-deltas JSON (BS S-BS-06 binding probes: [{"contact":2,"payTo|asset|network":value}]; env ARGUS_B_REQUIREMENT_DELTAS)',
  '       --lost-response-at N (BS lost-response control: Nth payment gets no response; env ARGUS_B_LOST_RESPONSE_AT)',
  'Env:   ARGUS_B_SUT_URL, ARGUS_B_BIND, ARGUS_TEST_WALLET_PRIVATE_KEY,',
  '       ARGUS_B_FACILITATOR_SETTLE_URL, ARGUS_B_FUNDING, ARGUS_B_FAUCET_URL, ARGUS_B_RPC_URL',
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
      case '--facilitator-settle-url':
        flags.facilitatorSettleUrl = next();
        break;
      case '--funding': {
        const mode = next();
        if (mode !== 'auto' && mode !== 'manual') {
          throw new Error(`--funding: ожидается auto|manual, получено '${mode}'\n${USAGE}`);
        }
        flags.funding = mode;
        break;
      }
      case '--faucet-url':
        flags.faucetUrl = next();
        break;
      case '--rpc-url':
        flags.rpcUrl = next();
        break;
      case '--funding-min-atomic':
        flags.fundingMinAtomic = next();
        break;
      case '--requirement-amounts':
        flags.requirementAmounts = next();
        break;
      case '--requirement-deltas':
        flags.requirementDeltas = next();
        break;
      case '--lost-response-at':
        flags.lostResponseAt = Number.parseInt(next(), 10);
        break;
      default:
        throw new Error(`Unknown flag '${flag}'\n${USAGE}`);
    }
  }
  return flags;
}

/**
 * Список сумм для проб S-BS-06 (follow-up #3866): '10000,100000' →
 * ['10000','100000'] (последний элемент повторяется на последующих 402).
 */
export function parseAmountsList(raw: string | undefined): readonly string[] | undefined {
  if (!raw) return undefined;
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) return undefined;
  for (const p of parts) {
    if (!/^\d+$/.test(p) || BigInt(p) <= 0n) {
      throw new Error(
        `--requirement-amounts: ожидались положительные atomic-суммы через запятую, получено '${raw}'`
      );
    }
  }
  return parts;
}

const HEX_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Binding-дельты для проб S-BS-06 (follow-up #3866): JSON-массив вида
 * '[{"contact":2,"payTo":"0x…"}]'. Валидация: contact — целое ≥ 1;
 * хотя бы одно поле из payTo/asset/network; payTo/asset — 0x-адрес (40 hex);
 * network — непустая строка. Неизвестные поля — ошибка.
 */
export function parseRequirementDeltas(
  raw: string | undefined
): readonly RequirementFieldDelta[] | undefined {
  if (!raw || raw.trim().length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`--requirement-deltas: ожидается JSON-массив, получено '${raw}'`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`--requirement-deltas: ожидается непустой JSON-массив дельт`);
  }
  return parsed.map((entry, i): RequirementFieldDelta => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`--requirement-deltas[${i}]: ожидается объект {contact, payTo?|asset?|network?}`);
    }
    const rec = entry as Record<string, unknown>;
    const known = Object.keys(rec).filter((k) => k !== 'contact' && k !== 'payTo' && k !== 'asset' && k !== 'network');
    if (known.length > 0) {
      throw new Error(`--requirement-deltas[${i}]: неизвестные поля: ${known.join(', ')}`);
    }
    const contact = rec['contact'];
    if (typeof contact !== 'number' || !Number.isInteger(contact) || contact < 1) {
      throw new Error(`--requirement-deltas[${i}]: 'contact' — целое ≥ 1, получено '${String(contact)}'`);
    }
    const payTo = rec['payTo'];
    const asset = rec['asset'];
    const network = rec['network'];
    if (payTo === undefined && asset === undefined && network === undefined) {
      throw new Error(`--requirement-deltas[${i}]: нужен хотя бы один из payTo/asset/network`);
    }
    for (const [field, value] of [['payTo', payTo], ['asset', asset]] as const) {
      if (value !== undefined && (typeof value !== 'string' || !HEX_ADDRESS_RE.test(value))) {
        throw new Error(`--requirement-deltas[${i}]: '${field}' — 0x-адрес (40 hex), получено '${String(value)}'`);
      }
    }
    if (network !== undefined && (typeof network !== 'string' || network.trim().length === 0)) {
      throw new Error(`--requirement-deltas[${i}]: 'network' — непустая строка`);
    }
    return {
      contact,
      ...(payTo !== undefined ? { payTo: payTo as string } : {}),
      ...(asset !== undefined ? { asset: asset as string } : {}),
      ...(network !== undefined ? { network: network as string } : {}),
    };
  });
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
  const raw = flags.bind ?? process.env.ARGUS_B_BIND;
  if (!raw) {
    throw new Error('BS runs require --bind HOST:PORT (or env ARGUS_B_BIND): адрес плохого сервера Аргуса\n' + USAGE);
  }
  // Usage заявляет HOST:PORT; BsRunner парсит значение через new URL(),
  // поэтому без схемы добавляем http:// (иначе '0.0.0.0:4401' → Invalid URL).
  const bind = raw.includes('://') ? raw : `http://${raw}`;
  try {
    const parsed = new URL(bind);
    if (parsed.protocol !== 'http:') {
      throw new Error('unsupported protocol');
    }
  } catch {
    throw new Error(`Invalid --bind value '${raw}': ожидается HOST:PORT\n` + USAGE);
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
        `Scenario '${flags.scenarioId}' not registered (полный реестр 28 — docs/block-b/REGISTRY.md)`
      );
    }
    assertScenarioMatchesConfig(spec, config);
    return [spec];
  }
  const familyScenarios = listBlockBScenarios().filter((s) => s.family === config.family);
  if (config.family === 'BS') {
    throw new Error(
      'BS требует --scenario: каждая сессия BS — отдельный контакт СУТ с плохим сервером; ' +
      'запускайте сценарии по одному (всего BS: ' + familyScenarios.map((s) => s.id).join(', ') + ')'
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
      const all = listBlockBScenarios();
      console.log(`Block B scenarios (registered in code: ${all.length} = волна 1 × 10 + волна 2 × 18):`);
      for (const spec of all) {
        console.log(
          `  ${spec.id}  ${spec.slug.padEnd(26)} family=${spec.family} phase=${spec.phase} wave=${spec.wave}  ${spec.title}`
        );
      }
      console.log('\nПолный реестр с якорями: docs/block-b/REGISTRY.md');
      return 0;
    }

    const config = buildRunConfig(flags);

    // Фондирование BC (решение В3): до гейта и сценариев; ManualTopUpRequiredError
    // уходит во внешний catch → exit 2 с точной инструкцией (адрес + недостаёт).
    if (config.family === 'BC' && flags.funding) {
      printFunding(await ensureBcFunded(flags), flags.json);
    }

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
  return walletSigner(resolveBcPrivateKey());
}

function resolveBcPrivateKey(): `0x${string}` {
  const pk = process.env.ARGUS_TEST_WALLET_PRIVATE_KEY as `0x${string}` | undefined;
  if (!pk) {
    throw new Error(
      'BC runs require ARGUS_TEST_WALLET_PRIVATE_KEY (одноразовый ключ плохого клиента)'
    );
  }
  return pk;
}

const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

/**
 * Фондирование BC-кошелька (решение В3): проверка баланса USDC по RPC;
 * auto — faucet (POST {wallet, amount} → {ok, txHash}) с ручным fallback;
 * manual — только проверка и точная инструкция. Бросает ManualTopUpRequiredError
 * (перехватывается внешним catch → exit 2 с инструкцией).
 */
async function ensureBcFunded(flags: BlockBFlags): Promise<FundingReport> {
  const wallet = privateKeyToAccount(resolveBcPrivateKey()).address;
  const required = BigInt(flags.fundingMinAtomic ?? '100000');
  const rpcUrl = flags.rpcUrl ?? process.env.ARGUS_B_RPC_URL;
  if (!rpcUrl) {
    throw new Error('--funding требует --rpc-url (env ARGUS_B_RPC_URL) для проверки баланса USDC\n' + USAGE);
  }
  const balanceSource: BalanceSource = {
    async getBalance(address) {
      const data = '0x70a08231' + address.replace(/^0x/, '').toLowerCase().padStart(64, '0');
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_call',
          params: [{ to: USDC_BASE_SEPOLIA, data }, 'latest'],
        }),
      });
      const json = (await res.json()) as { result?: string; error?: { message?: string } };
      if (!json.result) {
        throw new Error(`eth_call balanceOf failed: ${json.error?.message ?? `HTTP ${res.status}`}`);
      }
      return BigInt(json.result);
    },
  };

  let provider: FundingProvider;
  if (flags.funding === 'auto') {
    const faucetUrl = flags.faucetUrl ?? process.env.ARGUS_B_FAUCET_URL;
    if (!faucetUrl) {
      throw new Error('--funding auto требует --faucet-url (env ARGUS_B_FAUCET_URL)\n' + USAGE);
    }
    const faucet: FaucetClient = {
      name: new URL(faucetUrl).host,
      async drip(address, amount) {
        const res = await fetch(faucetUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ wallet: address, amount: amount.toString() }),
        });
        const json = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          success?: boolean;
          txHash?: string;
          transaction?: string;
          error?: string;
        };
        const ok = json.ok === true || json.success === true || !!json.txHash || !!json.transaction;
        return {
          ok,
          txHash: json.txHash ?? json.transaction,
          error: ok ? undefined : json.error ?? `HTTP ${res.status}`,
        };
      },
    };
    provider = new AutoFundingProvider(balanceSource, faucet);
  } else {
    provider = new ManualFundingProvider(balanceSource);
  }
  return provider.ensureFunded(wallet, required);
}

function printFunding(report: FundingReport, json: boolean): void {
  if (json) {
    console.error(JSON.stringify({ funding: report }, null, 2));
    return;
  }
  console.log(
    `  Funding: ${report.source} — баланс ${report.balanceBefore} → ${report.balanceAfter ?? 'n/a'} ` +
      `(требуется ${report.required})${report.message ? ` [${report.message}]` : ''}`
  );
}

/**
 * Проба дрейна (S-BC-14) перенесена в src/blockb/runners/FacilitatorDrainProbe.ts:
 * paymentRequirements = ОДИН объект (accepts[0] из 402), paymentPayload —
 * раскодированный объект. См. комментарий модуля.
 */

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
  const settleUrl = flags.facilitatorSettleUrl ?? process.env.ARGUS_B_FACILITATOR_SETTLE_URL;
  const injector = spec.createInjector();
  const runner = createBcRunner({
    runConfig: { ...config, family: 'BC' } as BlockBRunConfig & { family: 'BC' },
    scenario: spec,
    signer,
    requestTimeoutMs: flags.requestTimeoutMs,
    drainProbe: settleUrl ? makeFacilitatorDrainProbe(settleUrl) : undefined,
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
      oversizeSequence: parseAmountsList(
        flags.requirementAmounts ?? process.env.ARGUS_B_REQUIREMENT_AMOUNTS
      ),
      oversizeFieldDeltas: parseRequirementDeltas(
        flags.requirementDeltas ?? process.env.ARGUS_B_REQUIREMENT_DELTAS
      ),
      lostResponseAt:
        flags.lostResponseAt ??
        (process.env.ARGUS_B_LOST_RESPONSE_AT
          ? Number.parseInt(process.env.ARGUS_B_LOST_RESPONSE_AT, 10)
          : undefined),
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
