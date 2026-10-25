/**
 * Block B — платёжные фолт-сценарии x402 (публичный слой).
 *
 * Контрактные типы и примитивы. Реализации сценариев v1-транша
 * добавляются в ветке block-b/v1-scenarios.
 */

export {
  rolesForFamily,
  parseScenarioId,
  scenarioId,
  validateScenarioId,
  type Family,
  type SutRole,
  type RoleAssignment,
  type ScenarioIdParts,
} from './BlockBRoles';

export {
  PassthroughPaymentFaultInjector,
  resolveDirective,
  passthrough,
  type PaymentFaultInjector,
  type FaultDirective,
  type HookCtx,
  type DirectiveResolution,
  type OutgoingPaymentRequest,
  type SettlementObservation,
  type SettlementPhase,
  type PaymentFact,
  type PaymentFactKind,
} from './PaymentFaultInjector';

export {
  validateScenarioSpec,
  validateRunConfig,
  BLOCK_B_FAMILY_ORDER,
  type BlockBScenarioSpec,
  type BlockBRunConfig,
  type BlockBVerdict,
  type BlockBGate,
  type BlockBGateResult,
} from './BlockBScenario';

export {
  AutoFundingProvider,
  ManualFundingProvider,
  ManualTopUpRequiredError,
  type FundingProvider,
  type FundingReport,
  type FundingSource,
  type FaucetClient,
  type FaucetDripResult,
  type BalanceSource,
  type Amount as FundingAmount,
} from './FundingProvider';

export {
  canonicalResourceBody,
  fingerprintRequest,
  type CanonicalResourceBody,
  type RequestFingerprint,
} from './CanonicalResource';

export { S_BC_01_BadSignature, corruptPaymentPayload } from './examples/S_BC_01_BadSignature';

export {
  BLOCK_B_WAVE1_SCENARIOS,
  BLOCK_B_WAVE25_SCENARIOS,
  listBlockBScenarios,
  getBlockBScenario,
  validateBlockBRegistry,
  evaluateBcAttempt,
  evaluateBsSession,
  decimalToAtomic,
  USDC_DECIMALS,
  type VerdictEvaluation,
} from './BlockBRegistry';

export type {
  BcSendRecord,
  BcAttemptObservation,
  BsReceivedPayment,
  BsSessionRecord,
  ScenarioRunResult,
  RunnerReport,
  SutTypedRejection,
  BindingRaceProbe,
  BindingRaceServed,
  BindingRaceControlOutcomes,
  NonAtomicAmountProbe,
  NonAtomicAmountServed,
  NonAtomicControlOutcomes,
} from './runners/BlockBRunnerTypes';
export { worstVerdict, computeExitCode, assertScenarioMatchesConfig } from './runners/BlockBRunnerTypes';

export { BcRunner, createBcRunner, parseRequirements, parsePaymentResponse, type PaymentSigner, type BcRunnerOptions } from './runners/BcRunner';
export {
  BsRunner,
  decodePayment,
  parallelAttempts,
  BINDING_RACE_PAYTO_A,
  BINDING_RACE_PAYTO_B,
  type BsRunnerOptions,
} from './runners/BsRunner';
export { runBlockBGate, type GateOptions } from './runners/BlockBGate';
